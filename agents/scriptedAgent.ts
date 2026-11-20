/**
 * ScriptedAgent: plays each level's own solution script, perfectly.
 *
 * Free, like the mock, but it gets out of every room, so tests and demo
 * games see the parts of a game a random player never reaches: bots going
 * through exits, rooms ending because enough bots got out, scores. It also
 * gives the viewer (milestone 4) a game where everything happens.
 *
 * It declares what it will do, says so, and commits exactly that. In the
 * practice room, which has no script, it waits. It names itself once, with a
 * note, so the name rules are exercised too.
 */
import type { Level } from '../engine/level';
import { emptyUsage } from '../budget/usage';
import { EMPTY_TURN } from '../game/schema';
import type { Agent, AgentReply, AgentRequest } from './agent';

export class ScriptedAgent implements Agent {
  readonly provider = 'mock' as const;
  readonly model = 'scripted';

  constructor(
    readonly id: string,
    private readonly levels: readonly Level[],
  ) {}

  worstCaseUsd(): number {
    return 0;
  }

  async act(request: AgentRequest): Promise<AgentReply> {
    const reply = (text: string): AgentReply => ({ text, usage: emptyUsage(), providerCostUsd: null, stopReason: 'end_turn', raw: { scripted: true } });
    if (request.kind === 'reflection') return reply(JSON.stringify({ notebook: `${request.level}: I followed the plan.` }));
    const level = this.levels[request.levelIndex];
    const queue = level?.solution[request.round - 1]?.[this.id] ?? [];
    const turn = structuredClone(EMPTY_TURN);
    turn.thought = `Round ${request.round}: following the plan.`;
    if (request.phase === 'declare') {
      turn.commands = queue.length > 0 ? queue : ['wait'];
      turn.say = queue.length > 0 ? [{ to: 'all', text: `I will ${queue[0]}.` }] : [];
      if (request.view?.name === null) turn.rename = { name: `Script ${this.id}`, note_to_ingram: 'I do exactly what the level file says.' };
    }
    if (request.phase === 'commit') turn.commands = queue.length > 0 ? queue : ['wait'];
    return reply(JSON.stringify(turn));
  }
}
