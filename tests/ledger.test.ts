import { describe, expect, it } from 'vitest';
import { liveLine, usd } from '../budget/format';
import { Ledger, NO_BOT } from '../budget/ledger';
import { fixedClock, PRICES, usage } from './helpers';

const turnCall = usage({ inputTokens: 1800, cacheReadTokens: 5000, outputTokens: 400 }); // $0.00043 on Haiku
const routerCall = usage({ inputTokens: 1000, outputTokens: 100 }); // 250 + 150 per million = $0.0004

describe('Ledger', () => {
  it('prices every call and keeps running totals per bot, phase, provider and model', () => {
    const ledger = new Ledger('run-1', PRICES, fixedClock());
    const haiku = { model: 'claude-haiku-5-5', provider: 'anthropic' as const, level: 1, round: 1 };
    ledger.record({ ...haiku, botId: 'A', phase: 'declare', usage: turnCall });
    ledger.record({ ...haiku, botId: 'B', phase: 'talk', usage: turnCall });
    ledger.record({ botId: 'A', phase: 'talk', model: 'cheap/router-model', provider: 'openrouter', usage: routerCall });

    const t = ledger.totals();
    expect(t.calls).toBe(3);
    expect(t.usd).toBeCloseTo(0.00043 * 2 + 0.0004, 12);
    expect(t.byBot.A?.usd).toBeCloseTo(0.00043 + 0.0004, 12);
    expect(t.byPhase.talk?.calls).toBe(2);
    expect(t.byProvider.openrouter?.usd).toBeCloseTo(0.0004, 12);
    expect(t.byModel['claude-haiku-5-5']?.calls).toBe(2);
    expect(t.usage.cacheReadTokens).toBe(10_000);
    expect(ledger.spentUsd({ botId: 'A', provider: 'anthropic' })).toBeCloseTo(0.00043, 12);
    expect(ledger.all().map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(ledger.all()[0]?.at).toBe('2026-11-19T12:00:01.000Z');
  });

  it("charges the larger of our price and the provider's own figure", () => {
    const ledger = new Ledger('run-1', PRICES);
    const call = { botId: 'D', phase: 'talk', model: 'cheap/router-model', provider: 'openrouter' as const, usage: routerCall };
    const pricier = ledger.record({ ...call, providerCostUsd: 0.001 });
    expect(pricier.tableUsd).toBeCloseTo(0.0004, 12);
    expect(pricier.chargedUsd).toBe(0.001);
    const cheaper = ledger.record({ ...call, providerCostUsd: 0.0001 });
    expect(cheaper.chargedUsd).toBeCloseTo(0.0004, 12);
  });

  it('records mock calls at no cost, without needing a price', () => {
    const entry = new Ledger('run', {}).record({
      botId: 'A',
      phase: 'talk',
      model: 'mock',
      provider: 'mock',
      usage: usage({ inputTokens: 999 }),
    });
    expect(entry.chargedUsd).toBe(0);
  });

  it('files calls that belong to no bot under "(no bot)"', () => {
    const ledger = new Ledger('run', PRICES);
    ledger.record({ botId: null, phase: 'analysis', model: 'claude-haiku-5-5', provider: 'anthropic', usage: turnCall });
    expect(ledger.totals().byBot[NO_BOT]?.calls).toBe(1);
  });

  it('warns about hidden reasoning and 1-hour cache writes', () => {
    const ledger = new Ledger('run', PRICES);
    const base = { phase: 'talk', model: 'claude-haiku-5-5', provider: 'anthropic' as const };
    ledger.record({ ...base, botId: 'E', usage: usage({ outputTokens: 300, reasoningTokens: 200 }) });
    ledger.record({ ...base, botId: 'A', usage: usage({ cacheWrite1hTokens: 50 }) });
    const warnings = ledger.warnings().join('\n');
    expect(warnings).toMatch(/E: 200 hidden reasoning tokens/);
    expect(warnings).toMatch(/A: 50 tokens went to the 1-hour cache/);
  });

  it("reports each bot's cache hit rate", () => {
    const ledger = new Ledger('run', PRICES);
    ledger.record({ botId: 'A', phase: 'talk', model: 'claude-haiku-5-5', provider: 'anthropic', usage: turnCall });
    expect(ledger.cacheHitRate('A')).toBeCloseTo(5000 / 6800, 12);
    expect(ledger.cacheHitRate('Z')).toBeNull();
  });
});

describe('money on screen', () => {
  it('shows as many decimals as an amount needs', () => {
    expect(usd(0)).toBe('$0');
    expect(usd(0.0043)).toBe('$0.0043');
    expect(usd(0.427)).toBe('$0.427');
    expect(usd(0.1)).toBe('$0.10');
    expect(usd(1.5)).toBe('$1.50');
  });

  it('prints a live ledger line with every bot and the cache share', () => {
    const ledger = new Ledger('run', PRICES);
    ledger.record({ botId: 'A', phase: 'talk', model: 'claude-haiku-5-5', provider: 'anthropic', usage: turnCall });
    const line = liveLine('L1 R01', ledger.totals(), 1.5, ['A', 'B']);
    expect(line).toMatch(/^L1 R01\s+spent \$0\.0004 of \$1\.50 \| A 0\.0004 {2}B 0\.0000 \| cache 74%$/);
  });
});
