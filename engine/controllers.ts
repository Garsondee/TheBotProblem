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
import { laddersOf, TILE, tileAt } from './level';
import type { Intent, PushOutcome, StepReport } from './physics';
import { jumpVelocityFor } from './stats';
import { rollDice } from './dice';
import { canSeeBody } from './sight';
import type { Bot, SocialAction, World, WorldEvent } from './world';
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

/** How far a shove of standard strength sends a bot of standard weight, and how high it lifts it. */
const SHOVE_TILES = 1.25;
const SHOVE_LIFT_TILES = 0.35;

/**
 * An attack's dice (Ingram, 2026-11-20). It works with chance (1000 - the
 * target's alertness) in 1000: everyone starts unalert, so the first attack of
 * a game always works. Whatever the dice say, everyone who sees the attempt
 * (the two bots included) goes fully on guard, and attacks on them can't
 * succeed until the game lowers their guard again, round by round.
 */
function attack(world: World, bot: Bot, other: Bot): { hit: boolean; chance: number } {
  const chance = Math.max(0, Math.min(1000, 1000 - other.alert));
  const hit = chance >= 1000 ? true : chance <= 0 ? false : rollDice(world) < chance;
  for (const w of world.bots) {
    if (w.exited) continue;
    if (w === bot || w === other || canSeeBody(world, w, bot) || canSeeBody(world, w, other)) {
      w.alert = 1000;
      w.sawAttack = true;
    }
  }
  return { hit, chance };
}

