/**
 * ReplayAgent: plays a recorded game back, call by call, for free.
 *
 * The spec (section 3): "ReplayAgent returns recorded responses so a run can
 * be re-simulated exactly." Money rule 4: "Replaying, re-rendering,
 * re-analysing and re-voicing a recorded game must cost nothing." Fed the
 * responses.jsonl of a run, the game produces the same replay, byte for byte.
 */
import type { Provider, Usage } from '../budget/usage';
import { emptyUsage } from '../budget/usage';
import type { Agent, AgentReply, AgentRequest } from './agent';
import { AgentCallError } from './agent';

/** One line of a run's responses.jsonl, as far as replaying needs it. */
export interface RecordedResponse {
  levelIndex: number;
  round: number;
  phase: string;
  bot: string;
  attempt: number;
  provider?: Provider;
  model?: string;
  text?: string;
  usage?: Usage;
  providerCostUsd?: number | null;
  stopReason?: string | null;
  error?: string;
  status?: number;
}

export const responseKey = (r: { levelIndex: number; round: number; phase: string; bot: string; attempt: number }) =>
  `${r.levelIndex}|${r.round}|${r.phase}|${r.bot}|${r.attempt}`;

export class ReplayAgent implements Agent {
  private readonly byKey = new Map<string, RecordedResponse>();
  /** The seat's provider and model, as recorded, so the replay names the same players as the original. */
  readonly provider: Provider;
  readonly model: string;

  constructor(
    readonly id: string,
    recorded: readonly RecordedResponse[],
  ) {
    for (const r of recorded) if (r.bot === id) this.byKey.set(responseKey(r), r);
    const first = recorded.find((r) => r.bot === id);
    this.provider = first?.provider ?? 'mock';
    this.model = first?.model ?? 'replay';
  }

  worstCaseUsd(): number {
    return 0; // a replay never calls anyone
  }

  async act(request: AgentRequest): Promise<AgentReply> {
    const r = this.byKey.get(responseKey(request));
    if (!r) {
      throw new Error(`The recording has no reply for bot ${this.id} at ${responseKey(request)}: the replay has gone past the end of the recorded game, or the game has changed since.`);
    }
    if (r.error !== undefined) throw new AgentCallError(r.error, r.status ?? 0);
    return { text: r.text ?? '', usage: r.usage ?? emptyUsage(), providerCostUsd: r.providerCostUsd ?? null, stopReason: r.stopReason ?? null, raw: { replayed: true } };
  }
}
