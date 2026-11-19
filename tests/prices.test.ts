import { describe, expect, it } from 'vitest';
import { fetchOpenRouterPrices, parseOpenRouterModels, perTokenToPerMillion } from '../budget/openrouterPrices';
import {
  assertPromptWithinLimit,
  costOfUsage,
  hardLimitProblems,
  priceOf,
  PromptTooLargeError,
  UnknownPriceError,
  worstCaseCallUsd,
  worstCasePrice,
} from '../budget/prices';
import { PRICES, usage } from './helpers';

const haiku = PRICES['claude-haiku-5-5']!;

describe('costOfUsage', () => {
  it('prices a typical cached Haiku turn call', () => {
    // 1,800 uncached + 5,000 cache-read prompt tokens, 400 output tokens:
    // 1800 x 0.10 + 5000 x 0.01 + 400 x 0.50 = 180 + 50 + 200 = 430 per million = $0.00043
    expect(costOfUsage(usage({ inputTokens: 1800, cacheReadTokens: 5000, outputTokens: 400 }), haiku)).toBeCloseTo(
      0.00043,
      12,
    );
  });

  it('charges the cache-write premium on the call that writes the cache', () => {
    // 1800 x 0.10 + 5000 x 0.125 + 400 x 0.50 = 180 + 625 + 200 = 1,005 per million
    expect(costOfUsage(usage({ inputTokens: 1800, cacheWriteTokens: 5000, outputTokens: 400 }), haiku)).toBeCloseTo(
      0.001005,
      12,
    );
  });

  it('prices 1-hour cache writes at 2x input', () => {
    // 10,000 x 0.20 per million. (Not 1,000,000 tokens: a prompt that size
    // would also trip the 5x long-context step, the next test's subject.)
    expect(costOfUsage(usage({ cacheWrite1hTokens: 10_000 }), haiku)).toBeCloseTo(0.002, 12);
  });

  it('applies the 5x long-context step above 100K prompt tokens', () => {
    expect(costOfUsage(usage({ inputTokens: 100_000 }), haiku)).toBeCloseTo(0.01, 12);
    expect(costOfUsage(usage({ inputTokens: 100_001 }), haiku)).toBeCloseTo(((100_001 * 0.1) / 1e6) * 5, 12);
  });

  it('prices unknown cache reads as full input, which overestimates rather than under', () => {
    const plain = { provider: 'openrouter' as const, input: 1, output: 2 };
    expect(costOfUsage(usage({ cacheReadTokens: 1_000_000 }), plain)).toBeCloseTo(1, 12);
  });
});

describe('worstCaseCallUsd', () => {
  it('assumes no cache hits, the dearer cache-write rate, and every max_token used', () => {
    // 6800 x 0.125 + 450 x 0.50 = 850 + 225 = 1,075 per million
    expect(worstCaseCallUsd(haiku, 6800, 450)).toBeCloseTo(0.001075, 12);
  });

  it('is never below what the call can really cost', () => {
    const real = costOfUsage(usage({ inputTokens: 1800, cacheWriteTokens: 5000, outputTokens: 450 }), haiku);
    expect(worstCaseCallUsd(haiku, 6800, 450)).toBeGreaterThanOrEqual(real);
  });

  it("uses an OpenRouter seat's price ceiling when it is above the listed price", () => {
    const listed = { provider: 'openrouter' as const, input: 0.09, output: 0.18 };
    const worst = worstCasePrice(listed, { input: 0.15, output: 0.3 });
    expect(worst).toMatchObject({ input: 0.15, output: 0.3 });
    expect(worstCasePrice(listed)).toBe(listed);
  });
});

describe('price lookups and limits', () => {
  it('says how to fix a missing price', () => {
    expect(() => priceOf(PRICES, 'no-such-model')).toThrow(UnknownPriceError);
    expect(() => priceOf(PRICES, 'no-such-model')).toThrow(/npm run prices/);
  });

  it('refuses a prompt over the hard limit, so the 5x price step is never reached', () => {
    expect(() => assertPromptWithinLimit(60_001, 60_000, 'claude-haiku-5-5')).toThrow(PromptTooLargeError);
    expect(() => assertPromptWithinLimit(60_000, 60_000, 'claude-haiku-5-5')).not.toThrow();
  });

  it('flags a hard limit that is not below a long-context step', () => {
    expect(hardLimitProblems(PRICES, 60_000)).toEqual([]);
    expect(hardLimitProblems(PRICES, 100_000)).toHaveLength(1);
  });
});

describe('OpenRouter prices', () => {
  const sample = {
    data: [
      {
        id: 'google/gemini-3.1-flash-lite',
        pricing: {
          prompt: '0.00000025',
          completion: '0.0000015',
          input_cache_read: '0.000000025',
          input_cache_write: '0.0000000833333333333333',
        },
      },
      {
        id: 'deepseek/deepseek-v4-flash',
        pricing: { prompt: '0.00000009', completion: '0.00000018', input_cache_read: '0.000000018' },
      },
      { id: 'openrouter/auto', pricing: { prompt: '-1', completion: '-1' } },
      { id: 'odd/entry' }, // an odd entry elsewhere in the list must not break anything
    ],
  };

  it('turns per-token strings into per-million numbers without floating-point noise', () => {
    expect(perTokenToPerMillion('0.0000001')).toBe(0.1);
    expect(perTokenToPerMillion('0.00000025')).toBe(0.25);
    expect(perTokenToPerMillion('-1')).toBeUndefined();
    expect(perTokenToPerMillion(undefined)).toBeUndefined();
  });

  it('prices the models asked for, and explains the ones it cannot', () => {
    const { prices, problems } = parseOpenRouterModels(sample, [
      'google/gemini-3.1-flash-lite',
      'deepseek/deepseek-v4-flash',
      'openrouter/auto',
      'gone/model',
    ]);
    expect(prices['google/gemini-3.1-flash-lite']).toEqual({
      provider: 'openrouter',
      input: 0.25,
      output: 1.5,
      cacheRead: 0.025,
      cacheWrite5m: 0.0833333333333,
    });
    expect(prices['deepseek/deepseek-v4-flash']).toEqual({
      provider: 'openrouter',
      input: 0.09,
      output: 0.18,
      cacheRead: 0.018,
    });
    expect(problems).toHaveLength(2);
    expect(problems.join('\n')).toMatch(/openrouter\/auto.*variable/);
    expect(problems.join('\n')).toMatch(/gone\/model.*not in/);
  });

  it('fetches through whatever fetch it is given', async () => {
    const fakeFetch = (async () => new Response(JSON.stringify(sample))) as typeof fetch;
    const { prices } = await fetchOpenRouterPrices(['deepseek/deepseek-v4-flash'], fakeFetch);
    expect(prices['deepseek/deepseek-v4-flash']?.output).toBe(0.18);
  });

  it('cannot reach the real network from a test (money rule 1)', async () => {
    await expect(fetchOpenRouterPrices(['x'])).rejects.toThrow(/Network access is blocked/);
  });
});