/** trip, steal, push_past, shove (attacks, on dice), give and boost: one bot acting on another (spec 7.4). */
function socialController(world: World, bot: Bot, command: Extract<Command, { kind: 'trip' | 'steal' | 'give' | 'boost' | 'push_past' | 'shove' }>): Controller {
  const id = bot.id;
  const no = (reason: string) => new Instant(id, command, 'failed', reason, null);
  const other = world.bots.find((b) => b.id === command.target);
  if (other === bot) return no(`you can't ${command.kind.replace('_', ' ')} yourself`);
  if (!other || other.exited) return no(`there's no bot ${command.target} in the room`);
  const event = (action: SocialAction, coins: number, roll?: { hit: boolean; chance: number }): WorldEvent => ({
    step: 0,
    type: 'social',
    action,
    by: id,
    target: other.id,
    coins,
    ...(roll ? { success: roll.hit, chance: roll.chance } : {}),
  });
  let done: Controller;
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
    case 'give':
      if (!beside(bot, other)) return no(`${other.id} is not right beside you`);
      if (bot.purse < command.coins) return no(`you have only ${coinsText(bot.purse)}`);
      bot.purse -= command.coins;
      other.purse += command.coins;
      done = new Instant(id, command, 'done', null, `gave ${other.id} ${coinsText(command.coins)}`);
      done.events.push(event('give', command.coins));
      return done;
    case 'trip': {
      if (!beside(bot, other)) return no(`${other.id} is not right beside you`);
      const roll = attack(world, bot, other);
      if (!roll.hit) {
        done = no(`${other.id} saw it coming and stepped clear`);
      } else {
        other.tripped = true;
        done = new Instant(id, command, 'done', null, `tripped ${other.id}, which loses its next slot`);
      }
      done.events.push(event('trip', 0, roll));
      return done;
    }
    case 'steal': {
      if (!beside(bot, other)) return no(`${other.id} is not right beside you`);
      if (other.purse < 1) return no(`${other.id} has no coins`);
      const roll = attack(world, bot, other);
      if (!roll.hit) {
        done = no(`${other.id} was on guard and kept hold of its coins`);
      } else {
        other.purse -= 1;
        bot.purse += 1;
        done = new Instant(id, command, 'done', null, `took 1 coin from ${other.id}`);
      }
      done.events.push(event('steal', roll.hit ? 1 : 0, roll));
      return done;
    }
    case 'push_past': {
      if (!beside(bot, other) || Math.abs(other.y - bot.y) > T / 4) return no(`${other.id} is not right beside you on your floor`);
      if (!bot.grounded || bot.onLadder) return no('you have to be standing on the floor to push past');
      // Where you end up: just past it. That must be possible before anyone rolls anything.
      const dir = other.x > bot.x ? 1 : -1;
      const to = dir > 0 ? other.x + other.w + Math.round(T / 10) : other.x - bot.w - Math.round(T / 10);
      const others = { ...world, bots: world.bots.filter((b) => b !== other) };
      if (!isFree(others, { x: to, y: bot.y, w: bot.w, h: bot.h }, bot) || !surfaceIntervals(others, bot.y, bot).some(([a, b]) => a <= to + bot.w / 2 && b >= to + bot.w / 2)) {
        return no(`no room past ${other.id} to push through to`);
      }
      const roll = attack(world, bot, other);
      if (!roll.hit) {
        done = no(`${other.id} saw it coming and held its ground`);
        done.events.push(event('push_past', 0, roll));
        return done;
      }
      other.slowed = true;
      bot.passThrough = other.id;
      const p = bot.phys;
      done = new Mover(world, bot, command, to, { speed: p.runSpeed, accel: null, look: 'push', push: false }, { status: 'done', note: `pushed past ${other.id}, which is slowed for the rest of the round` });
      done.events.push(event('push_past', 0, roll));
      return done;
    }
    case 'shove': {
      if (!beside(bot, other) || Math.abs(other.y - bot.y) > T / 2) return no(`${other.id} is not right beside you`);
      const roll = attack(world, bot, other);
      if (!roll.hit) {
        done = no(`${other.id} saw it coming and braced itself`);
        done.events.push(event('shove', 0, roll));
        return done;
      }
      // Stronger shovers send lighter bots further (both hidden: the result says where it went, not why).
      const dir = other.x > bot.x ? 1 : -1;
      const tiles = Math.min(2.5, Math.max(0.5, (SHOVE_TILES * bot.phys.strength) / Math.max(1, other.phys.weight)));
      const vy = jumpVelocityFor(Math.round(SHOVE_LIFT_TILES * T), PHYS.gravity);
      const airSteps = Math.max(1, Math.round((2 * vy) / PHYS.gravity));
      other.vx = Math.round((dir * tiles * T) / airSteps);
      other.vy = vy;
      other.grounded = false;
      other.support = null;
      other.airSteps = PHYS.coyoteSteps + 1;
      other.holding = null; // a shove breaks any grip on a lever
      other.interrupt = 'you were shoved';
      done = new Instant(id, command, 'done', null, `shoved ${other.id} away`);
      done.events.push(event('shove', 0, roll));
      return done;
    }
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
    if (++this.stuck >= BLOCKED_STEPS) this.fail(this.blockedReason(world, bot, report));
  }

  private blockedReason(world: World, bot: Bot, report: StepReport): string {
    const p = this.lastPush;
    if (p && p.moved === 0) {
      return p.strongEnough
        ? `crate ${p.crate} is stuck: something on its far side is in the way (you stopped at ${where(bot)})`
        : `crate ${p.crate} didn't move: it weighs ${weightText(p.weight)} (you stopped at ${where(bot)})`;
    }
    const contact = report.stoppedX.get(bot.id);
    return `blocked by ${contact ? describeContact(contact, world) : 'something'} at ${where(bot)}`;
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
    else if (bot.crouched) this.fail("you're crouching: stand up first");
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
        this.fail(`blocked during the run-up by ${contact ? describeContact(contact, world) : 'something'} at ${where(bot)}`);
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

/** How far past a bot a hop lands, and how far above its head the hopper's feet must be to cross. */
const HOP_GAP = Math.round(T / 10);
const HOP_CLEARANCE = Math.round(T / 10);

/** A hop's speeds: up and down 0.18 tiles a step at most, across 0.12 (about half a second in all). */
const HOP_RISE = Math.round(0.18 * T);
const HOP_CROSS = Math.round(0.12 * T);
const ease = (t: number) => t * t * (3 - 2 * t);

/**
 * hop_over(B), and the hopping half of a swap: a controlled jump over the bot
 * beside you (Ingram, 2026-11-20: "jumping over each other with controlled
 * jumps"). The game flies it, step by step: up until the feet clear the other
 * bot's head, across, and down onto the exact spot. A real jump steered in the
 * air couldn't make that crossing from a standstill (it was tried: it came down
 * on the other bot's head), and a swap needs the exact spot. Being the game's
 * own move, it reveals nothing of the hopper's hidden jump.
 *
 * Every step still goes through the physics, so walls and bodies stop it; if
 * something gets in the way, the hop fails there and the bot falls from where
 * it was.
 */
class Hopper extends Base {
  private readonly path: { x: number; y: number }[] = [];
  private i = 0;

  constructor(
    world: World,
    bot: Bot,
    command: Command,
    private readonly over: string,
    clearY: number,
    landX: number,
    private readonly doneNote: string,
  ) {
    super(bot.id, command);
    const x0 = bot.x;
    const y0 = bot.y;
    const up = Math.max(4, Math.ceil((clearY - y0) / HOP_RISE));
    const across = Math.max(4, Math.ceil(Math.abs(landX - x0) / HOP_CROSS));
    for (let k = 1; k <= up; k++) this.path.push({ x: x0, y: Math.round(y0 + (clearY - y0) * ease(k / up)) });
    for (let k = 1; k <= across; k++) this.path.push({ x: Math.round(x0 + (landX - x0) * ease(k / across)), y: clearY });
    for (let k = 1; k <= up; k++) this.path.push({ x: landX, y: Math.round(clearY - (clearY - y0) * ease(k / up)) });
    void world;
  }

  override intent(_world: World): Intent {
    const next = this.path[this.i];
    return next ? { glide: next } : {};
  }

  override after(world: World, _report: StepReport): void {
    const bot = this.bot(world);
    const wanted = this.path[this.i];
    if (!wanted) return;
    if (bot.x !== wanted.x || bot.y !== wanted.y) {
      // Something solid was in the way: the game lets go, and the bot falls from here.
      this.fail(`the hop over ${this.over} was stopped at ${where(bot)}: something was in the way`);
      return;
    }
    this.i++;
    if (this.i >= this.path.length) this.finish(`${this.doneNote}: landed on ${footingText(bot)} at ${where(bot)}`);
  }
}

/**
 * Can `bot` hop over `other`? The landing spot just past it must be free and
 * have floor under it, and there must be room above both of them. Returns the
 * hop's numbers, or the reason it can't be done (said plainly: these are facts
 * of the room, not of anyone's body).
 */
export function planHop(world: World, bot: Bot, other: Bot, ignore: Bot | null = null, landAt: number | null = null): { clearY: number; landX: number } | { error: string } {
  if (bot.onLadder) return { error: 'you are on a ladder: climb up or down first' };
  if (!bot.grounded) return { error: 'you are in the air' };
  if (bot.crouched) return { error: "you're crouching: stand up first" };
  if (!beside(bot, other) || Math.abs(other.y - bot.y) > T / 4) return { error: `${other.id} isn't right beside you on your floor` };
  const dir = other.x > bot.x ? 1 : -1;
  const landX = landAt ?? (dir > 0 ? other.x + other.w + HOP_GAP : other.x - bot.w - HOP_GAP);
  const clearY = other.y + other.h + HOP_CLEARANCE;
  // Room to land: free of walls and bodies (a swap partner walking away doesn't count), with floor under it.
  const without = ignore ? { ...world, bots: world.bots.filter((b) => b !== ignore) } : world;
  if (!isFree(without, { x: landX, y: bot.y, w: bot.w, h: bot.h }, bot)) return { error: `no room to land past ${other.id}` };
  const floor = surfaceIntervals(without, bot.y, bot).some(([a, b]) => a <= landX + bot.w / 2 && b >= landX + bot.w / 2);
  if (!floor) return { error: `there's no floor to land on just past ${other.id}` };
  // Room above: the hopper rises in its own column, then crosses above the other's head.
  const lo = Math.min(bot.x, landX);
  const hi = Math.max(bot.x, landX) + bot.w;
  if (!isFree(without, { x: lo, y: clearY, w: hi - lo, h: bot.h }, bot) || !isFree(without, { x: bot.x, y: bot.y + bot.h, w: bot.w, h: clearY - bot.y }, bot)) {
    return { error: `not enough room above ${other.id} to hop over it` };
  }
  return { clearY, landX };
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
    if (bot.crouched) {
      this.fail("you're crouching: stand up first");
      return;
    }
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
    if (stopped && ++this.stuck >= BLOCKED_STEPS) this.fail(`blocked by ${describeContact(stopped, world)} while climbing, at ${where(bot)}`);
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
  // A ladder: stand in its column, ready to climb.
  const ladder = laddersOf(level).find((l) => l.id === id);
  if (ladder) return besideOrOn({ x: ladder.tx * T, w: T }, false);
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
/**
 * Pair this slot's swaps. Two bots swap when each commands swap(the other) in
 * the same slot, side by side on one floor: that's the consent (Ingram,
 * 2026-11-20: "positional swapping if both agree"). One hops over, the first
 * in alphabetical order that isn't crouching, landing where the other stood;
 * the other walks under into its place. They pass through each other for the
 * slot, and nobody else does. A swap command without its match is left out,
 * and its controller says why.
 */
export function planSwaps(world: World, commands: ReadonlyMap<string, Command>): Map<string, SwapRole> {
  const roles = new Map<string, SwapRole>();
  for (const [id, cmd] of commands) {
    if (cmd.kind !== 'swap' || roles.has(id)) continue;
    const match = commands.get(cmd.target);
    if (!match || match.kind !== 'swap' || match.target !== id) continue;
    const a = botById(world, id);
    const b = world.bots.find((x) => x.id === cmd.target);
    if (!b || b.exited) continue;
    const both = (error: (me: Bot, them: Bot) => string) => {
      roles.set(a.id, { error: error(a, b) });
      roles.set(b.id, { error: error(b, a) });
    };
    if (!beside(a, b) || Math.abs(a.y - b.y) > T / 4) {
      both((_me, them) => `${them.id} isn't right beside you on your floor`);
      continue;
    }
    if (a.onLadder || b.onLadder || !a.grounded || !b.grounded) {
      both(() => 'you both have to be standing on the floor to swap');
      continue;
    }
    if (a.crouched && b.crouched) {
      both(() => 'you are both crouching: one of you has to stand, to hop over the other');
      continue;
    }
    const [first, second] = a.id < b.id ? [a, b] : [b, a];
    const [hopper, walker] = first.crouched ? [second, first] : [first, second];
    const hop = planHop(world, hopper, walker, walker, walker.x);
    if ('error' in hop) {
      both(() => `you couldn't swap: ${hop.error.replace(/^you're|^you are/, `${hopper.id} is`)}`);
      continue;
    }
    roles.set(hopper.id, { partner: walker.id, hop });
    roles.set(walker.id, { partner: hopper.id, walkTo: hopper.x });
  }
  return roles;
}

/** A swap's half for one bot, worked out by resolve.ts when the slot starts (both bots must command it). */
export type SwapRole = { partner: string; hop?: { clearY: number; landX: number }; walkTo?: number } | { error: string };

/** What a controller may need to know about the rest of its slot. */
export interface SlotContext {
  swap?: SwapRole;
}

export function startController(world: World, bot: Bot, command: Command, context?: SlotContext): Controller {
  // Doing anything but waiting (or standing your ground) lets go of a held lever.
  if (bot.holding && command.kind !== 'wait' && command.kind !== 'block' && command.kind !== 'hold_lever') bot.holding = null;
  const p = bot.phys;
  // A crouched bot gets about at creep speed, whatever it was asked to do.
  const slow = bot.slowed ? 0.5 : 1; // pushed past this round
  const walk: Gait = bot.crouched ? { speed: Math.round(p.creepSpeed * slow), accel: null, look: 'creep', push: false } : { speed: Math.round(p.runSpeed * slow), accel: p.groundAccel, look: 'walk', push: false };
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
    case 'push_past':
    case 'shove':
      return socialController(world, bot, command);
    case 'block':
      // For the rest of this slot no bot can walk or climb through it (engine/collision.ts letsThrough).
      bot.blocking = true;
      return new Instant(id, command, 'done', null, bot.holding ? `stood its ground, still holding ${bot.holding}` : 'stood its ground');
    case 'hop_over': {
      const other = world.bots.find((b) => b.id === command.target && !b.exited);
      if (!other || other === bot) return new Instant(id, command, 'failed', other === bot ? "you can't hop over yourself" : `there's no bot ${command.target} here`, null);
      const plan = planHop(world, bot, other);
      if ('error' in plan) return new Instant(id, command, 'failed', plan.error, null);
      return new Hopper(world, bot, command, other.id, plan.clearY, plan.landX, `hopped over ${other.id}`);
    }
    case 'swap': {
      // Settled before the slot starts (resolve.ts pairs the swaps): here only the half this bot plays.
      const role = context?.swap;
      if (!role) return new Instant(id, command, 'failed', `${command.target} didn't command swap(${id}) in this slot`, null);
      if ('error' in role) return new Instant(id, command, 'failed', role.error, null);
      const partner = botById(world, role.partner);
      bot.passThrough = partner.id;
      if (role.hop) return new Hopper(world, bot, command, partner.id, role.hop.clearY, role.hop.landX, `swapped places with ${partner.id}`);
      return new Mover(world, bot, command, role.walkTo ?? bot.x, walk, { status: 'done', note: `swapped places with ${partner.id}` });
    }
    case 'crouch': {
      if (bot.onLadder) return new Instant(id, command, 'failed', 'you are on a ladder: climb up or down first', null);
      if (!bot.grounded) return new Instant(id, command, 'failed', 'you are in the air', null);
      if (bot.crouched) return new Instant(id, command, 'done', null, 'already crouching');
      bot.crouched = true;
      bot.h = Math.round(PHYS.botHeight / 2);
      return new Instant(id, command, 'done', null, `crouched: your top is at y=${tiles(bot.y + bot.h)}`);
    }
    case 'stand': {
      if (!bot.crouched) return new Instant(id, command, 'done', null, 'already standing');
      // Every bot counts here: a bot standing on your head keeps you down.
      if (!isFree(world, { x: bot.x, y: bot.y, w: bot.w, h: PHYS.botHeight }, bot, 'all')) {
        return new Instant(id, command, 'failed', `no room to stand up here: something is above you, below y=${tiles(bot.y + PHYS.botHeight)}`, null);
      }
      bot.crouched = false;
      bot.h = PHYS.botHeight;
      return new Instant(id, command, 'done', null, 'stood up');
    }
  }
}
