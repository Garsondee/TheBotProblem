/**
 * Milestone 0's acceptance test (docs/SPEC.md section 9): "caps stop a fake run".
 *
 * These tests drive a whole game's worth of fake calls through the real money
 * machinery, with the real price table and casts from config/, and check that
 * every kind of cap stops the run cleanly: never above the cap, never halfway
 * through a phase, and with everything saved.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { estimateCast, gameCallShapes } from '../budget/estimate';
import { GlobalSpend, lockPathFor, PaidRunLockedError, readLifetimeSpend } from '../budget/globalSpend';
import { capsFor, loadCast, loadGameConfig, loadPrices } from '../harness/config';
import type { FakeRunOptions } from '../harness/fakeRun';
import { runFakePaidGame } from '../harness/fakeRun';
import { forgetSecretsForTests, registerSecret } from '../harness/redact';
import { fixedClock, tempDir } from './helpers';

const game = loadGameConfig();
const cast = loadCast();
const prices = loadPrices().table;
const SLOW = 60_000; // a whole fake game writes a few hundred small files

function options(overrides: Partial<FakeRunOptions> = {}): FakeRunOptions {
  return { runsRoot: tempDir(), cast, prices, game, caps: capsFor(game, cast), clock: fixedClock(), ...overrides };
}

afterEach(() => forgetSecretsForTests());

describe('milestone 0: the caps stop a fake run', () => {
  it(
    'stops at the run cap without overspending, finishing its last phase and saving everything',
    async () => {
      const result = await runFakePaidGame(options({ caps: { ...capsFor(game, cast), runUsd: 0.05 } }));

      expect(result.completed).toBe(false);
      expect(result.stoppedBy?.cap).toBe('run');
      expect(result.totals.usd).toBeLessThanOrEqual(0.05);
      expect(result.phasesRun).toBeGreaterThan(0);
      // Every phase that started also finished: each one made a call for every bot.
      expect(result.callsMade).toBe(result.phasesRun * cast.seats.length);

      const ledger = JSON.parse(readFileSync(join(result.runDir, 'ledger.json'), 'utf8'));
      expect(ledger.stopReason).toMatch(/^Run cap reached/);
      expect(ledger.entries).toHaveLength(result.callsMade);
      const state = JSON.parse(readFileSync(join(result.runDir, 'state.json'), 'utf8'));
      expect(state).toMatchObject({ completed: false, phasesRun: result.phasesRun });
      const spend = JSON.parse(readFileSync(result.spendFile, 'utf8'));
      expect(spend.runs[0].stopReason).toMatch(/^Run cap reached/);
      expect(spend.lifetimeUsd.anthropic + spend.lifetimeUsd.openrouter).toBeCloseTo(result.totals.usd, 10);
      expect(existsSync(lockPathFor(result.spendFile))).toBe(false); // the lock was given back
    },
    SLOW,
  );

  it(
    'stops when one seat reaches its own cap',
    async () => {
      const result = await runFakePaidGame(options({ caps: { ...capsFor(game, cast), perBotOverrideUsd: { E: 0.01 } } }));
      expect(result.stoppedBy).toMatchObject({ cap: 'bot', scope: 'E' });
      expect(result.totals.byBot.E?.usd ?? 0).toBeLessThanOrEqual(0.01);
    },
    SLOW,
  );

  it(
    'carries the lifetime cap from one run to the next',
    async () => {
      const spendFile = join(tempDir(), 'global-spend.json');
      const caps = { ...capsFor(game, cast), runUsd: 100, globalUsd: { anthropic: 0.5, openrouter: 0.5 } };

      const first = await runFakePaidGame(options({ caps, spendFile, label: 'first' }));
      expect(first.stoppedBy).toMatchObject({ cap: 'global', scope: 'openrouter' });

      const second = await runFakePaidGame(options({ caps, spendFile, label: 'second' }));
      expect(second.stoppedBy).toMatchObject({ cap: 'global', scope: 'openrouter' });
      expect(second.phasesRun).toBeLessThan(first.phasesRun);
      expect(readLifetimeSpend(spendFile)?.openrouter).toBeLessThanOrEqual(0.5);
    },
    SLOW,
  );

  it(
    'plays the whole game when it fits, at the cost the estimator predicts',
    async () => {
      const result = await runFakePaidGame(options({ caps: { ...capsFor(game, cast), runUsd: 100, perBotUsd: 100 } }));
      expect(result.completed).toBe(true);
      expect(result.stoppedBy).toBeNull();
      expect(result.phasesRun).toBe(6 * 12 * 3 + 6 * 2 + 1); // 3 calls a round, reflect + diary a level, one final message
      expect(result.warnings).toEqual([]);

      // The fake run and the estimator model the same game in different ways;
      // they should agree within a few percent.
      const estimate = estimateCast(
        cast.seats,
        prices,
        gameCallShapes(game.estimate, game.maxTokens),
        game.estimate.cacheWritesPerGame,
      );
      expect(Math.abs(result.totals.usd - estimate.expectedUsd) / estimate.expectedUsd).toBeLessThan(0.05);
    },
    SLOW,
  );

  it(
    'never writes a loaded API key into the run folder',
    async () => {
      const key = 'sk-ant-api03-TEST-KEY-that-must-never-leak-0123';
      registerSecret(key); // as KeyRing.load does for a key found in .env
      const result = await runFakePaidGame(options({ caps: { ...capsFor(game, cast), runUsd: 0.05 } }));
      for (const name of readdirSync(result.runDir)) {
        expect(readFileSync(join(result.runDir, name), 'utf8'), name).not.toContain(key);
      }
    },
    SLOW,
  );

  it('refuses to start while another paid run holds the lifetime record', async () => {
    const spendFile = join(tempDir(), 'global-spend.json');
    const other = await GlobalSpend.open(spendFile, 'someone-else');
    await expect(runFakePaidGame(options({ spendFile }))).rejects.toThrow(PaidRunLockedError);
    await other.close(null);
  });
});
