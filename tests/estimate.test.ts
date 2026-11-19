import { describe, expect, it } from 'vitest';
import type { SeatPlan } from '../budget/estimate';
import { estimateCast, estimateSeat, gameCallShapes } from '../budget/estimate';
import { loadCast, loadGameConfig, loadPrices } from '../harness/config';
import { PRICES } from './helpers';

const game = loadGameConfig();
const shapes = gameCallShapes(game.estimate, game.maxTokens);
const haikuSeat: SeatPlan = { botId: 'A', model: 'claude-haiku-5-5', provider: 'anthropic', caching: 'explicit' };
const haiku = PRICES['claude-haiku-5-5']!;

describe('gameCallShapes', () => {
  it("counts the calls one bot makes in the spec's 6-level game", () => {
    const calls = Object.fromEntries(shapes.map((s) => [s.kind, s.callsPerGame]));
    expect(calls).toEqual({ turn: 216, reflection: 6, diary: 6, finalMessage: 1 });
  });
});

describe('estimateSeat', () => {
  it("puts a Haiku seat near the spec's ~$0.12 a game", () => {
    const e = estimateSeat(haikuSeat, haiku, shapes, 10);
    // Worked out by hand, in millionths of a dollar:
    //   turns       216 x (1800x0.10 + 400x0.50) + 206 cache reads x 5000x0.01 + 10 writes x 5000x0.125 = 98,630
    //   reflections   6 x (3000x0.10 + 1000x0.50) + 6 x 5000x0.01                                       =  5,100
    //   diaries       6 x (1000x0.10 +  150x0.50) + 6 x 5000x0.01                                       =  1,350
    //   final         1 x (1500x0.10 +  280x0.50) + 1 x 5000x0.01                                       =    340
    expect(e.expectedUsd).toBeCloseTo(0.10542, 5);
    // Worst: every prompt at the cache-write rate, every reply at max_tokens = 248,787.5
    expect(e.worstCaseUsd).toBeCloseTo(0.2487875, 6);
    expect(e.calls).toBe(229);
  });

  it("doesn't count on caching below the model's minimum prefix", () => {
    const short = shapes.map((s) => ({ ...s, cacheableTokens: 100 }));
    const e = estimateSeat(haikuSeat, haiku, short, 10);
    expect(e.notes.join(' ')).toMatch(/minimum/);
    const uncached = estimateSeat({ ...haikuSeat, caching: 'none' }, haiku, shapes, 10);
    expect(e.expectedUsd).toBeCloseTo(uncached.expectedUsd, 12);
  });

  it("prices an OpenRouter seat's worst case at its ceiling, and its expected cost at the listed price", () => {
    const listed = { provider: 'openrouter' as const, input: 0.09, output: 0.18, cacheRead: 0.018 };
    const seat: SeatPlan = { botId: 'D', model: 'm', provider: 'openrouter', caching: 'automatic' };
    const plain = estimateSeat(seat, listed, shapes, 10);
    const capped = estimateSeat({ ...seat, priceCeiling: { input: 0.15, output: 0.3 } }, listed, shapes, 10);
    expect(capped.expectedUsd).toBeCloseTo(plain.expectedUsd, 12);
    expect(capped.worstCaseUsd).toBeGreaterThan(plain.worstCaseUsd);
  });
});

describe('estimateCast', () => {
  it('adds up seats and providers; mock seats are free', () => {
    const est = estimateCast(
      [haikuSeat, { ...haikuSeat, botId: 'B' }, { botId: 'M', model: 'mock', provider: 'mock', caching: 'none' }],
      PRICES,
      shapes,
      10,
    );
    expect(est.expectedUsd).toBeCloseTo(2 * 0.10542, 5);
    expect(est.byProvider.anthropic?.expectedUsd).toBeCloseTo(2 * 0.10542, 5);
    expect(est.seats[2]?.expectedUsd).toBe(0);
  });

  it("keeps the default cast's expected game under the run cap", () => {
    const est = estimateCast(loadCast().seats, loadPrices().table, shapes, game.estimate.cacheWritesPerGame);
    expect(est.expectedUsd).toBeGreaterThan(0.5);
    expect(est.expectedUsd).toBeLessThan(game.budget.runCapUsd);
  });
});
