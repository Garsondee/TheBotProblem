/**
 * A game's records, written to its run folder as they happen:
 *   replay.jsonl     everything that happened (deterministic: no clock times)
 *   responses.jsonl  every model reply, raw, with its usage and a timestamp
 *   prompts.jsonl    every prompt sent
 *   state/*.json     the full state after every round
 *
 * Lines are appended one at a time, so a run that stops halfway (a crash, a
 * cap, Ctrl+C) still leaves everything up to that moment on disk. Everything
 * passes through the secret redactor first, just in case.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GameOutput } from '../game/output';
import { redactSecrets } from './redact';

export class FileOutput implements GameOutput {
  constructor(
    private readonly dir: string,
    private readonly clock: () => Date = () => new Date(),
  ) {
    mkdirSync(join(dir, 'state'), { recursive: true });
  }

  private line(file: string, record: Record<string, unknown>): void {
    appendFileSync(join(this.dir, file), `${redactSecrets(JSON.stringify(record))}\n`);
  }

  replay(record: Record<string, unknown>): void {
    this.line('replay.jsonl', record);
  }

  response(record: Record<string, unknown>): void {
    this.line('responses.jsonl', { at: this.clock().toISOString(), ...record });
  }

  prompt(record: Record<string, unknown>): void {
    this.line('prompts.jsonl', record);
  }

  snapshot(name: string, data: unknown): void {
    writeFileSync(join(this.dir, 'state', `${name}.json`), `${redactSecrets(JSON.stringify(data))}\n`);
  }
}
