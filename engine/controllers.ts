/**
 * Controllers: one per running command. Each step, a controller says what its
 * bot wants (an Intent), the physics makes it happen as far as the world
 * allows, and then the controller checks the outcome: done, still going, or
 * failed, with the exact reason.
 *
 * Commands work like a careful player's hands. Walks start from a standstill
 * and stop EXACTLY on target (the last step is shortened to fit), because
 * the spec wants "physics difficulty from coordination, not arithmetic".
 * Jumps keep their run-up speed, because momentum is what makes run-ups
 * matter.
 *
 * Reasons never reveal hidden stats. "Crate C1 didn't move (it weighs 1.40)"
 * is a fact about the world; the bot has to work out for itself that it
 * isn't strong enough on its own.
 */
import { BLOCKED_STEPS, MILLI, PHYS, UNITS_PER_TILE as T } from './constants';
import type { Command } from './commands';
import { coinBox, doorBox, exitBox, isFree, leverReachBox, overlaps, plateSpan, surfaceIntervals, sweepX } from './collision';
import { TILE, tileAt } from './level';
import type { Intent, PushOutcome, StepReport } from './physics';
import { jumpVelocityFor } from './stats';
import type { Bot, World, WorldEvent } from './world';
import { botById, describeContact, footingText, tiles, weightText, where } from './world';

/** How high a boost throws the bot on your head, for a bot of standard strength. */
const BOOST_TILES = 3;

/** Is `other` right beside `bot`: at the same height, with at most half a tile between them? */
function beside(bot: Bot, other: Bot): boolean {
  const sameHeight = other.y < bot.y + bot.h && bot.y < other.y + other.h;
  const gap = Math.max(other.x - (bot.x + bot.w), bot.x - (other.x + other.w));
  return sameHeight && gap <= T / 2;
}

const coinsText = (n: number) => `${n} coin${n === 1 ? '' : 's'}`;

/** trip, steal, give and boost: one bot acting on another (spec 7.4). Settled the moment it starts. */
function socialController(world: World, bot: Bot, command: Extract<Command, { kind: 'trip' | 'steal' | 'give' | 'boost' }>): Controller {
  const id = bot.id;
  const no = (reason: string) => new Instant(id, command, 'failed', reason, null);
  const other = world.bots.find((b) => b.id === command.target);
  if (other === bot) return no(`you can't ${command.kind} yourself`);
  if (!other || other.exited) return no(`there's no bot ${command.target} in the room`);
  const event = (action: 'trip' | 'steal' | 'give' | 'boost', coins: number): WorldEvent => ({ step: 0, type: 'social', action, by: id, target: other.id, coins });
  let done: Instant;
  switch (command.kind) {
    case 'boost': {
      if (!(other.grounded && other.support?.kind === 'bot' && other.support.id === id)) return no(`${other.id} is not standing on your head`);
      // A stronger bot throws higher (strength is hidden, so the result says where it went, not why).
      other.vy = jumpVelocityFor(Math.round((BOOST_TILES * T * bot.phys.strength) / MILLI), PHYS.gravity);
      other.grounded = false;
      other.support = null;
      other.airSteps = PHYS.coyoteSteps + 1;
      done = new Instant(id, command, 'done', null, `launched ${other.id} upward`);
      done.events.push(event('boost', 0));
      return done;
    }
    case 'trip':
      if (!beside(bot, other)) return no(`${other.id} is not right beside you`);
      if (bot.purse < 1) return no('tripping costs 1 coin, and you have none');
      bot.purse -= 1;
      other.tripped = true;
      done = new Instant(id, command, 'done', null, `tripped ${other.id}, which loses its next slot; it cost you 1 coin`);
      done.events.push(event('trip', 1));
      return done;
    case 'steal':
      if (!beside(bot, other)) return no(`${other.id} is not right beside you`);
      if (other.purse < 1) return no(`${other.id} has no coins`);
      other.purse -= 1;
      bot.purse += 1;
      done = new Instant(id, command, 'done', null, `took 1 coin from ${other.id}`);
      done.events.push(event('steal', 1));
      return done;
    case 'give':
      if (!beside(bot, other)) return no(`${other.id} is not right beside you`);
      if (bot.purse < command.coins) return no(`you have only ${coinsText(bot.purse)}`);
      bot.purse -= command.coins;
      other.purse += command.coins;
      done = new Instant(id, command, 'done', null, `gave ${other.id} ${coinsText(command.coins)}`);
      done.events.push(event('give', command.coins));
      return done;
  }
}

