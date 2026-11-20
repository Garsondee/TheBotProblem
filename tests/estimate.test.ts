import { describe, expect, it } from 'vitest';
import type { SeatPlan } from '../budget/estimate';
import { estimateCast, estimateSeat, gameCallShapes } from '../budget/estimate';
import { loadCast, loadGameConfig, loadPrices } from '../harness/config';
import { PRICES } from './helpers';

const game = loadGameConfig();
// The spec's own assumptions, pinned here so the hand-worked sums below test the arithmetic,
// however config/game.json is later calibrated to measured games.
const SPEC_ASSUMPTIONS = { ...game.estimate, turnOutputTokens: 400, reflectionOutputTokens: 1000, diaryOutputTokens: 150, finalMessageOutputTokens: 280 };
const SPEC_MAX_TOKENS = { turn: 450, reflection: 1500, diary: 200, finalMessage: 350 };
const shapes = gameCallShapes(SPEC_ASSUMPTIONS, SPEC_MAX_TOKENS);
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

  it('counts a provider’s own caching at its measured share, in the expected cost only', () => {
    const listed = { provider: 'openrouter' as const, input: 0.25, output: 1.5, cacheRead: 0.025 };
    const seat: SeatPlan = { botId: 'E', model: 'm', provider: 'openrouter', caching: 'automatic' };
    const plain = estimateSeat(seat, listed, shapes, 10);
    const measured = estimateSeat({ ...seat, measuredCacheShare: 0.4 }, listed, shapes, 10);
    // 40% of every prompt token moves from $0.25 to $0.025 a million.
    const promptTokens = shapes.reduce((n, s) => n + s.callsPerGame * s.promptTokens, 0);
    expect(plain.expectedUsd - measured.expectedUsd).toBeCloseTo((promptTokens * 0.4 * (0.25 - 0.025)) / 1e6, 2);
    expect(measured.worstCaseUsd).toBe(plain.worstCaseUsd);
    expect(measured.notes.join(' ')).toMatch(/40%/);
  });

  it("counts prompts in the model's own tokens for the expected cost, and Claude's (the larger) for the worst case", () => {
    const listed = { provider: 'openrouter' as const, input: 0.25, output: 1.5 };
    const seat: SeatPlan = { botId: 'E', model: 'm', provider: 'openrouter', caching: 'none' };
    const plain = estimateSeat(seat, listed, shapes, 10);
    const own = estimateSeat({ ...seat, tokenRatio: 0.64 }, listed, shapes, 10);
    const promptUsd = shapes.reduce((n, s) => n + s.callsPerGame * s.promptTokens, 0) * 0.25 / 1e6;
    expect(plain.expectedUsd - own.expectedUsd).toBeCloseTo(promptUsd * 0.36, 3);
    expect(own.worstCaseUsd).toBe(plain.worstCaseUsd);
  });

  it('prices calls that can never read the cache as writing it every time', () => {
    const fresh = shapes.map((s) => (s.kind === 'reflection' ? { ...s, freshCache: true } : s));
    const usual = estimateSeat(haikuSeat, haiku, shapes, 10);
    const always = estimateSeat(haikuSeat, haiku, fresh, 10);
    // 6 reflections move their 5,000 cached tokens from a read ($0.01) to a write ($0.125).
    expect(always.expectedUsd - usual.expectedUsd).toBeCloseTo((6 * 5000 * (0.125 - 0.01)) / 1e6, 6);
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
