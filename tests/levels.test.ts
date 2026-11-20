/**
 * Milestone 1's acceptance test (docs/SPEC.md section 9):
 *   "Solution scripts complete all levels; same seed gives an identical trace."
 * Plus the spec's level-validity rules: a solution must work with the bots'
 * real (rolled) stats, and a level tagged cooperative must be impossible for
 * one bot alone.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Level } from '../engine/level';
import { Rng, RunRandom } from '../engine/random';
import { renderWorld } from '../engine/render';
import type { BotStats, StatName } from '../engine/stats';
import { extremeStats, NOMINAL_STATS, rollStats, STAT_NAMES } from '../engine/stats';
import { rollPlayableStats, runSolution, soloCheck, validateLevel } from '../engine/validate';
import { initWorld } from '../engine/physics';
import { loadGameConfig } from '../harness/config';
import { loadLevels } from '../harness/levels';
import { makeLevel } from './engineHelpers';

const ranges = loadGameConfig().hiddenStats;
const levels = loadLevels();
const puzzles = levels.filter((l) => l.kind === 'puzzle');
const SLOW = 120_000;
const everyone = (level: Level, s: BotStats) => Object.fromEntries(Object.keys(level.spawns).map((id) => [id, s]));
const levelOne = () => {
  const l1 = levels.find((l) => l.id === 'L1-hold-the-door');
  if (!l1) throw new Error('level 1 is missing');
  return l1;
};

describe('the levels in config/levels', () => {
  it('load: a practice room first, then at least six puzzles, in play order', () => {
    expect(levels[0]?.kind).toBe('practice');
    expect(puzzles.length).toBeGreaterThanOrEqual(6);
    expect(puzzles.map((l) => l.id)).toEqual([...puzzles.map((l) => l.id)].sort());
  });

  describe('the practice room', () => {
    const room = levels[0] as Level;
    it('has no goal and no solution: it just lasts its rounds', () => {
      expect(room.goal).toBeNull();
      expect(room.solution).toEqual([]);
      expect(room.rounds).toBeGreaterThanOrEqual(1);
    });

    it('has one of every kind of element, so there is everything to discover', () => {
      const tiles = new Set(room.tiles);
      expect([...tiles].sort()).toEqual([0, 1, 2, 3]); // empty, solid, one-way platform, ladder
      expect(room.crates.length).toBeGreaterThanOrEqual(2); // one light, one too heavy for one bot
      expect(room.crates.some((c) => c.weight > 1150)).toBe(true);
      expect(room.crates.some((c) => c.weight < 850)).toBe(true);
      expect(room.plates.some((p) => p.minBots !== null)).toBe(true);
      expect(room.plates.some((p) => p.minWeight !== null)).toBe(true);
      expect(room.levers.map((l) => l.mode).sort()).toEqual(['hold', 'toggle']);
      expect(room.doors.length).toBeGreaterThanOrEqual(1);
      expect(room.coins.length).toBeGreaterThanOrEqual(1);
      expect(room.exits.length).toBeGreaterThanOrEqual(1);
    });
  });

  for (const level of puzzles) {
    describe(level.id, () => {
      it('is finished by its solution with nominal stats', () => {
        const run = runSolution(level, everyone(level, NOMINAL_STATS));
        expect(run.failures).toEqual([]);
        expect(run.completed).toBe(true);
      });

      it(
        'is finished by its solution with every extreme combination of hidden stats',
        () => {
          for (let mask = 0; mask < 1 << STAT_NAMES.length; mask++) {
            const signs = Object.fromEntries(STAT_NAMES.map((n, i) => [n, mask & (1 << i) ? 1 : -1])) as Record<StatName, 1 | -1>;
            const run = runSolution(level, everyone(level, extremeStats(ranges, signs)));
            expect(run.completed, `stat corner ${mask}: ${run.failures[0]?.reason}`).toBe(true);
          }
        },
        SLOW,
      );

      it(
        'is finished by its solution with randomly rolled stats (every bot different)',
        () => {
          const rng = new RunRandom(`tests:${level.id}`).stream('stats');
          for (let i = 0; i < 20; i++) {
            const stats = Object.fromEntries(Object.keys(level.spawns).map((id) => [id, rollStats(rng, ranges)]));
            expect(runSolution(level, stats).completed).toBe(true);
          }
        },
        SLOW,
      );

      if (level.cooperative) {
        it(
          'cannot be finished by one bot, even the most capable one the rules allow',
          () => {
            const report = validateLevel(level, everyone(level, NOMINAL_STATS), ranges);
            expect(report.problems).toEqual([]);
            expect(report.solo?.exhausted).toBe(true);
            expect(report.solo?.solvable).toBe(false);
          },
          SLOW,
        );
      }

      it('gives a byte-identical trace for the same seed, and a different one for another seed', () => {
        const traceHash = (seed: string) => {
          const rng = new RunRandom(seed).stream('stats');
          const stats = Object.fromEntries(Object.keys(level.spawns).map((id) => [id, rollStats(rng, ranges)]));
          const run = runSolution(level, stats, { trace: true });
          const record = run.rounds.map((r) => ({ results: r.results, events: r.events, trace: r.trace }));
          return createHash('sha256').update(JSON.stringify(record)).digest('hex');
        };
        expect(traceHash('seed-one')).toBe(traceHash('seed-one'));
        expect(traceHash('seed-one')).not.toBe(traceHash('seed-two'));
      });
    });
  }

  it('draws level 1 the way its file draws it', () => {
    const l1 = levelOne();
    const rows = renderWorld(initWorld(l1, everyone(l1, NOMINAL_STATS)));
    expect(rows.at(-2)).toBe('#pABCDE...$.........|..l............X..#');
  });
});

describe('the validator', () => {
  it('rejects a level whose solution fails, and says where', () => {
    const l1 = levelOne();
    const broken: Level = { ...l1, solution: [{ ...l1.solution[0], B: ['walk(right, 20)'] }, ...l1.solution.slice(1)] }; // nobody pulls the lever
    const report = validateLevel(broken, everyone(broken, NOMINAL_STATS), ranges);
    expect(report.valid).toBe(false);
    expect(report.problems[0]).toMatch(/the solution got \d of 5 bots through/);
  });

  it('rejects a "cooperative" level that one bot can finish alone, and shows how', () => {
    const easy = makeLevel(['##########', '#........#', '#........#', '#.A....x.#', '##########'], {}, {
      tags: ['cooperative'],
      solution: [{ A: ['walk_to(X)', 'enter_exit'] }],
    });
    const report = validateLevel(easy, { A: NOMINAL_STATS }, ranges);
    expect(report.valid).toBe(false);
    expect(report.problems[0]).toMatch(/one bot can finish it alone: .*enter_exit/);
    expect(soloCheck(easy, NOMINAL_STATS).path?.at(-1)).toBe('enter_exit');
  });

  it('re-rolls hidden stats until the solution works, and logs every rejected roll', () => {
    // A 4-tile gap whose far side is one tile higher: whether a bot makes it
    // depends on its hidden run speed, jump height and jump distance, so some
    // rolls fall short. (Plenty of headroom: in a low room a jump ends at the ceiling.)
    const gap = makeLevel(
      [
        '##################',
        '#................#',
        '#................#',
        '#................#',
        '#................#',
        '#...........x....#',
        '#.A......#########',
        '#####....#########',
        '##################',
      ],
      {},
      { solution: [{ A: ['walk_to_edge(right)', 'walk(left, 3)', 'jump(right, run_up=3, hold=full)', 'walk_to(X)', 'enter_exit'] }] },
    );
    let rejectedSomewhere = false;
    for (let seed = 0; seed < 20; seed++) {
      const result = rollPlayableStats(gap, ['A'], new Rng(`gap-${seed}`), ranges);
      expect(runSolution(gap, result.stats).completed).toBe(true);
      expect(result.rejected).toHaveLength(result.attempts - 1);
      if (result.rejected.length > 0) rejectedSomewhere = true;
    }
    expect(rejectedSomewhere).toBe(true);
  });

  it('gives up, with the log, on a level no roll can save', () => {
    const wall = makeLevel(['##########', '#........#', '#........#', '#.A..#.x.#', '##########'], {}, { solution: [{ A: ['walk(right, 5)'] }] });
    expect(() => rollPlayableStats(wall, ['A'], new Rng('wall'), ranges, 3)).toThrow(/no playable stats in 3 rolls[\s\S]*blocked by a wall/);
  });
});
