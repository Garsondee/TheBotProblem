/**
 * Where a game's records go. The game writes through this interface, so it
 * doesn't care whether they land in files (a real run, harness/gameFiles.ts)
 * or in memory (tests).
 *
 * The four streams (spec section 3, "generate"):
 *   replay     replay.jsonl: everything that happened, in order. Deterministic:
 *              no clock times, so the same seed and the same responses give
 *              the same bytes.
 *   response   responses.jsonl: every model reply, raw, with its usage. A
 *              ReplayAgent fed this file replays the game for free.
 *   prompt     prompts.jsonl: every prompt sent, for checking what bots saw.
 *   snapshot   state/<name>.json: the full state after each round (forks).
 */
export interface GameOutput {
  replay(record: Record<string, unknown>): void;
  response(record: Record<string, unknown>): void;
  prompt(record: Record<string, unknown>): void;
  snapshot(name: string, data: unknown): void;
}

/** Keeps everything in memory, as the lines a file would hold. For tests. */
export class MemoryOutput implements GameOutput {
  readonly replayLines: string[] = [];
  readonly responses: Record<string, unknown>[] = [];
  readonly prompts: Record<string, unknown>[] = [];
  readonly snapshots = new Map<string, unknown>();

  replay(record: Record<string, unknown>): void {
    this.replayLines.push(JSON.stringify(record));
  }

  response(record: Record<string, unknown>): void {
    this.responses.push(record);
  }

  prompt(record: Record<string, unknown>): void {
    this.prompts.push(record);
  }

  snapshot(name: string, data: unknown): void {
    this.snapshots.set(name, data);
  }
}

/** Throws everything away. For estimates that only need the prompts' sizes. */
export const NO_OUTPUT: GameOutput = { replay() {}, response() {}, prompt() {}, snapshot() {} };
