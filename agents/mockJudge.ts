/**
 * MockJudge: a free, deterministic stand-in for the silent judge (prompts/host.ts), for tests and free games.
 *
 * It can't tell character from noise, so it scores something it can count: how many different words an
 * introduction uses, shifted by the bot's letter and the room so that all three verdicts turn up in a free
 * game. Its reasons carry markers like the mock bots' words, so the leak test can prove that no bot ever
 * reads why it was scored.
 */
import { emptyUsage } from '../budget/usage';
import type { Agent, AgentReply, AgentRequest } from './agent';
import { JUDGE_ID } from './agent';

const MARKER = /\[\[m:[^\]]+\]\]/g;

export class MockJudge implements Agent {
  readonly id = JUDGE_ID;
  readonly provider = 'mock' as const;
  readonly model = 'mock-judge';
  private count = 0;

  worstCaseUsd(): number {
    return 0;
  }

  async act(request: AgentRequest): Promise<AgentReply> {
    const verdicts = (request.judging ?? []).map((it) => {
      const words = new Set(`${it.introduction} ${it.answer}`.replace(MARKER, ' ').toLowerCase().match(/[a-z']+/g) ?? []);
      const score = ((words.size + it.bot.charCodeAt(0) + request.levelIndex) % 7) - 3;
      this.count += 1;
      return { bot: it.bot, score, reason: `[[m:${request.level}:0:judge:${JUDGE_ID}:reason:${this.count}]] ${words.size} different words` };
    });
    return { text: JSON.stringify({ verdicts }), usage: emptyUsage(), providerCostUsd: null, stopReason: 'end_turn', raw: { mock: true } };
  }
}
