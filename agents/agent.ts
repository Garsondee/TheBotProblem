/**
 * The Agent interface: every player sits behind it, so the game never knows
 * what kind of player it is talking to (spec section 3).
 *
 * The spec sketches `act(phase, view)` and `reflect(summary)`. Here both are
 * one method, act(request), with `kind` saying which: the game builds the
 * whole prompt itself (so the leak test can check every prompt, whoever the
 * player is), and the agent only answers it. A HumanAgent (deferred, spec
 * section 9) would show `request.prompt.user` to a person and return what
 * they type.
 */
import type { Provider, Usage } from '../budget/usage';
import type { Phase } from '../game/events';
import type { BotView } from '../game/view';

export interface Prompt {
  /** Stable first (the rulebook, then the bot's identity and notebook); `cache` marks the end of a cached part. */
  system: { text: string; cache?: boolean }[];
  /** The fresh part: this call's view. */
  user: string;
  /**
   * Where the part of `user` that stays the same for a whole round ends (what
   * the bot sees, its moves, last round's results). Calls 2 and 3 of a round
   * can read that part from the cache. Undefined: nothing to cache.
   */
  userCacheBreak?: number;
}

export interface AgentRequest {
  kind: 'turn' | 'reflection' | 'intro' | 'judge';
  /**
   * declare, talk or commit for turns; at a room's end, 'diary' (the diary room) then 'reflect' (notebook and
   * strategy); at a room's start, 'intro' (each bot introduces itself) then 'judge' (the silent judge scores them).
   */
  phase: Phase | 'reflect' | 'diary' | 'intro' | 'judge';
  levelIndex: number;
  level: string;
  round: number;
  bot: string;
  /** 1, or 2 when the first reply couldn't be used. */
  attempt: number;
  prompt: Prompt;
  /** The structured view behind the prompt, for players that don't read text (the mock). Null for reflections. */
  view: BotView | null;
  schema: Record<string, unknown>;
  maxTokens: number;
  /** For the judge: the introductions it is scoring, as data (the mock judge reads these instead of the prompt). */
  judging?: JudgeItem[];
}

/** The silent judge's seat (prompts/host.ts). Not a bot: it never plays, and no bot sees what it writes. */
export const JUDGE_ID = '~judge';

/** One introduction for the judge, with the bot's earlier ones (oldest first) and the scores they got. */
export interface JudgeItem {
  bot: string;
  name: string | null;
  introduction: string;
  answer: string;
  earlier: { when: string; introduction: string; answer: string; score: number | null }[];
}

export interface AgentReply {
  /** The reply as text (JSON, if the agent followed the schema). */
  text: string;
  usage: Usage;
  providerCostUsd: number | null;
  stopReason: string | null;
  /** The provider's whole response, for the record (money rule 4: never pay twice for the same response). */
  raw: unknown;
}

export interface Agent {
  /** The bot's letter. */
  readonly id: string;
  readonly provider: Provider;
  readonly model: string;
  /** The most one call could cost, for the spend guard to reserve beforehand. Free agents say 0. */
  worstCaseUsd(promptTokens: number, maxTokens: number): number;
  act(request: AgentRequest): Promise<AgentReply>;
}

/** A failed call, kept so a replay can fail the same way. */
export class AgentCallError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
