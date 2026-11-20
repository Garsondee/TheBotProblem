/**
 * One simulation step: 1/60 of a second of the world moving.
 *
 * Each step:
 *   1. turns every bot's intent (what its command wants this step, see
 *      controllers.ts) into velocity, and applies gravity
 *   2. resolves pushes: a chain of bots pushing a crate moves it if their
 *      strengths add up to its weight
 *   3. moves every body sideways, then every body up or down, each stopping
 *      flush against whatever is in its way (collision.ts)
 *   4. works out what each body is standing on
 *   5. updates the switches: plates, levers, doors, coins
 *
 * Bodies move in a fixed order (the front of a moving queue first, the bottom
 * of a stack first), so the same world always steps the same way, and a bot
 * walking behind another follows it instead of bumping into it.
 */
import { PHYS, UNITS_PER_TILE as T } from './constants';
import { coinBox, doorBox, leverReachBox, overlaps, plateSpan, supportUnder, sweepX, sweepY } from './collision';
import type { Level } from './level';
import type { BotStats } from './stats';
import type { Body, Bot, Contact, Crate, World, WorldEvent } from './world';
import { activeBodies, createWorld, isBot, weightOf } from './world';

/** What a bot's command asks of the physics this step. */
export interface Intent {
  /** On the ground: the exact sideways speed for this step (signed, units a step). */
  vx?: number;
  /** In the air: the sideways speed to steer toward (air control). */
  airTarget?: number;
  /** Leave the ground this step. */
  jump?: 'full' | 'short';
  /** On a ladder: the climbing speed this step (positive is up). */
  climbVy?: number;
  /** Push the crate in front, in this direction. */
  push?: -1 | 1;
  /** Fall through the one-way platform underfoot. */
  drop?: boolean;
  /** How the movement should look in the replay. */
  gait?: 'walk' | 'creep' | 'push';
}

export interface PushOutcome {
  crate: string;
  /** The crate's weight, thousandths. Strengths are never reported: they're hidden stats. */
  weight: number;
  moved: number;
  /** Did the pushers have the strength? (false = too heavy; true but moved 0 = the crate is stuck). */
  strongEnough: boolean;
}

export interface StepReport {
  /** Bodies that something stopped sideways this step, and what stopped them. */
  stoppedX: Map<string, Contact>;
  stoppedY: Map<string, Contact>;
  /** Bots that left the ground with a jump this step. */
  jumped: Set<string>;
  /** By pushing bot. */
  pushes: Map<string, PushOutcome>;
  events: WorldEvent[];
}

const approach = (value: number, target: number, step: number) =>
  value < target ? Math.min(value + step, target) : Math.max(value - step, target);
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
const byId = (a: Body, b: Body) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const isPlatform = (c: Contact | null) => c?.kind === 'tile' && c.tile !== 'solid';
const passesPlatforms = (b: Body) => isBot(b) && (b.dropSteps > 0 || b.onLadder);

/** A new world for a level with everything settled and every switch set. */
export function initWorld(level: Level, stats: Readonly<Record<string, BotStats>>): World {
  const world = createWorld(level, stats);
  updateGrounding(world);
  updateSwitches(world, []);
  return world;
}

