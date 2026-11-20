/**
 * Milestone 2: the interface format test (spec section 6).
 *
 *   "Before building the full game, test which view format bots understand.
 *   Use one precision puzzle rendered three ways: tile ASCII only, numbers
 *   plus affordances, and a rendered PNG frame with a coordinate grid. Ask
 *   Haiku 10 questions with known answers ("Can you reach X alone? What
 *   would you need?") and score each format."
 *
 * The puzzle is one scene with ten marked places. Each question asks bot A
 * whether it can get to one of them alone. The right answers aren't written
 * by hand: the engine works them out by trying (engine/affordances.ts) with
 * the rulebook's nominal stats, so the answer key always agrees with the
 * physics. When a bot says "yes", its plan is played in the engine too: a
 * right answer with a plan that doesn't work only half counts.
 *
 * This scene is a measuring stick, not a game level, so bot B stands where it
 * can't be used as a step: "can you get there alone?" must have one answer.
 * (In real levels, unplanned cooperation like that is a feature.)
 */
import { z } from 'zod';
import type { Target } from '../engine/affordances';
import { COMMAND_HELP } from '../engine/commands';
import { UNITS_PER_TILE as T } from '../engine/constants';
import type { LevelFile } from '../engine/level';
import { LevelFileSchema, parseLevel } from '../engine/level';
import { initWorld } from '../engine/physics';
import { renderWorld } from '../engine/render';
import { resolvePhase } from '../engine/resolve';
import { NOMINAL_STATS } from '../engine/stats';
import type { World } from '../engine/world';
import { feet, tiles } from '../engine/world';

export type FormatName = 'ascii' | 'numbers' | 'png';
export const FORMATS: readonly FormatName[] = ['ascii', 'numbers', 'png'];

/** A digit drawn in an empty tile, naming the surface just below it. */
export interface Label {
  ch: string;
  tx: number;
  ty: number;
}

export interface Question {
  id: string;
  target: Target;
  /** How the question names the place: the same words in every format. */
  place: string;
}

const W = 40;
const H = 22;
const tile = (n: number) => n * T;

/** The scene, drawn with rectangles (x0, y0, x1, y1 inclusive, in tiles, y up). */
function drawScene(): string[] {
  const g: string[][] = Array.from({ length: H }, () => Array<string>(W).fill('.'));
  const fill = (x0: number, y0: number, x1: number, y1: number, ch: string) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) (g[y] as string[])[x] = ch;
  };
  const put = (x: number, y: number, ch: string) => ((g[y] as string[])[x] = ch);
  fill(0, 0, W - 1, 1, '#'); // the ground: its top is at y = 2
  fill(0, H - 1, W - 1, H - 1, '#');
  fill(0, 0, 0, H - 1, '#');
  fill(W - 1, 0, W - 1, H - 1, '#');
  // Left: a cliff 3 tiles high, a ledge 2 high, a ledge 1 high.
  fill(1, 2, 3, 4, '#');
  fill(11, 2, 12, 3, '#');
  fill(15, 2, 15, 2, '#');
  // Out of everyone's reach: a high shelf, and a closed room (walls on every side).
  fill(12, 7, 14, 7, '#');
  fill(4, 10, 8, 10, '#');
  fill(4, 14, 8, 14, '#');
  fill(4, 10, 4, 14, '#');
  fill(8, 10, 8, 14, '#');
  // Right: a one-way platform overhead, a ladder up to a shelf with a lever, two pits.
  fill(20, 3, 22, 3, '-');
  fill(24, 2, 24, 6, '=');
  fill(22, 6, 23, 6, '#');
  put(22, 7, 'v');
  fill(25, 1, 27, 1, '.'); // pit 1: 3 wide, 1 deep
  fill(31, 1, 35, 1, '.'); // pit 2: 5 wide, 1 deep
  fill(36, 2, 38, 3, '#'); // the far landing, 2 tiles above the ground
  put(33, 6, '$'); // a coin, high above pit 2
  put(38, 4, 'x');
  put(19, 2, 'A');
  put(37, 4, 'B'); // on the far landing, where it can't be used as a step
  return g.reverse().map((row) => row.join(''));
}

