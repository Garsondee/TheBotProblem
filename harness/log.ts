/**
 * Console output for the harness. Every line passes through redactSecrets,
 * so even a bug that tries to print a key prints [REDACTED] instead.
 */
import { redactSecrets } from './redact';

export function say(line = ''): void {
  process.stdout.write(redactSecrets(line) + '\n');
}

export function warn(line: string): void {
  process.stderr.write(redactSecrets(line) + '\n');
}
