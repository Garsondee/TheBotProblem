/**
 * The world's state: where every body is, and what every switch is set to.
 *
 * The level (tiles, entity positions) never changes; the World is the part
 * that does. Worlds are copied, never shared, between resolve phases, so a
 * snapshot taken at round N stays exactly as it was (forks depend on that).
 */
import { MILLI, PHYS, UNITS_PER_TILE as T } from './constants';
import type { Level } from './level';
import type { BotPhysics, BotStats } from './stats';
import { physicsFor } from './stats';

/** crouch: crouched and still; crawl: moving while crouched. */
export type Anim = 'idle' | 'walk' | 'creep' | 'push' | 'jump' | 'fall' | 'climb' | 'hold' | 'crouch' | 'crawl' | 'exited';

/** What a body stands on, or what stopped it. */
export type Contact =
  | { kind: 'tile'; tile: 'solid' | 'platform' | 'ladder-top' }
  | { kind: 'door'; id: string }
  | { kind: 'bot'; id: string }
  | { kind: 'crate'; id: string };

/** A box that moves: a bot or a crate. Units throughout; (x, y) is the bottom-left corner. */
export interface Body {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  vx: number;
  vy: number;
  grounded: boolean;
  support: Contact | null;
}

export interface Bot extends Body {
  kind: 'bot';
  /** True stats, in thousandths of nominal. Hidden from every bot, the owner included until the spectator overlay. */
  stats: BotStats;
  phys: BotPhysics;
  /** Steps since this bot last stood on something (for coyote time). */
  airSteps: number;
  onLadder: boolean;
  /** While above 0, one-way platforms don't hold this bot (it is dropping through). */
  dropSteps: number;
  /** The hold lever this bot is holding, if any. */
  holding: string | null;
  facing: 1 | -1;
  anim: Anim;
  exited: boolean;
  /** Coins picked up in this room (by id). */
  coins: string[];
  /** Coins the bot holds: carried from room to room by the game, spent and traded with trip, steal and give. */
  purse: number;
  /** Tripped by another bot: it loses its next command slot (spec 7.4). */
  tripped: boolean;
  /** Crouched: half height, creeping, no jumping or climbing, until it stands. */
  crouched: boolean;
  /**
   * How much on guard this bot is, 0 to 1000. An attack on it succeeds with
   * chance (1000 - alert) / 1000: everyone starts at 0, so the first attack
   * always works; anyone who sees an attack goes to 1000; the game lowers it
   * each round, at the bot's own guard rate.
   */
  alert: number;
  /** Saw an attack during the round just played: its guard holds at full for the next round before it starts to drop. */
  sawAttack: boolean;
  /** Pushed past this round: it moves at half speed until the round ends. */
  slowed: boolean;
  /** Something done to this bot that ends its current command (a shove), with the reason it is told. */
  interrupt: string | null;
  /** The one bot this bot may pass through during the current slot (a swap's partner), or null. */
  passThrough: string | null;
}

export interface Crate extends Body {
  kind: 'crate';
  /** In thousandths of a bot's weight. */
  weight: number;
}

export type WorldEvent =
  | { step: number; type: 'coin'; bot: string; coin: string }
  | { step: number; type: 'plate'; plate: string; pressed: boolean; weight: number; bots: number }
  | { step: number; type: 'door'; door: string; open: boolean }
  | { step: number; type: 'lever'; lever: string; on: boolean; by: string | null }
  | { step: number; type: 'exit'; bot: string; exit: string; place: number }
  /**
   * One bot doing something to another (spec 7.4). `by` is '?' in the anonymous announcement of harm.
   * Attacks (trip, steal, push_past, shove) roll dice: `success` says whether it worked, `chance` was
   * its chance in thousandths (from the target's alertness). Gifts and boosts don't roll.
   */
  | { step: number; type: 'social'; action: SocialAction; by: string; target: string; coins: number; success?: boolean; chance?: number };

export type SocialAction = 'trip' | 'steal' | 'give' | 'boost' | 'push_past' | 'shove';
/** The actions that are attacks: they roll dice, and whoever sees them goes on guard. */
export const ATTACKS: ReadonlySet<SocialAction> = new Set(['trip', 'steal', 'push_past', 'shove']);

export interface World {
  level: Level;
  /** The state of the attack dice (engine/dice.ts): every roll advances it. */
  dice: number;
  /** Simulation steps since the level began. */
  step: number;
  /** Sorted by id, always, so everything that loops over bots does so in the same order. */
  bots: Bot[];
  crates: Crate[];
  levers: Record<string, boolean>;
  plates: Record<string, boolean>;
  /** true = open. */
  doors: Record<string, boolean>;
  /** Coins still lying in the level. */
  coins: string[];
  /** Bots that went through an exit, in the order they did. */
  exitOrder: string[];
  exitsUsed: Record<string, number>;
}

/**
 * A fresh world for a level, with one bot per entry in `stats`, each at the
 * level's starting tile with the same letter. Use physics.initWorld, which
 * also settles everything onto the floor and sets the switches.
 */
