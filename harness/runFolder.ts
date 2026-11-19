/**
 * Run folders: every run, real or fake, gets its own folder under runs/,
 * named so that a plain file listing sorts the runs by time.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** 20261119-231502-fake: date, time, then what kind of run it was. */
export function makeRunId(label: string, now: Date = new Date()): string {
  const two = (n: number) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}`;
  const time = `${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
  return `${date}-${time}-${label}`;
}

/** Make a new, empty run folder. Never reuses one: a run must not overwrite another run. */
export function createRunFolder(runsRoot: string, runId: string): { runId: string; runDir: string } {
  mkdirSync(runsRoot, { recursive: true });
  for (let n = 1; n < 100; n++) {
    const id = n === 1 ? runId : `${runId}-${n}`;
    const dir = join(runsRoot, id);
    try {
      mkdirSync(dir); // without { recursive }, this fails if the folder already exists
      return { runId: id, runDir: dir };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  throw new Error(`Could not make a new run folder for ${runId} in ${runsRoot}.`);
}