export type ControllerStatus = 'running' | 'holding' | 'done' | 'failed';

export interface Controller {
  readonly botId: string;
  readonly command: Command;
  /** running: still going. holding: finished, but keeps standing or holding (doesn't hold up the slot). */
  status: ControllerStatus;
  reason: string | null;
  note: string | null;
  /** Things that happened the moment the command started (a trip, a gift), for the event log. Their step is filled in by resolve. */
  readonly events: WorldEvent[];
  intent(world: World): Intent;
  after(world: World, report: StepReport): void;
}

abstract class Base implements Controller {
  status: ControllerStatus = 'running';
  reason: string | null = null;
  note: string | null = null;
  readonly events: WorldEvent[] = [];

  constructor(
    readonly botId: string,
    readonly command: Command,
  ) {}

  protected bot(world: World): Bot {
    return botById(world, this.botId);
  }

  protected fail(reason: string): this {
    this.status = 'failed';
    this.reason = reason;
    return this;
  }

  protected finish(note?: string, status: 'done' | 'holding' = 'done'): this {
    this.status = status;
    if (note) this.note = note;
    return this;
  }

  intent(_world: World): Intent {
    return {};
  }

  after(_world: World, _report: StepReport): void {}
}

/** A command that is settled the moment it starts: wait, a lever pull, going through the exit, or an impossible one. */
class Instant extends Base {
  constructor(botId: string, command: Command, status: ControllerStatus, reason: string | null, note: string | null) {
    super(botId, command);
    this.status = status;
    this.reason = reason;
    this.note = note;
  }
}

interface Gait {
  speed: number;
  /** null: move at full speed at once (creeping and pushing are slow anyway). */
  accel: number | null;
  look: 'walk' | 'creep' | 'push';
  push: boolean;
}

/** Walks, creeps and pushes: move along the floor to an exact x. */
class Mover extends Base {
  private readonly dir: 1 | -1;
  private lastX: number;
  private stuck = 0;
  private fell = false;
  private lastPush: PushOutcome | null = null;
  private pushedTotal = 0;

  constructor(
    world: World,
    bot: Bot,
    command: Command,
    private readonly target: number,
    private readonly gait: Gait,
    private readonly arrival: { status: 'done' | 'holding'; note: string | null } = { status: 'done', note: null },
  ) {
    super(bot.id, command);
    this.dir = target >= bot.x ? 1 : -1;
    this.lastX = bot.x;
    if (bot.onLadder) this.fail('you are on a ladder: climb up or down first');
    else if (!bot.grounded) this.fail('you are in the air');
    else if (target === bot.x) this.arrive(world, 'already there');
  }

  private arrive(world: World, extra?: string): void {
    const bot = this.bot(world);
    const parts = [this.arrival.note, extra, this.pushedTotal ? `pushed ${this.lastPush?.crate} ${tiles(Math.abs(this.pushedTotal))} tiles` : null];
    this.finish([`stopped at ${where(bot)}`, ...parts].filter(Boolean).join('; '), this.arrival.status);
  }

  override intent(world: World): Intent {
    const bot = this.bot(world);
    if (this.fell) return {}; // walked off an edge: no steering, momentum carries the bot
    const remaining = (this.target - bot.x) * this.dir;
    if (remaining <= 0) return { vx: 0 };
    const cap = this.gait.accel === null ? this.gait.speed : Math.min(this.gait.speed, Math.abs(bot.vx) + this.gait.accel);
    return {
      vx: this.dir * Math.min(cap, remaining),
      gait: this.gait.look,
      ...(this.gait.push ? { push: this.dir } : {}),
    };
  }

  override after(world: World, report: StepReport): void {
    const bot = this.bot(world);
    const push = report.pushes.get(bot.id);
    if (push) {
      this.lastPush = push;
      this.pushedTotal += push.moved;
    }
    if (this.fell) {
      if (bot.grounded || bot.onLadder) this.finish(`${this.note} and landed on ${footingText(bot)} at ${where(bot)}`);
      return;
    }
    if (!bot.grounded) {
      this.fell = true;
      this.note = `walked off the edge at ${where(bot)}, fell`;
      return;
    }
    if (bot.x === this.target) {
      this.arrive(world);
      return;
    }
    if (bot.x !== this.lastX) {
      this.lastX = bot.x;
      this.stuck = 0;
      return;
    }
    if (++this.stuck >= BLOCKED_STEPS) this.fail(this.blockedReason(bot, report));
  }