export const SCENE: LevelFile = {
  id: 'format-test',
  name: 'Format test',
  description: 'One scene with ten marked places, for the interface format test.',
  tags: [],
  map: drawScene(),
  key: {
    v: { type: 'lever', id: 'V1', mode: 'toggle' },
    $: { type: 'coin' },
    x: { type: 'exit', id: 'X', slots: 5 },
  },
  goal: { botsThrough: 1 },
  solution: [{}],
};

/** The scene's starting world: A and B with nominal stats. */
export function sceneWorld(): World {
  return initWorld(parseLevel(LevelFileSchema.parse(SCENE)), { A: NOMINAL_STATS, B: NOMINAL_STATS });
}

/** Marks drawn on the ASCII and PNG views. The lever and coin show as themselves. */
export const LABELS: Label[] = [
  { ch: '1', tx: 15, ty: 3 },
  { ch: '2', tx: 11, ty: 4 },
  { ch: '3', tx: 2, ty: 5 },
  { ch: '4', tx: 21, ty: 4 },
  { ch: '5', tx: 29, ty: 2 },
  { ch: '6', tx: 36, ty: 4 },
  { ch: '9', tx: 13, ty: 8 },
  { ch: '0', tx: 6, ty: 11 },
];

export const QUESTIONS: Question[] = [
  { id: 'Q1', place: 'the top of ledge 1 (marked 1)', target: { id: '1', kind: 'surface', x0: tile(15), x1: tile(16), y: tile(3) } },
  { id: 'Q2', place: 'the top of ledge 2 (marked 2)', target: { id: '2', kind: 'surface', x0: tile(11), x1: tile(13), y: tile(4) } },
  { id: 'Q3', place: 'the top of the cliff (marked 3)', target: { id: '3', kind: 'surface', x0: tile(1), x1: tile(4), y: tile(5) } },
  { id: 'Q4', place: 'the top of the one-way platform (marked 4)', target: { id: '4', kind: 'surface', x0: tile(20), x1: tile(23), y: tile(4) } },
  { id: 'Q5', place: 'the landing marked 5, across the first pit', target: { id: '5', kind: 'surface', x0: tile(28), x1: tile(31), y: tile(2) } },
  { id: 'Q6', place: 'the landing marked 6, across the second pit', target: { id: '6', kind: 'surface', x0: tile(36), x1: tile(39), y: tile(4) } },
  { id: 'Q7', place: 'close enough to lever V1 to pull it', target: { id: 'V1', kind: 'lever', entity: 'V1' } },
  { id: 'Q8', place: 'the coin $ (touching it collects it)', target: { id: '$1', kind: 'coin', entity: '$1' } },
  { id: 'Q9', place: 'the top of the high shelf (marked 9)', target: { id: '9', kind: 'surface', x0: tile(12), x1: tile(15), y: tile(8) } },
  { id: 'Q10', place: 'the floor inside the closed room (marked 0)', target: { id: '0', kind: 'surface', x0: tile(5), x1: tile(8), y: tile(11) } },
];

/** How far nominal jumps really carry a bot on flat ground, measured in the engine (tiles, one decimal). */
export function measuredJumps(): { standingFull: number; standingShort: number; runUpFull: number; runUpShort: number } {
  const map = ['#'.repeat(60), ...Array.from({ length: 8 }, () => '#' + '.'.repeat(58) + '#'), '#.A' + '.'.repeat(54) + 'x.#', '#'.repeat(60)];
  const level = parseLevel(
    LevelFileSchema.parse({ id: 'flat', name: 'flat', description: '', map, key: { x: { type: 'exit', id: 'X', slots: 1 } }, goal: { botsThrough: 1 }, solution: [{}] }),
  );
  const start = initWorld(level, { A: NOMINAL_STATS });
  const carry = (command: string, runUp: number) => {
    const end = resolvePhase(start, { A: [command] }, { trace: false }).world.bots[0];
    const begin = start.bots[0];
    if (!end || !begin) throw new Error('flat test level lost its bot');
    return Math.round(((end.x - begin.x) / T - runUp) * 10) / 10;
  };
  return {
    standingFull: carry('jump(right, run_up=0, hold=full)', 0),
    standingShort: carry('jump(right, run_up=0, hold=short)', 0),
    runUpFull: carry('jump(right, run_up=3, hold=full)', 3),
    runUpShort: carry('jump(right, run_up=3, hold=short)', 3),
  };
}

