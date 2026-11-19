/**
 * npm run keys
 *
 * Type or paste your API keys; they are saved to .env in the project folder.
 * Each character shows as * while you type, the keys are never printed
 * afterwards, and .env is git-ignored. Press Enter on an empty prompt to keep
 * the current value (or to leave a key unset: its seats then use the free
 * MockAgent).
 */
import password from '@inquirer/password';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadCast, PROJECT_ROOT } from '../config';
import { describeKeys, KEY_INFO, KeyRing, upsertDotEnv } from '../env';
import { say, warn } from '../log';

if (!process.stdin.isTTY) {
  warn('`npm run keys` needs a terminal you can type into.');
  warn('Or copy .env.example to .env and paste each key after its = sign.');
  process.exit(1);
}

const ring = KeyRing.load(PROJECT_ROOT);
const updates = new Map<string, string>();

say('Your keys are saved to .env in this folder (git-ignored). They are never shown or printed.');
say('Press Enter on an empty prompt to keep what is there.');
say();
try {
  for (const key of ring.report.keys) {
    const info = KEY_INFO[key.name];
    const now = key.present ? 'set now, Enter keeps it' : 'not set, Enter skips it';
    const value = (await password({ message: `${info.label} (${now}):`, mask: '*' })).trim();
    if (value === '') continue;
    if (!value.startsWith(info.prefix)) {
      say(`  Note: ${info.label}s usually start with "${info.prefix}". Saved anyway; check you pasted the right one.`);
    }
    updates.set(key.name, value);
  }
} catch (err) {
  // Ctrl+C inside the prompt.
  if ((err as Error).name === 'ExitPromptError') {
    say('Cancelled. .env was not changed.');
    process.exit(0);
  }
  throw err;
}

say();
if (updates.size === 0) {
  say('Nothing changed.');
} else {
  const envFile = ring.report.envFile;
  // A brand-new .env starts as a copy of .env.example, so it keeps the explanatory comments.
  const example = join(PROJECT_ROOT, '.env.example');
  const before = existsSync(envFile) ? readFileSync(envFile, 'utf8') : existsSync(example) ? readFileSync(example, 'utf8') : '';
  writeFileSync(envFile, upsertDotEnv(before, updates), { encoding: 'utf8', mode: 0o600 });
  say(`Saved ${updates.size === 1 ? 'one key' : `${updates.size} keys`} to .env.`);
}

for (const line of describeKeys(KeyRing.load(PROJECT_ROOT).report, loadCast().seats)) say(`  ${line}`);
say();
say('Free check that the keys work (runs no model, spends nothing): npm run check-env -- --online');