  private blockedReason(bot: Bot, report: StepReport): string {
    const p = this.lastPush;
    if (p && p.moved === 0) {
      return p.strongEnough
        ? `crate ${p.crate} is stuck: something on its far side is in the way (you stopped at ${where(bot)})`
        : `crate ${p.crate} didn't move: it weighs ${weightText(p.weight)} (you stopped at ${where(bot)})`;
    }
    const contact = report.stoppedX.get(bot.id);
    return `blocked by ${contact ? describeContact(contact) : 'something'} at ${where(bot)}`;
  }
}

/** jump(dir, run_up, hold): run, jump, steer in the air, land. */
class Jumper extends Base {
  private phase: 'runup' | 'takeoff' | 'air';
  private readonly dir: -1 | 0 | 1;
  private readonly x0: number;
  private lastX: number;
  private stuck = 0;
  private from = '';
  private peak = 0;

  constructor(world: World, bot: Bot, command: Extract<Command, { kind: 'jump' }>) {
    super(bot.id, command);
    this.dir = command.dir === 'up' ? 0 : command.dir === 'right' ? 1 : -1;
    this.x0 = bot.x;
    this.lastX = bot.x;
    this.phase = command.runUp > 0 ? 'runup' : 'takeoff';
    if (bot.onLadder) this.fail('you are on a ladder: climb up or down first');
    else if (!bot.grounded) this.fail('you are in the air');
    void world;
  }

  override intent(world: World): Intent {
    const bot = this.bot(world);
    const p = bot.phys;
    const cmd = this.command as Extract<Command, { kind: 'jump' }>;
    const airTarget = this.dir * p.maxAirSpeed;
    if (this.phase === 'runup') {
      const covered = (bot.x - this.x0) * this.dir;
      // Run until the run-up is done, or jump at the edge if the floor runs out first.
      if (!bot.grounded || covered >= cmd.runUp * T) this.phase = 'takeoff';
      else return { vx: this.dir * Math.min(p.runSpeed, Math.abs(bot.vx) + p.groundAccel), gait: 'walk' };
    }
    if (this.phase === 'takeoff') {
      this.from = where(bot); // where the feet leave the ground, before the jump moves them
      return { jump: cmd.hold, vx: bot.vx, airTarget };
    }
    return { airTarget };
  }

  override after(world: World, report: StepReport): void {
    const bot = this.bot(world);
    if (this.phase === 'runup') {
      if (bot.x !== this.lastX) {
        this.lastX = bot.x;
        this.stuck = 0;
      } else if (++this.stuck >= BLOCKED_STEPS) {
        const contact = report.stoppedX.get(bot.id);
        this.fail(`blocked during the run-up by ${contact ? describeContact(contact) : 'something'} at ${where(bot)}`);
      }
      return;
    }
    if (this.phase === 'takeoff') {
      if (!report.jumped.has(bot.id)) {
        this.fail('too late to jump: you had already been falling for a moment');
        return;
      }
      this.phase = 'air';
      this.peak = bot.y;
      return;
    }
    this.peak = Math.max(this.peak, bot.y);
    if (bot.grounded || bot.onLadder) {
      this.finish(`took off at ${this.from}, feet rose to y=${tiles(this.peak)}, landed on ${footingText(bot)} at ${where(bot)}`);
    }
  }
}

/** climb(up|down): ride the ladder to its top or bottom. */
class Climber extends Base {
  private readonly up: boolean;
  private topY = 0;
  private bottomY = 0;
  private stuck = 0;

