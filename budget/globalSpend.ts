/**
 * The lifetime spend record: what every paid run has ever cost, per provider,
 * kept on disk so the global cap carries over from one run to the next.
 *
 * The spec: "a global cap across runs stored on disk".
 *
 * Three design choices worth knowing:
 *  - It lives in spend/ (git-ignored), NOT inside runs/, so tidying away old
 *    run folders can never reset the global cap by accident.
 *  - A damaged file is an error, never "start again from $0". A wrong record
 *    must stop paid runs, not quietly hand them a fresh budget.
 *  - Only one paid run may hold the record at a time (the lock file). Two runs
 *    at once would each believe the remaining budget was theirs alone, and
 *    could overspend together.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { readJsonFile, writeJsonAtomic } from '../harness/files';
import type { Provider } from './usage';

const SpendFileSchema = z.object({
  version: z.literal(1),
  /** Everything ever charged, per provider, in US dollars. */
  lifetimeUsd: z.record(z.string(), z.number().nonnegative()),
  runs: z.array(
    z.object({
      runId: z.string(),
      startedAt: z.string(),
      endedAt: z.string().nullable(),
      usdByProvider: z.record(z.string(), z.number().nonnegative()),
      stopReason: z.string().nullable(),
    }),
  ),
});
export type SpendFile = z.infer<typeof SpendFileSchema>;

const LockSchema = z.object({ runId: z.string(), pid: z.number().int(), startedAt: z.string() });

export class PaidRunLockedError extends Error {}

/** The lock file sits next to the spend file: spend/global-spend.json -> spend/global-spend.lock */
export function lockPathFor(spendFile: string): string {
  return spendFile.replace(/\.json$/i, '') + '.lock';
}

/** Is a process with this id still running? Signal 0 asks without sending anything. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means "it exists, but it isn't yours", so it is alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function takeLock(lockFile: string, runId: string, startedAt: string): void {
  mkdirSync(dirname(lockFile), { recursive: true });
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      // 'wx' = create the file, but fail if it already exists. The operating
      // system does both in one step, so two runs can't both win.
      const fd = openSync(lockFile, 'wx');
      writeSync(fd, JSON.stringify({ runId, pid: process.pid, startedAt }));
      closeSync(fd);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const holder = readLockHolder(lockFile);
      if (holder && isProcessAlive(holder.pid)) {
        throw new PaidRunLockedError(
          `Another paid run (${holder.runId}, process ${holder.pid}) is using the spend record. ` +
            `Wait for it to finish. If that program is no longer running, delete ${lockFile}.`,
        );
      }
      // The run that held the lock is gone (it crashed or was killed), so the
      // lock is stale. Clear it and try once more.
      unlinkSync(lockFile);
    }
  }
  throw new PaidRunLockedError(`Could not take the paid-run lock at ${lockFile}.`);
}

function readLockHolder(lockFile: string): z.infer<typeof LockSchema> | null {
  try {
    const parsed = LockSchema.safeParse(JSON.parse(readFileSync(lockFile, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null; // unreadable lock = treat as stale
  }
}

/**
 * Lifetime totals per provider, read without taking the lock (for estimates
 * and reports, which only look). Null when no paid run has happened yet.
 */
export function readLifetimeSpend(file: string): Partial<Record<Provider, number>> | null {
  if (!existsSync(file)) return null;
  return readJsonFile(file, SpendFileSchema).lifetimeUsd;
}

export class GlobalSpend {
  private dirty = false;
  private writing: Promise<void> | null = null;
  private writeError: unknown = null;
  private closed = false;

  private constructor(
    readonly file: string,
    private readonly lockFile: string,
    private readonly data: SpendFile,
    private readonly runIndex: number,
    private readonly clock: () => Date,
    /** True when no record existed yet, so this run started a new one at $0. */
    readonly createdNew: boolean,
  ) {}

  /**
   * Open the record for a new paid run: take the lock, then load the file
   * (or start a new record if there is none yet).
   */
  static async open(file: string, runId: string, clock: () => Date = () => new Date()): Promise<GlobalSpend> {
    const startedAt = clock().toISOString();
    const lockFile = lockPathFor(file);
    takeLock(lockFile, runId, startedAt);
    try {
      const createdNew = !existsSync(file);
      const data: SpendFile = createdNew
        ? { version: 1, lifetimeUsd: {}, runs: [] }
        : readJsonFile(file, SpendFileSchema);
      data.runs.push({ runId, startedAt, endedAt: null, usdByProvider: {}, stopReason: null });
      const spend = new GlobalSpend(file, lockFile, data, data.runs.length - 1, clock, createdNew);
      await writeJsonAtomic(file, data); // record that this run started, before it spends anything
      return spend;
    } catch (err) {
      unlinkSync(lockFile); // don't leave a lock behind for a run that never started
      throw err;
    }
  }

  /** Lifetime spend for one provider, including what this run has settled so far. */
  lifetimeUsd(provider: Provider): number {
    return this.data.lifetimeUsd[provider] ?? 0;
  }

  /** This run's settled spend for one provider. */
  thisRunUsd(provider: Provider): number {
    return this.data.runs[this.runIndex]?.usdByProvider[provider] ?? 0;
  }

  /** Add a settled charge. The file is rewritten shortly after (see scheduleWrite). */
  add(provider: Provider, usd: number): void {
    if (this.closed) throw new Error('The spend record is closed.');
    if (usd <= 0) return;
    const run = this.data.runs[this.runIndex];
    if (!run) throw new Error('This run is missing from the spend record.');
    this.data.lifetimeUsd[provider] = this.lifetimeUsd(provider) + usd;
    run.usdByProvider[provider] = (run.usdByProvider[provider] ?? 0) + usd;
    this.scheduleWrite();
  }

  /**
   * Coalesced writes: five bots finishing at once trigger one or two file
   * writes, not five. While a write is under way, new charges only set
   * `dirty`; the write loop goes round again until nothing is left unsaved.
   */
  private scheduleWrite(): void {
    this.dirty = true;
    this.writing ??= this.drain();
  }

  private async drain(): Promise<void> {
    try {
      while (this.dirty) {
        this.dirty = false;
        await writeJsonAtomic(this.file, this.data);
      }
    } catch (err) {
      // Kept for flush() to report, instead of crashing mid-phase: the run
      // finishes its phase and then stops cleanly on the error.
      this.writeError = err;
    } finally {
      this.writing = null;
    }
  }

  /** Wait until every charge added so far is on disk. Throws if a write failed. */
  async flush(): Promise<void> {
    while (this.writing) await this.writing;
    if (this.writeError) throw this.writeError;
  }

  /** Mark this run finished, save, and release the lock. */
  async close(stopReason: string | null): Promise<void> {
    if (this.closed) return;
    await this.flush();
    const run = this.data.runs[this.runIndex];
    if (run) {
      run.endedAt = this.clock().toISOString();
      run.stopReason = stopReason;
    }
    await writeJsonAtomic(this.file, this.data);
    this.closed = true;
    if (existsSync(this.lockFile)) unlinkSync(this.lockFile);
  }
}
