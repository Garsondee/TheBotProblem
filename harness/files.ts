/**
 * Small file helpers shared by the harness.
 *
 * Every JSON file the harness writes goes through writeJsonAtomic, which does
 * two jobs: it blanks out anything that looks like an API key (redact.ts), and
 * it never leaves a half-written file behind if the program dies mid-write.
 */
import { readFileSync } from 'node:fs';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { redactSecrets } from './redact';

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let tempFileCounter = 0;

/**
 * Write JSON so that anyone reading the file sees either the old version or
 * the new one, never half of each. We write a temporary file next to the
 * target and then rename it over the target. A rename is a single step for
 * the file system, so a crash can't leave a half-written ledger behind.
 */
export async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  const text = redactSecrets(JSON.stringify(data, null, 2)) + '\n';
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${tempFileCounter++}.tmp`;
  await writeFile(temp, text, 'utf8');
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(temp, path);
      return;
    } catch (err) {
      // On Windows, antivirus or the search indexer sometimes holds a file open
      // for a moment and the rename fails with EPERM or EBUSY. Waiting briefly
      // and trying again is the standard cure.
      if (attempt >= 5 || !isBriefWindowsLock(err)) {
        await unlink(temp).catch(() => {});
        throw err;
      }
      await sleep(25 * attempt);
    }
  }
}

function isBriefWindowsLock(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
}

/** Read a JSON file and check it against a schema. Errors name the file and the bad fields. */
export function readJsonFile<T>(path: string, schema: z.ZodType<T>): T {
  let raw: unknown;
  try {
    // Strip a byte-order mark: Windows Notepad can add one, and JSON.parse rejects it.
    raw = JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, ''));
  } catch (err) {
    throw new Error(`Could not read ${path}: ${(err as Error).message}`);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`${path} is not in the expected shape:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