/** Advance the world by one step. Changes `world` in place. */
export function stepWorld(world: World, intents: ReadonlyMap<string, Intent>): StepReport {
  const report: StepReport = { stoppedX: new Map(), stoppedY: new Map(), jumped: new Set(), pushes: new Map(), events: [] };

  // 1. Velocities.
  for (const bot of world.bots) {
    if (bot.exited) continue;
    const it = intents.get(bot.id) ?? {};
    const p = bot.phys;
    if (bot.onLadder) {
      bot.vx = 0;
      bot.vy = it.climbVy ?? 0;
      continue;
    }
    if (it.drop && bot.grounded && isPlatform(bot.support)) {
      bot.dropSteps = PHYS.dropSteps;
      bot.grounded = false;
    }
    const mayJump = bot.grounded || bot.airSteps <= p.coyoteSteps;
    if (it.jump && mayJump) {
      bot.vy = it.jump === 'full' ? p.jumpFull : p.jumpShort;
      bot.vx = clamp(it.vx ?? bot.vx, -p.maxAirSpeed, p.maxAirSpeed); // jump distance caps speed in the air
      bot.grounded = false;
      bot.airSteps = p.coyoteSteps + 1; // coyote time can't give a second jump
      report.jumped.add(bot.id);
    } else if (bot.grounded) {
      bot.vx = it.vx ?? 0;
      bot.vy = 0;
    } else if (it.airTarget !== undefined) {
      bot.vx = approach(bot.vx, it.airTarget, p.airAccel);
    } // else: in the air with no steering, momentum carries on
    if (!bot.grounded) bot.vy = Math.max(bot.vy - p.gravity, -p.maxFallSpeed);
  }
  for (const crate of world.crates) {
    crate.vx = 0; // crates only move sideways when pushed
    crate.vy = crate.grounded ? 0 : Math.max(crate.vy - PHYS.gravity, -PHYS.maxFallSpeed);
  }

  // 2. Pushes. The chain moves as one, so the pushers stay in contact with the crate.
  const movedX = new Set<string>();
  for (const crate of [...world.crates].sort(byId)) {
    if (!crate.grounded) continue; // a falling crate can't be pushed
    for (const dir of [1, -1] as const) {
      const chain = pushChain(world, crate, dir, intents);
      if (chain.length === 0) continue;
      const strength = chain.reduce((sum, b) => sum + b.phys.strength, 0);
      const strongEnough = strength >= crate.weight;
      let moved = 0;
      if (strongEnough) {
        const want = dir * Math.min(...chain.map((b) => Math.abs(intents.get(b.id)?.vx ?? 0)));
        moved = sweepX(world, crate, want).moved;
        crate.x += moved;
        for (const b of chain) b.x += sweepX(world, b, moved).moved;
      }
      movedX.add(crate.id);
      for (const b of chain) {
        movedX.add(b.id);
        b.vx = moved;
        report.pushes.set(b.id, { crate: crate.id, weight: crate.weight, moved, strongEnough });
        if (moved === 0) report.stoppedX.set(b.id, { kind: 'crate', id: crate.id });
      }
    }
  }

  // 3a. Sideways: the front of each moving queue first.
  const bodies = activeBodies(world);
  const sideways = bodies.filter((b) => b.vx !== 0 && !movedX.has(b.id)).sort(frontFirst);
  for (const body of sideways) {
    const s = sweepX(world, body, body.vx);
    body.x += s.moved;
    if (s.moved !== body.vx) {
      if (s.contact) report.stoppedX.set(body.id, s.contact);
      body.vx = 0;
    }
  }
  // 3b. Up and down: falling bodies bottom first, rising bodies top first.
  const vertical = bodies.filter((b) => b.vy !== 0).sort(bottomFirst);
  for (const body of vertical) {
    const s = sweepY(world, body, body.vy, passesPlatforms(body));
    body.y += s.moved;
    if (s.moved !== body.vy) {
      if (s.contact) report.stoppedY.set(body.id, s.contact);
      body.vy = 0;
    }
  }

  // 4. What everything stands on.
  updateGrounding(world);

  // 5. Switches, then how each bot looks.
  world.step += 1;
  updateSwitches(world, report.events);
  for (const bot of world.bots) {
    if (bot.exited) {
      bot.anim = 'exited';
      continue;
    }
    const gait = intents.get(bot.id)?.gait;
    if (bot.vx !== 0) bot.facing = bot.vx > 0 ? 1 : -1;
    bot.anim = bot.onLadder
      ? 'climb'
      : !bot.grounded
        ? bot.vy > 0
          ? 'jump'
          : 'fall'
        : report.pushes.has(bot.id)
          ? 'push'
          : bot.holding
            ? 'hold'
            : bot.vx === 0
              ? 'idle'
              : (gait ?? 'walk');
  }
  return report;
}

/**
 * The bots pushing `crate` in direction `dir`: the one touching it, then any
 * bot touching that one from behind and pushing the same way, and so on.
 * Touching is exact (edge to edge), because positions are whole numbers.
 */
function pushChain(world: World, crate: Crate, dir: 1 | -1, intents: ReadonlyMap<string, Intent>): Bot[] {
  const chain: Bot[] = [];
  let front: Body = crate;
  for (;;) {
    const next = world.bots.find(
      (b) =>
        !b.exited &&
        b.grounded &&
        !chain.includes(b) &&
        intents.get(b.id)?.push === dir &&
        b.y < front.y + front.h &&
        front.y < b.y + b.h &&
        (dir === 1 ? b.x + b.w === front.x : b.x === front.x + front.w),
    );
    if (!next) return chain;
    chain.push(next);
    front = next;
  }
}

function frontFirst(a: Body, b: Body): number {
  const da = Math.sign(a.vx);
  const db = Math.sign(b.vx);
  if (da !== db) return db - da; // movers to the right go before movers to the left
  const d = da > 0 ? b.x - a.x : a.x - b.x;
  return d !== 0 ? d : byId(a, b);
}