  constructor(world: World, bot: Bot, command: Extract<Command, { kind: 'climb' }>) {
    super(bot.id, command);
    this.up = command.dir === 'up';
    const level = world.level;
    const col = Math.floor((bot.x + bot.w / 2) / T);
    const isLadder = (row: number) => tileAt(level, col, row) === TILE.LADDER;
    const bodyRows: number[] = [];
    for (let r = Math.floor(bot.y / T); r <= Math.floor((bot.y + bot.h - 1) / T); r++) bodyRows.push(r);
    // Going down, a bot standing on the ladder's top tile counts as at the ladder.
    const startRow = bodyRows.find(isLadder) ?? (!this.up && isLadder(Math.floor(bot.y / T) - 1) ? Math.floor(bot.y / T) - 1 : null);
    if (startRow === null) {
      this.fail('there is no ladder here');
      return;
    }
    let top = startRow;
    while (isLadder(top + 1)) top++;
    let bottom = startRow;
    while (isLadder(bottom - 1)) bottom--;
    this.topY = (top + 1) * T;
    this.bottomY = bottom * T;
    if (this.up && bot.y >= this.topY) {
      this.fail('you are already at the top of this ladder');
      return;
    }
    const snapped = { x: col * T + (T - bot.w) / 2, y: bot.y, w: bot.w, h: bot.h };
    if (!isFree(world, snapped, bot)) {
      this.fail('something is in the way of the ladder');
      return;
    }
    bot.x = snapped.x;
    bot.vx = 0;
    bot.vy = 0;
    bot.onLadder = true;
    bot.grounded = false;
  }

  override intent(world: World): Intent {
    const bot = this.bot(world);
    const speed = bot.phys.climbSpeed;
    if (this.up) return { climbVy: Math.min(speed, this.topY - bot.y) };
    return { climbVy: -Math.max(1, Math.min(speed, bot.y - this.bottomY)) };
  }

  override after(world: World, report: StepReport): void {
    const bot = this.bot(world);
    if (!bot.onLadder) {
      if (bot.grounded) this.finish(`climbed off the bottom of the ladder and landed on ${footingText(bot)} at ${where(bot)}`);
      return;
    }
    if (this.up && bot.y >= this.topY) {
      bot.onLadder = false;
      bot.vy = 0;
      bot.grounded = true;
      bot.support = { kind: 'tile', tile: 'ladder-top' };
      this.finish(`climbed to the top of the ladder, ${where(bot)}`);
      return;
    }
    const stopped = report.stoppedY.get(bot.id);
    if (!this.up && (stopped || bot.y <= this.bottomY)) {
      bot.onLadder = false; // reached the floor, or the ladder ends and the bot falls the rest
      bot.vy = 0;
      if (stopped) this.finish(`climbed down to ${where(bot)}`);
      return;
    }
    if (stopped && ++this.stuck >= BLOCKED_STEPS) this.fail(`blocked by ${describeContact(stopped)} while climbing, at ${where(bot)}`);
  }
}

/** drop: fall through the one-way platform underfoot. */
class Dropper extends Base {
  private started = false;
  private readonly y0: number;

  constructor(bot: Bot, command: Command) {
    super(bot.id, command);
    this.y0 = bot.y;
    const s = bot.support;
    if (!bot.grounded || s?.kind !== 'tile' || s.tile === 'solid') {
      this.fail("there's nothing to drop through here: drop works on one-way platforms and ladder tops");
    }
  }

  override intent(): Intent {
    if (this.started) return {};
    this.started = true;
    return { drop: true };
  }

  override after(world: World): void {
    const bot = this.bot(world);
    if (bot.grounded && bot.y < this.y0) this.finish(`dropped and landed on ${footingText(bot)} at ${where(bot)}`);
  }
}

/** Where `bot` should stop to be "at" an entity: beside solid things, centred on everything else. */
function approachPoint(world: World, bot: Bot, id: string): { x: number } | { error: string } {
  const besideOrOn = (box: { x: number; w: number }, solid: boolean) => {
    if (!solid) return { x: box.x + box.w / 2 - bot.w / 2 };
    return box.x + box.w / 2 > bot.x + bot.w / 2 ? { x: box.x - bot.w } : { x: box.x + box.w };
  };
  const other = world.bots.find((b) => b.id === id && !b.exited);
  if (other) return other === bot ? { error: "walk_to can't take you to yourself" } : besideOrOn(other, true);
  const crate = world.crates.find((c) => c.id === id);
  if (crate) return besideOrOn(crate, true);
  const { level } = world;
  const door = level.doors.find((d) => d.id === id);
  if (door) return besideOrOn(doorBox(door), !world.doors[door.id]);
  const plate = level.plates.find((p) => p.id === id);
  if (plate) {
    const s = plateSpan(plate);
    return besideOrOn({ x: s.x0, w: s.x1 - s.x0 }, false);
  }
  const lever = level.levers.find((l) => l.id === id);
  if (lever) return besideOrOn({ x: lever.tx * T, w: T }, false);
  const exit = level.exits.find((e) => e.id === id);
  if (exit) return besideOrOn(exitBox(exit), false);
  const coin = level.coins.find((c) => c.id === id && world.coins.includes(c.id));
  if (coin) return besideOrOn(coinBox(coin), false);
  return { error: `there's nothing called "${id}" here` };
}