export function createWorld(level: Level, stats: Readonly<Record<string, BotStats>>): World {
  const bots = Object.keys(stats)
    .sort()
    .map((id): Bot => {
      const spawn = level.spawns[id];
      if (!spawn) throw new Error(`Level ${level.id} has no starting tile for bot ${id}.`);
      const botStats = stats[id] as BotStats;
      return {
        kind: 'bot',
        id,
        x: spawn.tx * T + (T - PHYS.botWidth) / 2, // centred in its tile
        y: spawn.ty * T,
        w: PHYS.botWidth,
        h: PHYS.botHeight,
        vx: 0,
        vy: 0,
        grounded: false,
        support: null,
        stats: botStats,
        phys: physicsFor(botStats),
        airSteps: 0,
        onLadder: false,
        dropSteps: 0,
        holding: null,
        facing: 1,
        anim: 'idle',
        exited: false,
        coins: [],
        purse: 0,
        tripped: false,
        crouched: false,
        passThrough: null,
        alert: 0,
        sawAttack: false,
        slowed: false,
        interrupt: null,
      };
    });
  return {
    level,
    // The game seeds the dice for each room (engine/dice.ts); a fixed start keeps tests and validation repeatable.
    dice: 1,
    step: 0,
    bots,
    crates: level.crates.map((c) => ({
      kind: 'crate' as const,
      id: c.id,
      x: c.tx * T,
      y: c.ty * T,
      w: T,
      h: T,
      vx: 0,
      vy: 0,
      grounded: false,
      support: null,
      weight: c.weight,
    })),
    levers: Object.fromEntries(level.levers.map((l) => [l.id, l.startsOn])),
    plates: Object.fromEntries(level.plates.map((p) => [p.id, false])),
    doors: Object.fromEntries(level.doors.map((d) => [d.id, false])),
    coins: level.coins.map((c) => c.id),
    exitOrder: [],
    exitsUsed: Object.fromEntries(level.exits.map((e) => [e.id, 0])),
  };
}

/** A deep copy of everything that can change. The level is shared: it never changes. */
export function cloneWorld(world: World): World {
  return {
    ...world,
    bots: world.bots.map((b) => ({ ...b, support: b.support && { ...b.support }, coins: [...b.coins] })),
    crates: world.crates.map((c) => ({ ...c, support: c.support && { ...c.support } })),
    levers: { ...world.levers },
    plates: { ...world.plates },
    doors: { ...world.doors },
    coins: [...world.coins],
    exitOrder: [...world.exitOrder],
    exitsUsed: { ...world.exitsUsed },
  };
}

export function botById(world: World, id: string): Bot {
  const bot = world.bots.find((b) => b.id === id);
  if (!bot) throw new Error(`No bot ${id} in this world.`);
  return bot;
}

/** Every body still in play: bots that haven't exited, and all crates. */
export function activeBodies(world: World): Body[] {
  return [...world.bots.filter((b) => !b.exited), ...world.crates];
}

export function isBot(body: Body): body is Bot {
  return (body as Bot).kind === 'bot';
}

/** A weight in thousandths, as a body: bots carry their own stat, crates their own. */
export function weightOf(body: Body): number {
  return isBot(body) ? body.phys.weight : (body as Crate).weight;
}

export function describeContact(contact: Contact): string {
  switch (contact.kind) {
    case 'tile':
      return contact.tile === 'solid' ? 'a wall' : contact.tile === 'platform' ? 'a platform' : 'the top of a ladder';
    case 'door':
      return `door ${contact.id}`;
    case 'bot':
      return `bot ${contact.id}`;
    case 'crate':
      return `crate ${contact.id}`;
  }
}

/**
 * What a body is standing on, in words: "solid ground", "bot E", "crate C1".
 * Results say it because a body feels what it lands on, and y alone can
 * mislead: in the first real test, bots that landed on a head (y=3.50)
 * guessed they were on a crate (y=3.00).
 */
export function footingText(body: Body): string {
  const s = body.support;
  if (!s) return 'nothing';
  switch (s.kind) {
    case 'tile':
      return s.tile === 'solid' ? 'solid ground' : s.tile === 'platform' ? 'a one-way platform' : 'the top of a ladder';
    case 'door':
      return `door ${s.id}`;
    case 'bot':
      return `bot ${s.id}`;
    case 'crate':
      return `crate ${s.id}`;
  }
}

/** Units to tiles, rounded to two decimals, for text a bot or a person reads. */
export function tiles(units: number): string {
  return (Math.round(units / 100) / 100).toFixed(2);
}

/** Where a body's feet are: the middle of its bottom edge, in units. */
export function feet(body: Body): { x: number; y: number } {
  return { x: body.x + body.w / 2, y: body.y };
}

/** "x=17.62, y=2.00": a body's feet, in tiles. */
export function where(body: Body): string {
  const f = feet(body);
  return `x=${tiles(f.x)}, y=${tiles(f.y)}`;
}

/** Thousandths as a bot-weight, like 1.40. */
export function weightText(thousandths: number): string {
  return (thousandths / MILLI).toFixed(2);
}
