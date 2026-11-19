import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GlobalSpend } from '../budget/globalSpend';
import { Ledger } from '../budget/ledger';
import type { Caps, PlannedCall } from '../budget/spendGuard';
import { describeBreach, SpendGuard } from '../budget/spendGuard';
import type { Provider } from '../budget/usage';
import { charge, PRICES, tempDir } from './helpers';

function setup(caps: Partial<Caps> = {}) {
  const ledger = new Ledger('run', PRICES);
  const guard = new SpendGuard(
    { runUsd: 1, perBotUsd: 0.5, globalUsd: { anthropic: 10, openrouter: 10 }, ...caps },
    ledger,
    null,
  );
  return { ledger, guard };
}

const call = (botId: string | null, worstCaseUsd: number, provider: Provider = 'anthropic'): PlannedCall => ({
  botId,
  provider,
  worstCaseUsd,
});

describe('SpendGuard', () => {
  it('reserves a whole phase when every cap holds', () => {
    const { guard } = setup();
    expect(guard.reserveAll([call('A', 0.1), call('B', 0.1)]).ok).toBe(true);
    expect(guard.reservedUsd()).toBeCloseTo(0.2, 12);
  });

  it('reserves nothing at all when a phase would break the run cap', () => {
    const { guard } = setup({ runUsd: 0.25 });
    expect(guard.reserveAll([call('A', 0.1)]).ok).toBe(true);
    const result = guard.reserveAll([call('A', 0.1), call('B', 0.1)]); // 0.1 + 0.2 > 0.25
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.breach).toMatchObject({ cap: 'run', limitUsd: 0.25 });
    expect(guard.reservedUsd()).toBeCloseTo(0.1, 12); // the refused phase left no reservations behind
  });

  it('stops a bot that would pass its cap, and honours a seat with its own cap', () => {
    const { guard } = setup({ perBotUsd: 0.15, perBotOverrideUsd: { S: 1 } });
    expect(guard.reserveAll([call('S', 0.5)]).ok).toBe(true);
    const result = guard.reserveAll([call('A', 0.2)]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.breach).toMatchObject({ cap: 'bot', scope: 'A', limitUsd: 0.15 });
  });

  it('treats a provider with no lifetime cap as closed', () => {
    const { guard } = setup({ globalUsd: { anthropic: 10 } });
    const result = guard.reserveAll([call('D', 0.01, 'openrouter')]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.breach).toMatchObject({ cap: 'global', scope: 'openrouter', limitUsd: 0 });
  });

  it('lets free mock seats through whatever the caps', () => {
    const { guard } = setup({ runUsd: 0, perBotUsd: 0, globalUsd: {} });
    expect(guard.reserveAll([call('A', 0, 'mock')]).ok).toBe(true);
  });

  it('frees the unused worst case when a call settles at its real price', () => {
    const { ledger, guard } = setup({ runUsd: 0.3 });
    const first = guard.reserveAll([call('A', 0.2)]);
    if (!first.ok) throw new Error('expected the first phase to fit');
    expect(guard.reserveAll([call('B', 0.2)]).ok).toBe(false); // 0.2 reserved + 0.2 > 0.3
    guard.settle(first.reservations[0]!, charge(ledger, 'A', 'anthropic', 0.05));
    expect(guard.reservedUsd()).toBe(0);
    expect(guard.reserveAll([call('B', 0.2)]).ok).toBe(true); // 0.05 spent + 0.2 <= 0.3
  });

  it('refuses to settle the same reservation twice', () => {
    const { ledger, guard } = setup();
    const r = guard.reserve(call('A', 0.1));
    if (!r.ok) throw new Error('expected the call to fit');
    const entry = charge(ledger, 'A', 'anthropic', 0.01);
    guard.settle(r.reservations[0]!, entry);
    expect(() => guard.settle(r.reservations[0]!, entry)).toThrow(/already settled/);
  });

  it('releases a reservation for a call that was never sent', () => {
    const { guard } = setup();
    const r = guard.reserve(call('A', 0.1));
    if (!r.ok) throw new Error('expected the call to fit');
    guard.release(r.reservations[0]!);
    expect(guard.reservedUsd()).toBe(0);
  });

  it('checks lifetime caps against the record of earlier runs', async () => {
    const file = join(tempDir(), 'global-spend.json');
    const earlier = await GlobalSpend.open(file, 'earlier-run');
    earlier.add('openrouter', 4.9);
    await earlier.close('completed');

    const global = await GlobalSpend.open(file, 'this-run');
    const guard = new SpendGuard(
      { runUsd: 10, perBotUsd: 10, globalUsd: { anthropic: 8.5, openrouter: 5 } },
      new Ledger('this-run', PRICES),
      global,
    );
    expect(guard.reserve(call('D', 0.05, 'openrouter')).ok).toBe(true); // 4.95 of 5
    const result = guard.reserve(call('D', 0.1, 'openrouter'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.breach).toMatchObject({ cap: 'global', scope: 'openrouter' });
    expect(guard.reserve(call('A', 1, 'anthropic')).ok).toBe(true); // the other wallet is unaffected
    await global.close(null);
  });

  it('describes a breach in plain words', () => {
    expect(describeBreach({ cap: 'run', scope: 'run', limitUsd: 1.5, committedUsd: 1.48, requestedUsd: 0.05 })).toBe(
      'Run cap reached: the next phase could cost up to $0.05, but only $0.02 of the $1.50 cap is left.',
    );
    expect(
      describeBreach({ cap: 'global', scope: 'openrouter', limitUsd: 5.5, committedUsd: 5.49, requestedUsd: 0.02 }),
    ).toMatch(/^Lifetime openrouter cap reached/);
  });
});