/** Exits closer than this are named in the failure reason: well inside anyone's sight. */
const EXIT_HINT_RANGE = 3 * T;

/**
 * Why enter_exit failed. If an exit is close by (within 3 tiles, at about the
 * same height), the reason says where it is: a fact of the room, in plain
 * sight, said plainly. In the M5 pilot a bot standing 1.6 tiles past the exit
 * was told only "you're not at an exit", eight rounds running. Farther exits
 * aren't mentioned: finding them is the bots' job, and sight is part of it.
 */
function notAtExit(world: World, bot: Bot, target: string | null): string {
  const near = world.level.exits
    .filter((e) => target === null || e.id === target)
    .map((e) => {
      const box = exitBox(e);
      const right = bot.x + bot.w <= box.x;
      const left = bot.x >= box.x + box.w;
      return { e, box, gap: right ? box.x - (bot.x + bot.w) : left ? bot.x - (box.x + box.w) : 0, side: right ? 'to your right' : left ? 'to your left' : 'at another height' };
    })
    .filter((x) => x.gap <= EXIT_HINT_RANGE && Math.abs(bot.y - x.box.y) <= 2 * T)
    .sort((a, b) => a.gap - b.gap)[0];
  if (!near) return "you're not at an exit";
  const where = near.gap > 0 ? `${tiles(near.gap)} tiles ${near.side}` : near.side;
  return `you're not at an exit: exit ${near.e.id} is at x=${tiles(near.box.x)} to ${tiles(near.box.x + near.box.w)}, ${where}`;
}

/** Where `bot` stops if it walks toward the edge of the surface it stands on (toes at the edge), or at a wall first. */
function edgeStop(world: World, bot: Bot, dir: 1 | -1): { x: number; edge: boolean } {
  const stretches = surfaceIntervals(world, bot.y, bot).filter(([a, b]) => a < bot.x + bot.w && b > bot.x);
  if (stretches.length === 0) return { x: bot.x, edge: true };
  const edgeX =
    dir === 1 ? Math.max(...stretches.map(([, b]) => b)) - bot.w : Math.min(...stretches.map(([a]) => a));
  if ((edgeX - bot.x) * dir <= 0) return { x: bot.x, edge: true }; // already at (or over) the edge
  const free = sweepX(world, bot, edgeX - bot.x).moved;
  return free === edgeX - bot.x ? { x: edgeX, edge: true } : { x: bot.x + free, edge: false };
}

