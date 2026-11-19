import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GlobalSpend, lockPathFor, PaidRunLockedError, readLifetimeSpend } from '../budget/globalSpend';
import { fixedClock, tempDir } from './helpers';

describe('GlobalSpend, the lifetime record on disk', () => {
  it('starts a new record, saves each charge, and remembers it in the next run', async () => {
    const file = join(tempDir(), 'spend', 'global-spend.json');
    const first = await GlobalSpend.open(file, 'run-1', fixedClock());
    expect(first.createdNew).toBe(true);
    first.add('anthropic', 0.25);
    first.add('openrouter', 0.1);
    first.add('anthropic', 0.05);
    await first.close('completed');

    const second = await GlobalSpend.open(file, 'run-2', fixedClock());
    expect(second.createdNew).toBe(false);
    expect(second.lifetimeUsd('anthropic')).toBeCloseTo(0.3, 12);
    expect(second.thisRunUsd('anthropic')).toBe(0);
    await second.close(null);

    const saved = JSON.parse(readFileSync(file, 'utf8'));
    expect(saved.runs.map((r: { runId: string }) => r.runId)).toEqual(['run-1', 'run-2']);
    expect(saved.runs[0].stopReason).toBe('completed');
    expect(saved.runs[0].endedAt).not.toBeNull();
    expect(readLifetimeSpend(file)).toEqual({ anthropic: expect.closeTo(0.3), openrouter: expect.closeTo(0.1) });
  });

  it('is on disk after flush, before the run ends (a crash keeps what was spent)', async () => {
    const file = join(tempDir(), 'global-spend.json');
    const spend = await GlobalSpend.open(file, 'run-1');
    spend.add('anthropic', 0.4);
    await spend.flush();
    expect(readLifetimeSpend(file)?.anthropic).toBeCloseTo(0.4, 12);
    await spend.close(null);
  });

  it('lets only one paid run hold the record at a time', async () => {
    const file = join(tempDir(), 'global-spend.json');
    const holder = await GlobalSpend.open(file, 'run-1');
    await expect(GlobalSpend.open(file, 'run-2')).rejects.toThrow(PaidRunLockedError);
    await holder.close(null);
    const next = await GlobalSpend.open(file, 'run-3'); // the lock was given back
    await next.close(null);
  });

  it('clears a lock left behind by a run that crashed', async () => {
    const file = join(tempDir(), 'global-spend.json');
    // The id of a process that has already finished stands in for a crashed run.
    const deadPid = spawnSync(process.execPath, ['-e', '0']).pid;
    writeFileSync(lockPathFor(file), JSON.stringify({ runId: 'crashed', pid: deadPid, startedAt: 'earlier' }));
    const spend = await GlobalSpend.open(file, 'run-2');
    await spend.close(null);
    expect(existsSync(lockPathFor(file))).toBe(false);
  });

  it('refuses a damaged record instead of quietly starting again from $0', async () => {
    const file = join(tempDir(), 'global-spend.json');
    writeFileSync(file, '{ "version": 1, "lifetimeUsd": ');
    await expect(GlobalSpend.open(file, 'run-1')).rejects.toThrow(/Could not read/);
    expect(existsSync(lockPathFor(file))).toBe(false); // and it gave the lock back
  });
});