let cachedRules: string | null = null;

/** The rules, the same in every format, kept byte-stable so they can be cached. */
export function rules(): string {
  if (cachedRules) return cachedRules;
  const j = measuredJumps();
  cachedRules = `You are bot A in a 2D platform game, seen from the side. Everything is measured in tiles.

How the world works:
- x grows to the right and y grows UP. A bot's position is where its feet are: the middle of its bottom edge.
- Bots are 0.75 tiles wide and 1.5 tiles tall. You can't pass through other bots.
- Solid tiles can't be passed. One-way platforms can be jumped up through from below and stood on; "drop" falls back through. Ladders are climbed with climb(up) and climb(down); you can stand on a ladder's top.
- Running: up to 6 tiles a second. It takes 2.5 tiles of running to reach full speed.
- Jumping: a full jump lifts your feet 2.2 tiles; a short jump 1.0 tile. Hitting a ceiling ends the rise.
- You steer in the air. On flat ground a full jump from a standstill carries you about ${j.standingFull} tiles sideways (a short one about ${j.standingShort}); after a full 3-tile run-up, a full jump carries you about ${j.runUpFull} tiles (a short one about ${j.runUpShort}).
- So a ledge can be reached by jumping only if its top is at most 2.2 tiles above your feet, and a pit can be crossed only if a jump carries you all the way over it.
- Standing on another bot's head lifts your feet by 1.5 tiles.

Commands (play up to 6 in order, each starting where the last one ended):
${Object.values(COMMAND_HELP)
  .map((line) => `- ${line}`)
  .join('\n')}

You will get one question about the scene below. Answer with one JSON object:
- "thought": your brief reasoning, at most 60 words.
- "reachable": true if you, alone, starting from where you stand now, can get there; false if not.
- "commands": if reachable, the commands that get you there, in order (at most 6); otherwise [].
- "need": if not reachable, one short sentence saying what you would need; otherwise "".`;
  return cachedRules;
}

/** The JSON schema both providers enforce. The same shape is checked again on our side (AnswerSchema). */
export const ANSWER_JSON_SCHEMA = {
  type: 'object',
  properties: {
    thought: { type: 'string' },
    reachable: { type: 'boolean' },
    commands: { type: 'array', items: { type: 'string' } },
    need: { type: 'string' },
  },
  required: ['thought', 'reachable', 'commands', 'need'],
  additionalProperties: false,
};

export const AnswerSchema = z.object({
  thought: z.string(),
  reachable: z.boolean(),
  commands: z.array(z.string()),
  need: z.string(),
});
export type Answer = z.infer<typeof AnswerSchema>;

export function questionText(q: Question): string {
  return `Question ${q.id}: can you get to ${q.place}?`;
}

const LEGEND =
  'Legend: # solid tile, . empty, - one-way platform, H ladder, A you (bot A), B another bot, l lever V1, $ coin, X exit. ' +
  'The digits 0-9 mark places the questions ask about; each digit sits in the empty tile just above the surface it names.';

/** Format 1: tile ASCII only. No numbers: the map is all there is. */
export function asciiView(world: World): string {
  const rows = renderWorld(world);
  for (const l of LABELS) {
    const r = world.level.height - 1 - l.ty;
    const row = rows[r];
    if (row) rows[r] = row.slice(0, l.tx) + l.ch + row.slice(l.tx + 1);
  }
  return ['The scene, one character per tile, the top row highest:', '', ...rows, '', LEGEND].join('\n');
}

