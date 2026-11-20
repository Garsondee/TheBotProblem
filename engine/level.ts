/**
 * Levels: the JSON format in config/levels/, turned into geometry.
 *
 * A level file draws the level as a picture, one string per row, top row
 * first, the way you'd see it on screen:
 *
 *   #  solid      .  empty      -  one-way platform      =  ladder
 *   A to H       a bot's starting tile
 *   anything else is an entity, described in the file's "key", for example
 *   "c": { "type": "crate", "id": "C1", "weight": 1.4 }
 *
 * Coins all share one character; they are numbered $1, $2, ... in reading
 * order (top row first, left to right). Every other entity character is
 * used once.
 *
 * The picture runs top to bottom, but the engine's y grows upward (so a
 * height is a plain number), so the loader flips the rows: the bottom row of
 * the picture is y = 0.
 *
 * This module is pure (no file access), so the browser viewer can use it.
 * Loading from disk lives in harness/levels.ts.
 */
import { z } from 'zod';
import { MAX_SLOTS, MILLI } from './constants';

export const TILE = { EMPTY: 0, SOLID: 1, ONEWAY: 2, LADDER: 3 } as const;
export type Tile = (typeof TILE)[keyof typeof TILE];

const TERRAIN: Readonly<Record<string, Tile>> = { '.': TILE.EMPTY, '#': TILE.SOLID, '-': TILE.ONEWAY, '=': TILE.LADDER };
const SPAWN = /^[A-H]$/;
const Id = z.string().regex(/^[A-Z][A-Z0-9]*$/, 'entity ids are capital letters and digits, like C1 or X');

const KeyEntrySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('crate'), id: Id, weight: z.number().positive() }),
  z.object({
    type: z.literal('plate'),
    id: Id,
    width: z.number().int().min(1).optional(),
    minWeight: z.number().positive().optional(),
    minBots: z.number().int().min(1).optional(),
  }),
  z.object({ type: z.literal('door'), id: Id, height: z.number().int().min(1), openWhen: z.array(Id).min(1) }),
  z.object({ type: z.literal('lever'), id: Id, mode: z.enum(['toggle', 'hold']), startsOn: z.boolean().optional() }),
  z.object({ type: z.literal('coin') }),
  z.object({ type: z.literal('exit'), id: Id, slots: z.number().int().min(1) }),
]);

export const LevelFileSchema = z.object({
  $comment: z.string().optional(),
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  /** "cooperative" means no single bot may be able to finish it (checked by the validator). */
  tags: z.array(z.string()).default([]),
  /**
   * puzzle: has a goal and a solution the validator replays.
   * practice: a risk-free room to explore; no goal, it just lasts its rounds.
   */
  kind: z.enum(['puzzle', 'practice']).default('puzzle'),
  /** How many rounds the bots get in this level. */
  rounds: z.number().int().min(1).max(100).default(12),
  map: z.array(z.string()).min(3),
  key: z.record(z.string().length(1), KeyEntrySchema).default({}),
  goal: z.object({ botsThrough: z.number().int().min(1) }).optional(),
  /** A known way to finish the level: per round, each bot's command queue. The validator replays it. */
  solution: z.array(z.record(z.string(), z.array(z.string()).max(MAX_SLOTS))).default([]),
  notes: z.string().optional(),
});
export type LevelFile = z.infer<typeof LevelFileSchema>;
/** A level file as written by hand: fields with defaults (kind, rounds, tags, ...) may be left out. */
export type LevelFileInput = z.input<typeof LevelFileSchema>;

/** Tile coordinates: column tx from the left, row ty from the bottom. */
export interface CrateDef { id: string; tx: number; ty: number; weight: number } // weight in thousandths of a bot
export interface PlateDef { id: string; tx: number; ty: number; width: number; minWeight: number | null; minBots: number | null }
export interface DoorDef { id: string; tx: number; ty: number; height: number; openWhen: string[] }
export interface LeverDef { id: string; tx: number; ty: number; mode: 'toggle' | 'hold'; startsOn: boolean }
export interface CoinDef { id: string; tx: number; ty: number }
export interface ExitDef { id: string; tx: number; ty: number; slots: number }

export interface Level {
  id: string;
  name: string;
  description: string;
  tags: string[];
  cooperative: boolean;
  kind: 'puzzle' | 'practice';
  rounds: number;
  width: number;
  height: number;
  /** One tile code per cell; index (ty * width + tx). Shared by every world built from this level, never changed. */
  tiles: Uint8Array;
  spawns: Record<string, { tx: number; ty: number }>;
  crates: CrateDef[];
  plates: PlateDef[];
  doors: DoorDef[];
  levers: LeverDef[];
  coins: CoinDef[];
  exits: ExitDef[];
  /** Null for practice rooms, which have no goal. */
  goal: { botsThrough: number } | null;
  solution: Record<string, string[]>[];
  /** The picture from the file, for display. */
  map: string[];
}

/** The tile at a cell. Everything outside the level counts as solid, so the edges are always walls. */
export function tileAt(level: Level, tx: number, ty: number): Tile {
  if (tx < 0 || ty < 0 || tx >= level.width || ty >= level.height) return TILE.SOLID;
  return (level.tiles[ty * level.width + tx] ?? TILE.SOLID) as Tile;
}

/** A ladder's top tile works like a one-way platform: you can stand on it. */
export function isLadderTop(level: Level, tx: number, ty: number): boolean {
  return tileAt(level, tx, ty) === TILE.LADDER && tileAt(level, tx, ty + 1) !== TILE.LADDER;
}

