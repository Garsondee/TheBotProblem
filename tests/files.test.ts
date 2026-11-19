import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { readJsonFile, writeJsonAtomic } from '../harness/files';
import { forgetSecretsForTests, registerSecret } from '../harness/redact';
import { createRunFolder, makeRunId } from '../harness/runFolder';
import { tempDir } from './helpers';

afterEach(() => forgetSecretsForTests());

describe('writeJsonAtomic', () => {
  it('writes readable JSON and leaves no temporary file behind', async () => {
    const dir = tempDir();
    const file = join(dir, 'nested', 'out.json');
    await writeJsonAtomic(file, { a: 1 });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ a: 1 });
    expect(readdirSync(join(dir, 'nested'))).toEqual(['out.json']);
  });

  it('blanks secrets before they reach the disk', async () => {
    const file = join(tempDir(), 'out.json');
    registerSecret('my-registered-secret-value');
    await writeJsonAtomic(file, { a: 'my-registered-secret-value', b: 'sk-or-v1-abcdef0123456789' });
    const text = readFileSync(file, 'utf8');
    expect(text).not.toContain('my-registered-secret-value');
    expect(text).not.toContain('sk-or-v1-abcdef0123456789');
    expect(text).toContain('[REDACTED]');
  });
});

describe('readJsonFile', () => {
  const Schema = z.object({ runCapUsd: z.number() });

  it('names the file and the bad field', () => {
    const file = join(tempDir(), 'game.json');
    writeFileSync(file, '{ "runCapUsd": "lots" }');
    expect(() => readJsonFile(file, Schema)).toThrow(/game\.json[\s\S]*runCapUsd/);
  });

  it('accepts a byte-order mark, which Windows Notepad may add', () => {
    const file = join(tempDir(), 'game.json');
    writeFileSync(file, '﻿{ "runCapUsd": 1.5 }');
    expect(readJsonFile(file, Schema)).toEqual({ runCapUsd: 1.5 });
  });
});

describe('run folders', () => {
  it('are named by date and time, so a file listing sorts them', () => {
    expect(makeRunId('fake', new Date(2026, 10, 19, 23, 5, 9))).toBe('20261119-230509-fake');
  });

  it('never reuse an existing folder', () => {
    const root = tempDir();
    const first = createRunFolder(root, 'same-id');
    const second = createRunFolder(root, 'same-id');
    expect(first.runId).toBe('same-id');
    expect(second.runId).toBe('same-id-2');
    expect(existsSync(second.runDir)).toBe(true);
  });
});
