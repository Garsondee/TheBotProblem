/**
 * API keys: loading them from .env, and keeping them from ever leaking.
 *
 * The rules (docs/SPEC.md, "Keys"):
 *   - Keys come from a .env file in the project folder, never from code.
 *   - Keys are never printed, logged or committed.
 *   - A missing key is not an error: those seats run as the free MockAgent,
 *     and the harness says which key is missing.
 *
 * Why read ONLY the .env file, and not the shell's environment variables too?
 * Because every paid call must be deliberate. If we fell back to whatever
 * ANTHROPIC_API_KEY happened to be set in a shell, a key meant for some other
 * tool could quietly pay for a bot game. The .env file is the one place where
 * Ingram says "use this key here". For the same reason, the agents always pass
 * the key and base URL to the Anthropic SDK explicitly: left alone, the SDK
 * reads keys and base URLs from the environment by itself.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Provider } from '../budget/usage';
import { registerSecret } from './redact';

export const KEY_NAMES = ['ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY'] as const;
export type KeyName = (typeof KEY_NAMES)[number];
export type PaidProvider = Exclude<Provider, 'mock'>;

export const KEY_INFO: Record<KeyName, { provider: PaidProvider; label: string; prefix: string }> = {
  ANTHROPIC_API_KEY: { provider: 'anthropic', label: 'Anthropic API key', prefix: 'sk-ant-' },
  OPENROUTER_API_KEY: { provider: 'openrouter', label: 'OpenRouter API key', prefix: 'sk-or-' },
};

export function keyNameFor(provider: PaidProvider): KeyName {
  return provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENROUTER_API_KEY';
}

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

/**
 * Read .env text into name -> value. Copes with the things Windows editors do:
 * CRLF line endings and a byte-order mark. Also handles comments, quotes and
 * an optional `export` in front. If a name appears twice, the last one wins.
 */
export function parseDotEnv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const rawLine of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = LINE.exec(line);
    if (!match) continue;
    const name = match[1] ?? '';
    let value = (match[2] ?? '').trim();
    const quoted = value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0];
    if (quoted) {
      value = value.slice(1, -1);
    } else {
      // An unquoted value may be followed by a comment: KEY=abc  # note
      const comment = value.search(/\s#/);
      if (comment >= 0) value = value.slice(0, comment).trim();
    }
    out.set(name, value);
  }
  return out;
}

/** Set variables in .env text, leaving every other line (comments included) as it was. */
export function upsertDotEnv(text: string, updates: ReadonlyMap<string, string>): string {
  for (const [name, value] of updates) {
    if (/[\s"'#]/.test(value)) {
      throw new Error(`The value for ${name} contains a space, quote or #, which no API key does. Not saved.`);
    }
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop(); // the file's final newline
  const seen = new Set<string>();
  // Replace every line that sets one of these names (not just the first), so
  // a stray duplicate further down can't quietly win when the file is read.
  const out = lines.map((line) => {
    const name = LINE.exec(line)?.[1];
    const value = name === undefined ? undefined : updates.get(name);
    if (name === undefined || value === undefined) return line;
    seen.add(name);
    return `${name}=${value}`;
  });
  for (const [name, value] of updates) if (!seen.has(name)) out.push(`${name}=${value}`);
  return out.join(eol) + eol;
}

export interface KeyStatus {
  name: KeyName;
  provider: PaidProvider;
  present: boolean;
  /** Starts the way that provider's keys do. "No" usually means a key was pasted on the wrong line. */
  looksRight: boolean;
  /** The same name is also set in the shell's environment. We ignore that copy. */
  alsoInShell: boolean;
}

export interface EnvReport {
  envFile: string;
  envFileFound: boolean;
  gitignoreProtectsEnv: boolean;
  keys: KeyStatus[];
}

function gitignoreProtectsEnv(projectRoot: string): boolean {
  const file = join(projectRoot, '.gitignore');
  if (!existsSync(file)) return false;
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => line === '.env' || line === '/.env' || line === '.env*');
}

/**
 * The loaded keys. Code asks `has()` freely; only code that actually sends a
 * request to a provider calls `reveal()`, which makes the few places that
 * touch a secret easy to find (search for "reveal(").
 */
export class KeyRing {
  private constructor(
    private readonly values: ReadonlyMap<KeyName, string>,
    readonly report: EnvReport,
  ) {}

  static load(projectRoot: string, shellEnv: NodeJS.ProcessEnv = process.env): KeyRing {
    const envFile = join(projectRoot, '.env');
    const envFileFound = existsSync(envFile);
    const parsed = envFileFound ? parseDotEnv(readFileSync(envFile, 'utf8')) : new Map<string, string>();
    const values = new Map<KeyName, string>();
    const keys = KEY_NAMES.map((name): KeyStatus => {
      const value = (parsed.get(name) ?? '').trim();
      const shellValue = shellEnv[name] ?? '';
      // Register both copies with the redactor, so neither can leak through a log line.
      if (value !== '') {
        values.set(name, value);
        registerSecret(value);
      }
      if (shellValue !== '') registerSecret(shellValue);
      return {
        name,
        provider: KEY_INFO[name].provider,
        present: value !== '',
        looksRight: value.startsWith(KEY_INFO[name].prefix),
        alsoInShell: shellValue !== '',
      };
    });
    return new KeyRing(values, {
      envFile,
      envFileFound,
      gitignoreProtectsEnv: gitignoreProtectsEnv(projectRoot),
      keys,
    });
  }

  has(name: KeyName): boolean {
    return this.values.has(name);
  }

  /** The key itself. Only code that sends a request to that provider should call this. */
  reveal(name: KeyName): string {
    const value = this.values.get(name);
    if (value === undefined) throw new Error(`${name} is not set in .env. Run \`npm run keys\` to add it.`);
    return value;
  }

  /** Whether a provider's seats can play for real, or must fall back to the free MockAgent. */
  modeFor(provider: Provider): 'paid' | 'mock' {
    if (provider === 'mock') return 'mock';
    return this.has(keyNameFor(provider)) ? 'paid' : 'mock';
  }
}

/** The key report in plain words. Never includes a key, only whether it is there. */
export function describeKeys(report: EnvReport, seats: readonly { botId: string; provider: Provider }[]): string[] {
  const lines: string[] = [];
  lines.push(
    report.envFileFound
      ? `.env file: found (${report.envFile})`
      : '.env file: not found yet. Run `npm run keys` to create it (or copy .env.example to .env).',
  );
  for (const key of report.keys) {
    const bots = seats.filter((s) => s.provider === key.provider).map((s) => s.botId);
    const who = bots.length > 0 ? `seats ${bots.join(', ')}` : 'no seats in this cast';
    const state = key.present ? 'present' : 'missing';
    const effect = key.present ? `${who} can play for real in a paid run` : `${who} would run as the free MockAgent`;
    lines.push(`${key.name.padEnd(19)} ${state.padEnd(8)} -> ${effect}`);
    if (key.present && !key.looksRight) {
      lines.push(`    It doesn't start with "${KEY_INFO[key.name].prefix}". Check the right key went on the right line.`);
    }
    if (key.alsoInShell) {
      lines.push(`    ${key.name} is also set in your shell environment. That copy is ignored; only .env counts.`);
    }
  }
  lines.push(`.gitignore keeps .env out of git: ${report.gitignoreProtectsEnv ? 'yes' : 'NO, add a line ".env" to .gitignore'}`);
  return lines;
}