/** Turn a checked level file into a Level, or throw listing every problem found. */
export function parseLevel(file: LevelFile): Level {
  const problems: string[] = [];
  const height = file.map.length;
  const width = file.map[0]?.length ?? 0;
  const tiles = new Uint8Array(width * height);
  const level: Level = {
    id: file.id,
    name: file.name,
    description: file.description,
    tags: file.tags,
    cooperative: file.tags.includes('cooperative'),
    kind: file.kind,
    rounds: file.rounds,
    width,
    height,
    tiles,
    spawns: {},
    crates: [],
    plates: [],
    doors: [],
    levers: [],
    coins: [],
    exits: [],
    goal: file.goal ?? null,
    solution: file.solution,
    map: file.map,
  };
  const entityCells = new Set<number>();
  const charCount = new Map<string, number>();

  for (let r = 0; r < height; r++) {
    const row = file.map[r] ?? '';
    if (row.length !== width) problems.push(`row ${r + 1} is ${row.length} characters long, but the first row is ${width}`);
    const ty = height - 1 - r;
    for (let tx = 0; tx < width; tx++) {
      const ch = row[tx] ?? '.';
      const terrain = TERRAIN[ch];
      if (terrain !== undefined) {
        tiles[ty * width + tx] = terrain;
        continue;
      }
      entityCells.add(ty * width + tx); // entities stand in empty tiles
      const where = `column ${tx + 1}, row ${r + 1}`;
      if (SPAWN.test(ch)) {
        if (level.spawns[ch]) problems.push(`bot ${ch} has two starting tiles`);
        level.spawns[ch] = { tx, ty };
        continue;
      }
      const entry = file.key[ch];
      if (!entry) {
        problems.push(`unknown character "${ch}" at ${where}: add it to "key"`);
        continue;
      }
      charCount.set(ch, (charCount.get(ch) ?? 0) + 1);
      switch (entry.type) {
        case 'crate':
          level.crates.push({ id: entry.id, tx, ty, weight: Math.round(entry.weight * MILLI) });
          break;
        case 'plate':
          if (entry.minWeight === undefined && entry.minBots === undefined) {
            problems.push(`plate ${entry.id} needs minWeight or minBots`);
          }
          level.plates.push({
            id: entry.id,
            tx,
            ty,
            width: entry.width ?? 1,
            minWeight: entry.minWeight === undefined ? null : Math.round(entry.minWeight * MILLI),
            minBots: entry.minBots ?? null,
          });
          break;
        case 'door':
          level.doors.push({ id: entry.id, tx, ty, height: entry.height, openWhen: entry.openWhen });
          break;
        case 'lever':
          level.levers.push({ id: entry.id, tx, ty, mode: entry.mode, startsOn: entry.startsOn ?? false });
          break;
        case 'coin':
          level.coins.push({ id: `$${level.coins.length + 1}`, tx, ty });
          break;
        case 'exit':
          level.exits.push({ id: entry.id, tx, ty, slots: entry.slots });
          break;
      }
    }
  }

  for (const [ch, count] of charCount) {
    if (count > 1 && file.key[ch]?.type !== 'coin') problems.push(`"${ch}" appears ${count} times; give each entity its own character`);
  }
  const ids = [...level.crates, ...level.plates, ...level.doors, ...level.levers, ...level.exits].map((e) => e.id);
  for (const id of ids) {
    if (ids.indexOf(id) !== ids.lastIndexOf(id)) problems.push(`two entities share the id ${id}`);
    if (SPAWN.test(id)) problems.push(`entity id ${id} looks like a bot's id; use two characters, like ${id}1`);
  }
  const emptyCell = (tx: number, ty: number) =>
    tileAt(level, tx, ty) === TILE.EMPTY && !entityCells.has(ty * width + tx) && ty < height;
  for (const plate of level.plates) {
    for (let i = 0; i < plate.width; i++) {
      if (tileAt(level, plate.tx + i, plate.ty - 1) !== TILE.SOLID) problems.push(`plate ${plate.id} must sit on solid floor`);
    }
  }
  const triggers = new Set([...level.plates.map((p) => p.id), ...level.levers.map((l) => l.id)]);
  for (const door of level.doors) {
    for (let i = 1; i < door.height; i++) {
      if (!emptyCell(door.tx, door.ty + i)) problems.push(`door ${door.id} needs ${door.height} empty tiles above its character`);
    }
    for (const t of door.openWhen) {
      if (!triggers.has(t)) problems.push(`door ${door.id} opens on ${t}, which is not a plate or lever`);
    }
  }
  for (const exit of level.exits) {
    if (!emptyCell(exit.tx, exit.ty + 1)) problems.push(`exit ${exit.id} needs an empty tile above it`);
  }
  const spawnCount = Object.keys(level.spawns).length;
  const slots = level.exits.reduce((n, e) => n + e.slots, 0);
  if (file.kind === 'puzzle') {
    if (!file.goal) problems.push('a puzzle level needs a goal');
    if (file.solution.length === 0) problems.push('a puzzle level needs a solution the validator can replay');
  }
  if (file.goal && file.goal.botsThrough > spawnCount) problems.push(`the goal needs ${file.goal.botsThrough} bots but there are ${spawnCount} starting tiles`);
  if (file.goal && file.goal.botsThrough > slots) problems.push(`the goal needs ${file.goal.botsThrough} bots through, but the exits only have ${slots} slots`);
  for (const round of file.solution) {
    for (const bot of Object.keys(round)) {
      if (!level.spawns[bot]) problems.push(`the solution gives commands to bot ${bot}, which has no starting tile`);
    }
  }

  if (problems.length > 0) throw new Error(`Level "${file.id}" has problems:\n- ${[...new Set(problems)].join('\n- ')}`);
  return level;
}
