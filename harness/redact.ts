/**
 * A last line of defence against leaking API keys.
 *
 * Keys should never reach a log line or a file in the first place: only the
 * code that sends a request to a provider ever asks for one (see env.ts,
 * KeyRing.reveal). This module catches mistakes anyway. Everything the harness
 * prints or writes to disk passes through `redactSecrets`, which blanks out:
 *   1. the exact values of the keys loaded from .env, and
 *   2. anything shaped like an Anthropic or OpenRouter key, in case a key we
 *      never loaded turns up somewhere (pasted into a config file, say).
 */

const registered = new Set<string>();

/** Strings that look like provider API keys. */
const KEY_SHAPES: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g, // Anthropic
  /sk-or-[A-Za-z0-9_-]{8,}/g, // OpenRouter ("sk-or-v1-...")
];

export const REDACTED = '[REDACTED]';

/** Remember a secret so it is blanked wherever it appears later. */
export function registerSecret(value: string): void {
  // Real keys are long. Refusing short values stops a typo like "x" in .env
  // from blanking every letter x in every log line.
  if (value.length >= 12) registered.add(value);
}

export function redactSecrets(text: string): string {
  let out = text;
  for (const secret of registered) out = out.split(secret).join(REDACTED);
  for (const shape of KEY_SHAPES) out = out.replace(shape, REDACTED);
  return out;
}

/** For tests only: forget every registered secret. */
export function forgetSecretsForTests(): void {
  registered.clear();
}
