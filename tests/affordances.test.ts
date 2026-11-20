import { describe, expect, it } from 'vitest';
import { UNITS_PER_TILE as T } from '../engine/constants';
import type { Target } from '../engine/affordances';
import { affordances, aloneWith, searchPlans } from '../engine/affordances';
import { NOMINAL_STATS } from '../engine/stats';
import { measuredJumps, QUESTIONS, sceneWorld } from '../prompts/formatTest';
import { makeLevel, startWorld } from './engineHelpers';

describe('affordances', () => {
  it('find the shortest plan to a ledge, and say when a place is out of reach', () => {
    const level = makeLevel([
      '##############',
      '#............#',
      '#............#',
      '#............#',
      '#.A......###.#',
      '#.......####x#',
      '##############',
    ]);
    const targets: Target[] = [
      { id: 'low', kind: 'surface', x0: 8 * T, x1: 9 * T, y: 2 * T }, // 1 tile up
      { id: 'high', kind: 'surface', x0: 9 * T, x1: 12 * T, y: 3 * T }, // 2 tiles up, via the low step
      { id: 'sky', kind: 'surface', x0: 1 * T, x1: 13 * T, y: 9 * T }, // nothing up there
    ];
    const { reaches } = affordances(startWorld(level), 'A', targets);
    const by = Object.fromEntries(reaches.map((r) => [r.id, r]));
    expect(by.low?.reachable).toBe(true);
    expect(by.high?.reachable).toBe(true);
    expect(by.sky).toEqual({ id: 'sky', reachable: false, plan: null });
  });

  it('count only what a bot can do alone: standing on a bot is help, even a bot that never moves', () => {
    // A wall 3 tiles high with bot B standing in front of it: A can only get up there via B's head.
    const level = makeLevel([
      '##############',
      '#............#',
      '#............#',
      '#............#',
      '#.........x..#',
      '#........#####',
      '#........#####',
      '#.A.....B#####',
      '##############',
    ]);
    const top: Target[] = [{ id: 'top', kind: 'surface', x0: 9 * T, x1: 13 * T, y: 4 * T }];
    const world = startWorld(level);
    expect(affordances(world, 'A', top).reaches[0]?.reachable).toBe(false);
    // The engine can still see the cooperative route when B is left in the world.
    // It is real, just not listed for the bots: they have to discover it.
    expect(searchPlans(world, 'A', top, { maxDepth: 4 }).reaches[0]?.reachable).toBe(true);
    expect(aloneWith(world, 'A').bots.map((b) => b.id)).toEqual(['A']);
    expect(aloneWith(world, 'A').bots[0]?.stats).toEqual(NOMINAL_STATS);
  });
});

describe('the format-test scene', () => {
  it('has the answer key the test was designed around: five places reachable alone, five not', () => {
    const key = affordances(sceneWorld(), 'A', QUESTIONS.map((q) => q.target), { maxDepth: 6, maxStates: 8000 });
    const yes = key.reaches.filter((r) => r.reachable).map((r) => r.id);
    expect(yes).toEqual(['1', '2', '4', '5', 'V1']);
  });

  it('quotes jump distances the engine actually produces', () => {
    const j = measuredJumps();
    expect(j.standingFull).toBeCloseTo(3.2, 0);
    expect(j.runUpFull).toBeGreaterThan(4.4);
    expect(j.runUpFull).toBeLessThan(5);
    expect(j.standingShort).toBeLessThan(j.standingFull);
  });
});