/** Format 3's words. The picture itself comes as an image (harness/png.ts). */
export function pngView(): string {
  return [
    'The scene is in the attached image: a side view, one square per tile.',
    'The numbers along the bottom and left edges are tile coordinates: x along the bottom, y up the left side, (0, 0) at the bottom-left corner.',
    'Bots are drawn at their exact positions: you are the blue A, the grey B is another bot.',
    'Solid tiles are dark; one-way platforms are thin brown bars; the ladder has rungs; the lever is a short red stick; the coin is gold; the exit is green.',
    'The white digits mark the places the questions ask about; each sits just above the surface it names.',
  ].join('\n');
}

/**
 * Format 2: exact numbers plus affordances. `reach` maps each question's
 * target to the engine's plan (or null: not reachable alone). Affordances
 * are part of this format, as the spec intends, so that bots don't have to
 * do physics arithmetic.
 */
export function numbersView(world: World, reach: ReadonlyMap<string, string[] | null>): string {
  const a = world.bots.find((b) => b.id === 'A');
  const b = world.bots.find((x) => x.id === 'B');
  const coin = world.level.coins[0];
  const lever = world.level.levers[0];
  const exit = world.level.exits[0];
  if (!a || !b || !coin || !lever || !exit) throw new Error('The format scene is missing something.');
  const t = (units: number) => tiles(units);
  const half = T / 2;
  const lines = [
    `You are bot A. Your feet are at x=${t(feet(a).x)}, y=${t(feet(a).y)}, on the ground.`,
    `Bot B's feet are at x=${t(feet(b).x)}, y=${t(feet(b).y)}, on the far landing (6).`,
    '',
    'The ground: its top is at y=2.00 all the way from x=1.00 to x=38.00, except two pits:',
    '  pit 1 from x=25.00 to x=28.00 (3 tiles wide), floor at y=1.00;',
    '  pit 2 from x=31.00 to x=36.00 (5 tiles wide), floor at y=1.00.',
    '',
    'Places (each is the top surface of something solid; exact edges):',
    '  1: ledge 1, top at y=3.00, from x=15.00 to x=16.00 (1 tile above the ground)',
    '  2: ledge 2, top at y=4.00, from x=11.00 to x=13.00 (2 tiles above the ground)',
    '  3: the cliff, top at y=5.00, from x=1.00 to x=4.00 (3 tiles above the ground)',
    '  4: a one-way platform, top at y=4.00, from x=20.00 to x=23.00 (2 tiles above the ground)',
    '  5: the landing between the pits, top at y=2.00, from x=28.00 to x=31.00',
    '  6: the far landing, top at y=4.00, from x=36.00 to x=39.00 (2 tiles above the ground)',
    '  9: the high shelf, top at y=8.00, from x=12.00 to x=15.00 (6 tiles above the ground)',
    '  0: the floor of a closed room, top at y=11.00, from x=5.00 to x=8.00; walls enclose the room on every side (x=4.00 to 9.00, y=10.00 to 15.00)',
    '',
    'Other things:',
    '  a ladder from x=24.00 to x=25.00, from y=2.00 up to y=7.00 (you can stand on its top)',
    `  a shelf, top at y=7.00, from x=22.00 to x=24.00, beside the ladder's top; lever V1 stands on it at x=${t(lever.tx * T + half)}`,
    `  the coin $ hangs at x=${t(coin.tx * T + half)}, y=${t(coin.ty * T + half)} (touch it to collect it)`,
    `  the exit X stands on the far landing at x=${t(exit.tx * T + half)}`,
    '',
    'What you can reach alone. The game worked these out by trying every move with the rulebook numbers.',
    'Each plan is complete and starts from where you stand now. To get somewhere, copy its plan exactly:',
    'walking into a ledge or wall stops you, so plans use jumps and edges, not long walks.',
  ];
  for (const q of QUESTIONS) {
    const plan = reach.get(q.target.id);
    lines.push(
      plan
        ? `  ${q.place}: REACHABLE. Plan: ${plan.length === 0 ? '(you are already there)' : plan.join('; ')}`
        : `  ${q.place}: NOT reachable alone (no plan of up to 6 moves gets there)`,
    );
  }
  return lines.join('\n');
}
