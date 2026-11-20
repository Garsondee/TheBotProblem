/**
 * The world's units, and the rulebook's nominal physics.
 *
 * Positions and sizes are whole numbers of UNITS, 10,000 units to a tile.
 * Velocities are units per step, and the simulation runs 60 steps a second.
 *
 * Why whole numbers instead of decimals? Decimal sums drift in a computer
 * (0.1 + 0.2 is 0.30000000000000004), and in a platformer that drift is how
 * bodies end up stuck in walls or hovering a hair above the floor. With whole
 * numbers, "touching" and "overlapping" are exact, walk(right, 2.5) ends
 * exactly 2.5 tiles away, and the same inputs give the same trace on any
 * machine, which is what replays and forks depend on. Bots still see ordinary
 * decimals: x = 17.62 tiles is 176,200 units.
 *
 * Coordinates: x grows to the right, y grows UP, and (0, 0) is the bottom-left
 * corner of the level. A body's (x, y) is the bottom-left corner of its box,
 * so a bot's y is the height of its feet.
 */
export const UNITS_PER_TILE = 10_000;
export const STEPS_PER_SECOND = 60;

const T = UNITS_PER_TILE;
const perStep = (tilesPerSecond: number) => Math.round((tilesPerSecond * T) / STEPS_PER_SECOND);
const perStepSquared = (tilesPerSecondSquared: number) =>
  Math.round((tilesPerSecondSquared * T) / (STEPS_PER_SECOND * STEPS_PER_SECOND));

/** The nominal stats from the rulebook, in human units (tiles and seconds). */
export const NOMINAL = {
  botWidth: 0.75,
  botHeight: 1.5,
  runSpeed: 6, // tiles per second
  creepSpeed: 1.5,
  pushSpeed: 2,
  climbSpeed: 3,
  groundAccel: 7.2, // tiles per second squared: full speed after 2.5 tiles of running
  airAccel: 12, // air control: how fast a bot can steer in mid-air
  gravity: 30,
  maxFallSpeed: 18,
  jumpHeightFull: 2.2, // how far the feet rise with hold=full
  jumpHeightShort: 1.0, // ... and with hold=short
  coyoteSteps: 6, // a jump still works this many steps after walking off an edge
  dropSteps: 10, // after `drop`, a bot falls through one-way platforms for this many steps
  weight: 1.0, // in bot-weights: plates and crates use the same unit
  strength: 1.0,
  sightRange: 10, // tiles
  leverReach: 0.5, // tiles beyond the lever's own tile
} as const;

/** The same physics in engine units. Hidden stats scale some of these per bot (see stats.ts). */
export const PHYS = {
  botWidth: Math.round(NOMINAL.botWidth * T),
  botHeight: Math.round(NOMINAL.botHeight * T),
  runSpeed: perStep(NOMINAL.runSpeed), // 1000 units a step
  creepSpeed: perStep(NOMINAL.creepSpeed), // 250
  pushSpeed: perStep(NOMINAL.pushSpeed), // 333
  climbSpeed: perStep(NOMINAL.climbSpeed), // 500
  groundAccel: perStepSquared(NOMINAL.groundAccel), // 20
  airAccel: perStepSquared(NOMINAL.airAccel), // 33
  gravity: perStepSquared(NOMINAL.gravity), // 83
  maxFallSpeed: perStep(NOMINAL.maxFallSpeed), // 3000
  jumpHeightFull: Math.round(NOMINAL.jumpHeightFull * T),
  jumpHeightShort: Math.round(NOMINAL.jumpHeightShort * T),
  coyoteSteps: NOMINAL.coyoteSteps,
  dropSteps: NOMINAL.dropSteps,
  sightRange: Math.round(NOMINAL.sightRange * T),
  leverReach: Math.round(NOMINAL.leverReach * T),
} as const;

/**
 * Weights and strengths are whole thousandths of a nominal bot: 1,000 is one
 * bot's weight. A crate of weight 1,400 needs more than one bot's strength.
 */
export const MILLI = 1000;

/** Command slots per bot in one resolve phase (spec section 4). */
export const MAX_SLOTS = 6;
/** A slot ends when every command is done; anything still running after this many steps (10 s) is cut off. */
export const MAX_SLOT_STEPS = 600;
/** A move that makes no progress for this many steps counts as blocked. A bot following a moving bot isn't blocked. */
export const BLOCKED_STEPS = 10;
