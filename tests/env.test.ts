import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { describeKeys, KeyRing, parseDotEnv, upsertDotEnv } from '../harness/env';
import { forgetSecretsForTests, redactSecrets, registerSecret } from '../harness/redact';
import { tempDir } from './helpers';

afterEach(() => forgetSecretsForTests());

describe('parseDotEnv', () => {
  it('reads what Windows editors produce: a byte-order mark, CRLF endings, quotes, comments', () => {
    const text =
      '﻿# keys\r\nANTHROPIC_API_KEY=sk-ant-abc123\r\nexport OPENROUTER_API_KEY="sk-or-v1-xyz"\r\n\r\n' +
      "OTHER = plain value  # a comment\r\nQUOTED='single'\r\n";
    const env = parseDotEnv(text);
    expect(env.get('ANTHROPIC_API_KEY')).toBe('sk-ant-abc123');
    expect(env.get('OPENROUTER_API_KEY')).toBe('sk-or-v1-xyz');
    expect(env.get('OTHER')).toBe('plain value');
    expect(env.get('QUOTED')).toBe('single');
  });

  it('lets the last of two lines with the same name win', () => {
    expect(parseDotEnv('A=1\nA=2\n').get('A')).toBe('2');
  });
});

describe('upsertDotEnv', () => {
  it('fills in a key and keeps comments, order and the other lines', () => {
    const before = '# Keys go here\nANTHROPIC_API_KEY=\nOPENROUTER_API_KEY=\nOTHER=1\n';
    const after = upsertDotEnv(before, new Map([['ANTHROPIC_API_KEY', 'sk-ant-new']]));
    expect(after).toBe('# Keys go here\nANTHROPIC_API_KEY=sk-ant-new\nOPENROUTER_API_KEY=\nOTHER=1\n');
  });

  it('replaces every copy of a name, and adds names that were missing', () => {
    const after = upsertDotEnv(
      'A=1\nA=2\n',
      new Map([
        ['A', '3'],
        ['B', '4'],
      ]),
    );
    expect(after).toBe('A=3\nA=3\nB=4\n');
  });

  it('keeps Windows line endings', () => {
    expect(upsertDotEnv('A=1\r\n', new Map([['A', '2']]))).toBe('A=2\r\n');
  });

  it('refuses values no API key would have', () => {
    expect(() => upsertDotEnv('', new Map([['A', 'has space']]))).toThrow(/Not saved/);
  });
});

describe('KeyRing', () => {
  const seats = [
    { botId: 'A', provider: 'anthropic' as const },
    { botId: 'D', provider: 'openrouter' as const },
  ];

  it('falls back to mock mode and says what is missing when there is no .env', () => {
    const ring = KeyRing.load(tempDir(), {});
    expect(ring.modeFor('anthropic')).toBe('mock');
    expect(ring.modeFor('openrouter')).toBe('mock');
    const text = describeKeys(ring.report, seats).join('\n');
    expect(text).toMatch(/not found yet/);
    expect(text).toMatch(/ANTHROPIC_API_KEY\s+missing\s+-> seats A would run as the free MockAgent/);
    expect(text).toMatch(/OPENROUTER_API_KEY\s+missing\s+-> seats D would run as the free MockAgent/);
  });

  it('takes keys from .env only, never from the shell', () => {
    const dir = tempDir();
    writeFileSync(join(dir, '.env'), 'ANTHROPIC_API_KEY=sk-ant-test-0123456789\n');
    const ring = KeyRing.load(dir, { OPENROUTER_API_KEY: 'sk-or-v1-from-the-shell-0123' });
    expect(ring.modeFor('anthropic')).toBe('paid');
    expect(ring.modeFor('openrouter')).toBe('mock');
    expect(ring.report.keys.find((k) => k.name === 'OPENROUTER_API_KEY')?.alsoInShell).toBe(true);
    expect(ring.reveal('ANTHROPIC_API_KEY')).toBe('sk-ant-test-0123456789');
    expect(() => ring.reveal('OPENROUTER_API_KEY')).toThrow(/npm run keys/);
  });

  it('never puts a key in its report, and blanks a loaded key wherever it turns up', () => {
    const dir = tempDir();
    const key = 'sk-ant-test-SECRET-9876543210';
    writeFileSync(join(dir, '.env'), `ANTHROPIC_API_KEY=${key}\n`);
    const ring = KeyRing.load(dir, {});
    const shown = JSON.stringify(ring.report) + describeKeys(ring.report, seats).join('\n');
    expect(shown).not.toContain(key);
    expect(redactSecrets(`oops: ${key}!`)).toBe('oops: [REDACTED]!');
  });

  it('flags a key that looks like it went on the wrong line', () => {
    const dir = tempDir();
    writeFileSync(join(dir, '.env'), 'ANTHROPIC_API_KEY=sk-or-v1-this-is-the-openrouter-one\n');
    const text = describeKeys(KeyRing.load(dir, {}).report, seats).join('\n');
    expect(text).toMatch(/doesn't start with "sk-ant-"/);
  });

  it('checks that .gitignore keeps .env out of git', () => {
    const dir = tempDir();
    writeFileSync(join(dir, '.gitignore'), 'node_modules/\n.env\n');
    expect(KeyRing.load(dir, {}).report.gitignoreProtectsEnv).toBe(true);
    expect(KeyRing.load(tempDir(), {}).report.gitignoreProtectsEnv).toBe(false);
  });
});

describe('redactSecrets', () => {
  it('blanks anything shaped like a provider key, even one that was never loaded', () => {
    expect(redactSecrets('a sk-ant-api03-AbCdEf123456 b sk-or-v1-0123456789abcdef c')).toBe(
      'a [REDACTED] b [REDACTED] c',
    );
  });

  it('ignores very short "secrets", so a typo cannot blank ordinary text', () => {
    registerSecret('x');
    expect(redactSecrets('xxx')).toBe('xxx');
  });
});
