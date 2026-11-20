/**
 * The talk cadence and SHOUT (Ingram, 2026-11-20): "let the bot take three
 * moves and speak only once in that time, with the goal of increasing the
 * latency with which communication can impact behaviour", and "the option for
 * a bot to SHOUT which means communicating even out of turn, but this is
 * considered rude by default".
 */
import { describe, expect, it } from 'vitest';
import type { Agent, AgentReply, AgentRequest } from '../agents/agent';
import { MockAgent } from '../agents/mockAgent';
import { runGame } from '../game/game';
import { MemoryOutput } from '../game/output';
import { EMPTY_TURN } from '../game/schema';
import { loadGameConfig } from '../harness/config';
import { loadLevels } from '../harness/levels';

const config = loadGameConfig();
const practice = loadLevels().filter((l) => l.kind === 'practice');

async function play(agents: Agent[], talkEvery: number) {
  const output = new MemoryOutput();
  const result = await runGame({
    seed: 'cadence',
    levels: practice,
    agents,
    ranges: config.hiddenStats,
    maxTokens: { turn: 700, reflection: 1500, diary: 200 },
    output,
    money: null,
    promptTokenLimit: 60_000,
    talkEvery,
  });
  return { result, output };
}

/** A bot that shouts a fixed line in every commit, and says something whenever it may. */
class Shouter implements Agent {
  readonly provider = 'mock' as const;
  readonly model = 'shouter';
  constructor(readonly id: string, private readonly line: string) {}
  worstCaseUsd(): number {
    return 0;
  }
  async act(r: AgentRequest): Promise<AgentReply> {
    const reply =
      r.kind === 'turn'
        ? { ...EMPTY_TURN, commands: r.phase === 'commit' ? ['wait'] : [], say: r.phase === 'commit' ? [] : [{ to: 'all', text: 'hello' }], shout: r.phase === 'commit' ? this.line : '' }
        : r.phase === 'diary'
          ? { diary: 'fine' }
          : { notebook: '', strategy: '', next_name: '', note_to_ingram: '', message_to_ingram: 'hi' };
    return { text: JSON.stringify(reply), usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0, reasoningTokens: 0 }, providerCostUsd: null, stopReason: 'end_turn', raw: null };
  }
}

describe('the talk cadence', () => {
  it('lets the bots talk only every Nth round: the rounds between have one call each, the commit', async () => {
    const { output } = await play(['A', 'B', 'C', 'D', 'E'].map((id) => new MockAgent(id, 'cadence')), 3);
    const prompts = output.prompts.filter((p) => p.rec === 'prompt' && p.attempt === 1 && ['declare', 'talk', 'commit'].includes(p.phase as string));
    const phasesIn = (round: number) => [...new Set(prompts.filter((p) => p.round === round && p.levelIndex === 0).map((p) => p.phase))].sort();
    expect(phasesIn(1)).toEqual(['commit', 'declare', 'talk']);
    expect(phasesIn(2)).toEqual(['commit']);
    expect(phasesIn(3)).toEqual(['commit']);
    expect(phasesIn(4)).toEqual(['commit', 'declare', 'talk']);
    // And each bot is told which rounds have talk, and that this one is silent.
    const silent = output.prompts.find((p) => p.rec === 'prompt' && p.round === 2 && p.phase === 'commit') as { user: string };
    expect(silent.user).toContain('In this room you can talk only every 3 rounds (rounds 1, 4). This round is silent');
  });
});

describe('a shout', () => {
  it('is heard by everyone, even in a silent round, and is cut at 12 words', async () => {
    const long = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen';
    const { result } = await play(['A', 'B', 'C', 'D', 'E'].map((id) => new Shouter(id, id === 'A' ? long : '')), 3);
    const shouts = result.events.filter((e) => e.type === 'shout');
    expect(shouts.length).toBeGreaterThan(0);
    for (const s of shouts) {
      expect(s.visibleTo).toEqual(['A', 'B', 'C', 'D', 'E']);
      if (s.type === 'shout') expect(s.text.replace(/\s*…$/, '').split(' ')).toHaveLength(12); // a cut is marked with an ellipsis
    }
    // Shouts from a silent round's commit, too.
    expect(shouts.some((s) => s.round === 2)).toBe(true);
    expect(result.events.some((e) => e.type === 'refused' && e.from === 'A' && e.what === 'long shout')).toBe(true);
  });
});