/** Start the controller for a command. It may fail at once, with a reason, if the command is impossible here. */
export function startController(world: World, bot: Bot, command: Command): Controller {
  // Doing anything but waiting (or standing your ground) lets go of a held lever.
  if (bot.holding && command.kind !== 'wait' && command.kind !== 'block' && command.kind !== 'hold_lever') bot.holding = null;
  const p = bot.phys;
  const walk: Gait = { speed: p.runSpeed, accel: p.groundAccel, look: 'walk', push: false };
  const id = bot.id;

  switch (command.kind) {
    case 'walk':
      return new Mover(world, bot, command, bot.x + (command.dir === 'right' ? 1 : -1) * command.tiles * T, walk);
    case 'creep': {
      const dir = command.dir === 'right' ? 1 : -1;
      const wanted = bot.x + dir * command.tiles * T;
      const edge = edgeStop(world, bot, dir);
      const stopsEarly = (wanted - edge.x) * dir > 0;
      return new Mover(world, bot, command, stopsEarly ? edge.x : wanted, { speed: p.creepSpeed, accel: null, look: 'creep', push: false }, {
        status: 'done',
        note: stopsEarly ? (edge.edge ? 'stopped at the edge' : 'stopped at a wall') : null,
      });
    }
    case 'walk_to_edge': {
      const stop = edgeStop(world, bot, command.dir === 'right' ? 1 : -1);
      return new Mover(world, bot, command, stop.x, walk, {
        status: 'done',
        note: stop.edge ? 'toes at the edge' : 'no edge before the wall',
      });
    }
    case 'walk_to': {
      const point = approachPoint(world, bot, command.target);
      if ('error' in point) return new Instant(id, command, 'failed', point.error, null);
      return new Mover(world, bot, command, Math.round(point.x), walk, { status: 'done', note: `at ${command.target}` });
    }
    case 'push':
      return new Mover(world, bot, command, bot.x + (command.dir === 'right' ? 1 : -1) * command.tiles * T, {
        speed: p.pushSpeed,
        accel: null,
        look: 'push',
        push: true,
      });
    case 'stand_on_plate': {
      const plates = world.level.plates
        .filter((pl) => (command.target ? pl.id === command.target : true) && pl.ty * T === bot.y)
        .map((pl) => ({ pl, center: (plateSpan(pl).x0 + plateSpan(pl).x1) / 2 }))
        .filter(({ center }) => Math.abs(center - (bot.x + bot.w / 2)) <= 8 * T)
        .sort((a, b) => Math.abs(a.center - bot.x) - Math.abs(b.center - bot.x));
      const nearest = plates[0];
      if (!nearest) return new Instant(id, command, 'failed', 'there is no pressure plate on your floor within 8 tiles', null);
      return new Mover(world, bot, command, nearest.center - bot.w / 2, walk, {
        status: 'holding',
        note: `standing on plate ${nearest.pl.id}`,
      });
    }
    case 'jump':
      return new Jumper(world, bot, command);
    case 'climb':
      return new Climber(world, bot, command);
    case 'drop':
      return new Dropper(bot, command);
    case 'wait':
      return new Instant(id, command, 'done', null, bot.holding ? `waited, still holding ${bot.holding}` : null);
    case 'pull_lever':
    case 'hold_lever': {
      const inReach = world.level.levers.filter(
        (l) => (command.target ? l.id === command.target : true) && overlaps(bot, leverReachBox(l)),
      );
      const lever = inReach[0];
      if (!lever) return new Instant(id, command, 'failed', 'there is no lever within reach', null);
      if (command.kind === 'pull_lever') {
        if (lever.mode === 'hold') return new Instant(id, command, 'failed', `lever ${lever.id} only works while held: use hold_lever`, null);
        world.levers[lever.id] = !world.levers[lever.id];
        return new Instant(id, command, 'done', null, `lever ${lever.id} is now ${world.levers[lever.id] ? 'on' : 'off'}`);
      }
      if (lever.mode === 'toggle') return new Instant(id, command, 'failed', `lever ${lever.id} flips: use pull_lever`, null);
      bot.holding = lever.id;
      return new Instant(id, command, 'holding', null, `holding lever ${lever.id}`);
    }
    case 'enter_exit': {
      const exit = world.level.exits.find(
        (e) => (command.target ? e.id === command.target : true) && overlaps(bot, exitBox(e)),
      );
      if (!exit) return new Instant(id, command, 'failed', notAtExit(world, bot, command.target), null);
      const used = world.exitsUsed[exit.id] ?? 0;
      if (used >= exit.slots) return new Instant(id, command, 'failed', `exit ${exit.id} is full: all ${exit.slots} places are taken`, null);
      if (bot.onLadder || !bot.grounded) return new Instant(id, command, 'failed', 'you have to be standing to go through the exit', null);
      bot.exited = true;
      bot.vx = 0;
      bot.vy = 0;
      bot.holding = null;
      world.exitsUsed[exit.id] = used + 1;
      world.exitOrder.push(bot.id);
      return new Instant(id, command, 'done', null, `went through exit ${exit.id}, number ${world.exitOrder.length}`);
    }
    case 'trip':
    case 'steal':
    case 'give':
    case 'boost':
      return socialController(world, bot, command);
    case 'block':
      return new Instant(id, command, 'done', null, bot.holding ? `stood its ground, still holding ${bot.holding}` : 'stood its ground');
  }
}
