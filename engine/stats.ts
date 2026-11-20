/**
 * Hidden per-bot stats: small, secret differences from the rulebook's numbers.
 *
 * The spec (section 4): "Each bot gets small, secret differences from the
 * nominal stats in the rulebook. Nobody is told they are different. They
 * have to discover it." Run speed, jump height and jump distance vary a few
 * percent; weight and strength up to 15%; sight range 10%.
 *
 * Stats are stored as whole thousandths: 1,000 is nominal, 1,063 is 6.3%
 * above. The physics engine uses the TRUE stats; the affordances bots are
 * shown (milestone 3) use the nominal ones, so a bot can notice that it
 * jumps further than predicted, and compare notes with others.
 */
import { MILLI, PHYS } from './constants';
import type { Rng } from './random';

export const STAT_NAMES = ['runSpeed', 'jumpHeight', 'jumpDistance', 'weight', 'strength', 'sightRange'] as const;
export type StatName = (typeof STAT_NAMES)[number];

/** Each stat in thousandths of nominal. */
export type BotStats = Record<StatName, number>;

/** How far each stat may stray, as a fraction: 0.06 means up to 6% either way. Lives in config/game.json. */
export type StatRanges = Record<StatName, number>;

export const NOMINAL_STATS: BotStats = {
  runSpeed: MILLI,
  jumpHeight: MILLI,
  jumpDistance: MILLI,
  weight: MILLI,
  strength: MILLI,
  sightRange: MILLI,
};

/** Roll one bot's hidden stats from the run's "stats" stream. */
export function rollStats(rng: Rng, ranges: StatRanges): BotStats {
  const stats = { ...NOMINAL_STATS };
  for (const name of STAT_NAMES) stats[name] = MILLI + Math.round(rng.signed() * ranges[name] * MILLI);
  return stats;
}

/** Every stat at the edge of its range: +1 for the top, -1 for the bottom. For robustness tests. */
export function extremeStats(ranges: StatRanges, signs: Record<StatName, 1 | -1>): BotStats {
  const stats = { ...NOMINAL_STATS };
  for (const name of STAT_NAMES) stats[name] = MILLI + Math.round(signs[name] * ranges[name] * MILLI);
  return stats;
}

/** All stats at the top of their ranges: the most capable bot the rules allow. */
export function bestStats(ranges: StatRanges): BotStats {
  return extremeStats(ranges, Object.fromEntries(STAT_NAMES.map((n) => [n, 1])) as Record<StatName, 1>);
}

/**
 * Highest point of a jump in this simulation: each step, gravity is taken off
 * the upward speed and then the bot moves by it, so the rise is the sum
 * (v - g) + (v - 2g) + ... while that stays positive.
 */
export function apexOf(jumpVelocity: number, gravity: number): number {
  const n = Math.floor(jumpVelocity / gravity);
  return n * jumpVelocity - (gravity * n * (n + 1)) / 2;
}

/**
 * The jump speed that lifts the feet `height` units. Found by search rather
 * than the textbook sqrt(2gh), because the textbook formula is for smooth
 * motion and our steps are discrete: it would come out about 5% short.
 */
export function jumpVelocityFor(height: number, gravity: number): number {
  let v = Math.floor(Math.sqrt(2 * gravity * height));
  while (apexOf(v, gravity) < height) v++;
  return v;
}

/** One bot's physics, with its true stats applied, in engine units. */
export interface BotPhysics {
  width: number;
  height: number;
  runSpeed: number;
  creepSpeed: number;
  pushSpeed: number;
  climbSpeed: number;
  groundAccel: number;
  airAccel: number;
  /** The fastest a bot moves sideways in the air. Jump distance scales this. */
  maxAirSpeed: number;
  gravity: number;
  maxFallSpeed: number;
  jumpFull: number;
  jumpShort: number;
  coyoteSteps: number;
  /** In thousandths of a nominal bot. */
  weight: number;
  strength: number;
  /** In units. */
  sightRange: number;
}

const scale = (value: number, thousandths: number) => Math.round((value * thousandths) / MILLI);

export function physicsFor(stats: BotStats): BotPhysics {
  const runSpeed = scale(PHYS.runSpeed, stats.runSpeed);
  return {
    width: PHYS.botWidth,
    height: PHYS.botHeight,
    runSpeed,
    creepSpeed: PHYS.creepSpeed,
    pushSpeed: PHYS.pushSpeed,
    climbSpeed: PHYS.climbSpeed,
    groundAccel: PHYS.groundAccel,
    airAccel: PHYS.airAccel,
    maxAirSpeed: scale(runSpeed, stats.jumpDistance),
    gravity: PHYS.gravity,
    maxFallSpeed: PHYS.maxFallSpeed,
    jumpFull: jumpVelocityFor(scale(PHYS.jumpHeightFull, stats.jumpHeight), PHYS.gravity),
    jumpShort: jumpVelocityFor(scale(PHYS.jumpHeightShort, stats.jumpHeight), PHYS.gravity),
    coyoteSteps: PHYS.coyoteSteps,
    weight: stats.weight,
    strength: stats.strength,
    sightRange: scale(PHYS.sightRange, stats.sightRange),
  };
}
