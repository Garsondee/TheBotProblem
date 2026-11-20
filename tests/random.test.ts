import { describe, expect, it } from 'vitest';
import { Rng, RunRandom } from '../engine/random';
import { NOMINAL_STATS, rollStats } from '../engine/stats';

describe('seeded randomness', () => {
  it('gives the same numbers for the same seed, every time', () => {
    const a = new Rng('seed-1');
    const b = new Rng('seed-1');
    const draws = Array.from({ length: 5 }, () => a.next());
    expect(Array.from({ length: 5 }, () => b.next())).toEqual(draws);
    // Locks the algorithm: if these change, every saved replay and fork would stop matching.
    expect(draws.map((d) => d.toFixed(6))).toMatchSnapshot();
  });

  it('keeps named streams independent, so using one never shifts another', () => {
    const plain = new RunRandom('run').stream('stats');
    const statsFirst = Array.from({ length: 3 }, () => plain.next());

    const busy = new RunRandom('run');
    for (let i = 0; i < 100; i++) busy.stream('roles').next(); // lots of role draws first
    expect(Array.from({ length: 3 }, () => busy.stream('stats').next())).toEqual(statsFirst);
  });

  it('gives different streams different numbers', () => {
    const r = new RunRandom('run');
    expect(r.stream('stats').next()).not.toBe(r.stream('rumours').next());
  });

  it('keeps whole numbers within bounds, and shuffles without losing anything', () => {
    const r = new Rng('bounds');
    for (let i = 0; i < 1000; i++) {
      const n = r.int(3, 6);
      expect(n).toBeGreaterThanOrEqual(3);
      expect(n).toBeLessThanOrEqual(6);
    }
    expect(r.shuffle([1, 2, 3, 4, 5]).sort()).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('hidden stats', () => {
  it('stay within their configured ranges', () => {
    const r = new Rng('stats');
    const ranges = { runSpeed: 0.06, jumpHeight: 0.08, jumpDistance: 0.08, weight: 0.15, strength: 0.15, sightRange: 0.1 };
    for (let i = 0; i < 200; i++) {
      const s = rollStats(r, ranges);
      for (const [name, range] of Object.entries(ranges)) {
        const v = s[name as keyof typeof s];
        expect(Math.abs(v - 1000)).toBeLessThanOrEqual(Math.round(range * 1000));
      }
    }
    expect(NOMINAL_STATS.runSpeed).toBe(1000);
  });
});
