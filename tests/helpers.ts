/** Small shared helpers for the tests. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Ledger, LedgerEntry } from '../budget/ledger';
import type { PriceTable } from '../budget/prices';
import type { Provider, Usage } from '../budget/usage';
import { emptyUsage } from '../budget/usage';

/** A fresh, empty folder for one test, in the system's temp directory. */
export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'tbp-test-'));
}

/** A clock that starts at a fixed moment and moves one second per reading, so timestamps are predictable. */
export function fixedClock(start = '2026-11-19T12:00:00.000Z'): () => Date {
  let t = Date.parse(start);
  return () => new Date((t += 1000));
}

/** Prices used by the unit tests, fixed here so a change to config/ can't move these tests' numbers. */
export const PRICES: PriceTable = {
  'claude-haiku-5-5': {
    provider: 'anthropic',
    input: 0.1,
    output: 0.5,
    cacheWrite5m: 0.125,
    cacheWrite1h: 0.2,
    cacheRead: 0.01,
    minCacheableTokens: 512,
    longContext: { aboveTokens: 100_000, multiplier: 5 },
  },
  'cheap/router-model': { provider: 'openrouter', input: 0.25, output: 1.5, cacheRead: 0.025 },
};

export function usage(partial: Partial<Usage>): Usage {
  return { ...emptyUsage(), ...partial };
}

/** Record a call that was charged exactly `usd` (the provider-reported figure wins). */
export function charge(ledger: Ledger, botId: string | null, provider: Provider, usd: number): LedgerEntry {
  return ledger.record({ botId, phase: 'talk', model: 'cheap/router-model', provider, usage: emptyUsage(), providerCostUsd: usd });
}