function bottomFirst(a: Body, b: Body): number {
  const fa = a.vy < 0 ? 0 : 1;
  const fb = b.vy < 0 ? 0 : 1;
  if (fa !== fb) return fa - fb; // falling before rising
  const d = fa === 0 ? a.y - b.y : b.y + b.h - (a.y + a.h);
  return d !== 0 ? d : byId(a, b);
}

/** Work out what every body stands on. */
function updateGrounding(world: World): void {
  for (const body of activeBodies(world)) {
    const bot = isBot(body) ? body : null;
    const support = body.vy > 0 ? null : supportUnder(world, body, passesPlatforms(body));
    body.support = support;
    body.grounded = support !== null && !bot?.onLadder;
    if (bot) {
      bot.airSteps = bot.grounded || bot.onLadder ? 0 : bot.airSteps + 1;
      if (bot.dropSteps > 0) bot.dropSteps -= 1;
    }
  }
}

/** Plates, levers, doors and coins, from where everything now is. Records every change as an event. */
function updateSwitches(world: World, events: WorldEvent[]): void {
  const { level } = world;
  const bodies = activeBodies(world);
  const step = world.step;

  // Plates weigh everything resting on them, including whatever is stacked on top.
  for (const plate of level.plates) {
    const span = plateSpan(plate);
    const counted = new Set<string>();
    let weight = 0;
    let botCount = 0;
    const add = (body: Body) => {
      if (counted.has(body.id)) return;
      counted.add(body.id);
      weight += weightOf(body);
      if (isBot(body)) botCount += 1;
      for (const above of bodies) {
        const s = above.support;
        if (above.grounded && s && s.kind !== 'tile' && s.kind !== 'door' && s.id === body.id) add(above);
      }
    };
    for (const body of bodies) {
      if (body.grounded && body.support?.kind === 'tile' && body.y === span.y && body.x < span.x1 && body.x + body.w > span.x0) {
        add(body);
      }
    }
    const pressed =
      counted.size > 0 &&
      (plate.minWeight === null || weight >= plate.minWeight) &&
      (plate.minBots === null || botCount >= plate.minBots);
    if (pressed !== world.plates[plate.id]) {
      world.plates[plate.id] = pressed;
      events.push({ step, type: 'plate', plate: plate.id, pressed, weight, bots: botCount });
    }
  }

  // Hold levers are on only while a bot in reach is holding them.
  for (const lever of level.levers) {
    if (lever.mode !== 'hold') continue;
    const reach = leverReachBox(lever);
    let holder: string | null = null;
    for (const bot of world.bots) {
      if (bot.holding !== lever.id) continue;
      if (!bot.exited && overlaps(bot, reach)) holder ??= bot.id;
      else bot.holding = null; // walked away or left: let go
    }
    const on = holder !== null;
    if (on !== world.levers[lever.id]) {
      world.levers[lever.id] = on;
      events.push({ step, type: 'lever', lever: lever.id, on, by: holder });
    }
  }

  // A door is open while any of its triggers is on, and can't close on anything in its way.
  for (const door of level.doors) {
    let open = door.openWhen.some((id) => world.plates[id] === true || world.levers[id] === true);
    if (!open && world.doors[door.id]) {
      const box = doorBox(door);
      if (bodies.some((b) => overlaps(b, box))) open = true; // held open by whatever stands in it
    }
    if (open !== world.doors[door.id]) {
      world.doors[door.id] = open;
      events.push({ step, type: 'door', door: door.id, open });
    }
  }

  // Coins go to the first bot that touches them.
  for (const coinId of [...world.coins]) {
    const def = level.coins.find((c) => c.id === coinId);
    if (!def) continue;
    const box = coinBox(def);
    const taker = world.bots.find((b) => !b.exited && overlaps(b, box));
    if (taker) {
      world.coins = world.coins.filter((c) => c !== coinId);
      taker.coins.push(coinId);
      events.push({ step, type: 'coin', bot: taker.id, coin: coinId });
    }
  }
}

/** Is everything still? A slot only ends once the world has come to rest. */
export function atRest(world: World): boolean {
  for (const bot of world.bots) {
    if (bot.exited) continue;
    if ((!bot.grounded && !bot.onLadder) || bot.vx !== 0 || bot.vy !== 0) return false;
  }
  return world.crates.every((c) => c.grounded && c.vx === 0 && c.vy === 0);
}

/** A tile column's left edge, in units: handy for tests and levels. */
export const tileX = (tx: number) => tx * T;
