/**
 * The move menu (engine/moves.ts): single moves, predicted honestly. Each
 * test here guards one of the rules that keep a prediction from telling a
 * bot more than it can know.
 */
import { describe, expect, it } from 'vitest';
import { moveMenu, predictionWorld } from '../engine/moves';
import { perceive } from '../engine/sight';
import { extremeStats, NOMINAL_STATS } from '../engine/stats';
import { loadGameConfig } from '../harness/config';
import { makeLevel, startWorld } from './engineHelpers';

const ranges = loadGameConfig().hiddenStats;
const menuOf = (world: Parameters<typeof perceive>[0], id: string) => moveMenu(world, id, perceive(world, id));
const commands = (world: Parameters<typeof perceive>[0], id: string) => menuOf(world, id).map((m) => m.command);

describe('the move menu', () => {
  // A 2-tile ledge to the right of A.
  const ledge = makeLevel([
    '##############',
    '#............#',
    '#............#',
    '#............#',
    '#......###...#',
    '#.A....###.x.#',
    '##############',
  ]);

  it('predicts a jump onto a ledge, with where it lands and how far up', () => {
    const menu = menuOf(startWorld(ledge), 'A');
    const up = menu.find((m) => m.rise === 20_000);
    expect(up, JSON.stringify(menu)).toBeDefined();
    expect(up?.command).toMatch(/^jump\(right, run_up=\d, hold=full\)$/);
    expect(up?.on).toBe('solid ground');
  });

  it("uses a standard bot's numbers: the menu is the same whatever the bot's hidden stats are", () => {
    const weak = extremeStats(ranges, { runSpeed: -1, jumpHeight: -1, jumpDistance: -1, weight: -1, strength: -1, sightRange: 1 });
    const strong = extremeStats(ranges, { runSpeed: 1, jumpHeight: 1, jumpDistance: 1, weight: 1, strength: 1, sightRange: 1 });
    const strongSight = { ...NOMINAL_STATS, sightRange: strong.sightRange };
    expect(menuOf(startWorld(ledge, { A: weak }), 'A')).toEqual(menuOf(startWorld(ledge, { A: strongSight }), 'A'));
    expect(menuOf(startWorld(ledge, { A: strong }), 'A')).toEqual(menuOf(startWorld(ledge, { A: strongSight }), 'A'));
  });

  it('predicts in a world holding only what the viewer sees, with everyone at standard stats', () => {
    // B is in sight; C and crate C1 are behind a wall.
    const walled = makeLevel(
      ['################', '#.......#......#', '#.......#......#', '#.......#......#', '#.......#......#', '#.A..B..#.c.Cx.#', '################'],
      { c: { type: 'crate', id: 'C1', weight: 1 } },
    );
    const strong = extremeStats(ranges, { runSpeed: 1, jumpHeight: 1, jumpDistance: 1, weight: 1, strength: 1, sightRange: 1 });
    const world = startWorld(walled, { A: strong, B: strong, C: strong });
    const seen = perceive(world, 'A');
    expect(seen.bots).toEqual(['B']);
    expect(seen.crates).toEqual([]);
    const known = predictionWorld(world, 'A', seen);
    expect(known.bots.map((b) => b.id)).toEqual(['A', 'B']);
    expect(known.crates).toEqual([]);
    for (const b of known.bots) expect(b.stats).toEqual(NOMINAL_STATS);
    // So the menu is the same as in a room where C and the crate don't exist.
    const empty = startWorld(makeLevel(walled.map.map((row) => row.replace('c', '.').replace('C', '.'))), { A: strong, B: strong });
    expect(menuOf(world, 'A')).toEqual(menuOf(empty, 'A'));
  });

  it('only lists moves whose whole path stays in sight', () => {
    // A long corridor: walking to its far end goes out of sight (about 10 tiles), so it is not predicted.
    const corridor = makeLevel(['#' + '#'.repeat(30) + '#', '#' + '.'.repeat(30) + '#', '#' + '.'.repeat(30) + '#', '#.A' + '.'.repeat(26) + 'x.#', '#'.repeat(32)]);
    const list = commands(startWorld(corridor), 'A');
    expect(list).toContain('walk_to_edge(left)');
    expect(list).not.toContain('walk_to_edge(right)');
  });

  it('predicts movement only: never levers, plates, exits or pushes', () => {
    const room = makeLevel(
      ['##############', '#............#', '#............#', '#.A.v.p.c..x.#', '##############'],
      { v: { type: 'lever', id: 'V1', mode: 'toggle' }, p: { type: 'plate', id: 'P1', minBots: 1 }, c: { type: 'crate', id: 'C1', weight: 0.8 } },
    );
    for (const c of commands(startWorld(room), 'A')) expect(c).toMatch(/^(walk|walk_to|walk_to_edge|jump|climb|drop)\b/);
  });

  it('lists each landing spot once, and never "stay where you are"', () => {
    const menu = menuOf(startWorld(ledge), 'A');
    const spots = menu.map((m) => `${Math.round(m.to.x / 2500)}|${m.to.y}|${m.on}`);
    expect(new Set(spots).size).toBe(spots.length);
    const a = startWorld(ledge).bots[0];
    for (const m of menu) expect(m.to.x === (a?.x ?? 0) + 3750 && m.rise === 0).toBe(false);
  });
});
