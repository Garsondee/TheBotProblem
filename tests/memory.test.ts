/**
 * Memory across games (Ingram, 2026-11-20): names last as long as an agent's
 * memory does, and a bot may rename itself privately at the end of a game,
 * starting the next one with a new name and its old memories.
 */
import { describe, expect, it } from 'vitest';
import { MockAgent } from '../agents/mockAgent';
import { Rng } from '../engine/random';
import { runGame } from '../game/game';
import type { MemoryBank } from '../game/memory';
import { agentIdsFor, dealLetters, emptyBank, identitiesFor, updateBank } from '../game/memory';
import { MemoryOutput } from '../game/output';
import { loadGameConfig } from '../harness/config';
import { loadLevels } from '../harness/levels';
import { bankFromReplay } from '../harness/memoryFiles';
import { parseReplay, startNames } from '../viewer/src/data';

const config = loadGameConfig();
const practice = loadLevels().filter((l) => l.kind === 'practice');

describe('agents and letters', () => {
  it('gives each seat a lasting id: its own, or its model and a number', () => {
    expect(agentIdsFor([{ model: 'haiku' }, { model: 'haiku' }, { model: 'deepseek' }, { model: 'x', agent: 'my-bot' }])).toEqual(['haiku#1', 'haiku#2', 'deepseek#1', 'my-bot']);
  });

  it('deals letters in cast order without memory, and shuffled (seeded) with it', () => {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    expect(dealLetters(ids, null).map((d) => d.agent)).toEqual(ids);
    const one = dealLetters(ids, new Rng('deal'));
    const again = dealLetters(ids, new Rng('deal'));
    expect(one).toEqual(again);
    expect(one.map((d) => d.letter)).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect([...one.map((d) => d.agent)].sort()).toEqual(ids);
  });
});

describe('the memory bank', () => {
  const dealt = dealLetters(['m#1', 'm#2'], null);
  const after = (bank: MemoryBank, nextNames: Record<string, string>) =>
    updateBank(bank, dealt, ['m', 'm'], {
      seed: 's',
      names: { A: 'Echo', B: null },
      nextNames,
      notebooks: { A: 'A remembers the door', B: 'B remembers the crate' },
      strategies: { A: 'go first', B: '' },
    });

  it('keeps each agent its notebook, strategy and name, and a record of the game', () => {
    const bank = after(emptyBank(), {});
    expect(bank.agents['m#1']).toMatchObject({ name: 'Echo', notebook: 'A remembers the door', strategy: 'go first' });
    expect(bank.agents['m#1']?.games).toEqual([{ seed: 's', letter: 'A', startName: null, endName: 'Echo' }]);
    expect(identitiesFor(bank, dealLetters(['m#2', 'm#1'], null))).toEqual({
      A: { agent: 'm#2', name: null, notebook: 'B remembers the crate', strategy: '' },
      B: { agent: 'm#1', name: 'Echo', notebook: 'A remembers the door', strategy: 'go first' },
    });
  });

  it('carries a private new name into the next game, with the old memories', () => {
    const bank = after(emptyBank(), { A: 'Nova' });
    expect(bank.agents['m#1']?.name).toBe('Nova');
    expect(bank.agents['m#1']?.notebook).toBe('A remembers the door');
  });
});

describe('a game played with memories', () => {
  it('starts each bot with its name and notebook, and a bank can be made from a recorded game', async () => {
    const first = new MemoryOutput();
    const r1 = await runGame({
      seed: 'mem-1',
      levels: practice,
      agents: ['A', 'B', 'C', 'D', 'E'].map((id) => new MockAgent(id, 'mem-1')),
      ranges: config.hiddenStats,
      maxTokens: { turn: 450, reflection: 1500, diary: 200 },
      output: first,
      money: null,
      promptTokenLimit: 60_000,
      maxRounds: 1,
    });
    const bank = bankFromReplay(first.replayLines.join('\n'), 'mem-1');
    const ids = Object.keys(bank.agents);
    expect(ids).toHaveLength(5);
    // Each agent carries the name it ended with (or chose privately for next time) and its notebook.
    const a = bank.agents[ids[0] as string];
    expect(a?.name).toBe(r1.nextNames.A ?? r1.names.A);
    expect(a?.notebook).toBe(r1.notebooks.A);

    const dealt = dealLetters(ids, new Rng('mem-2'));
    const identities = identitiesFor(bank, dealt);
    const second = new MemoryOutput();
    const r2 = await runGame({
      seed: 'mem-2',
      levels: practice,
      agents: dealt.map((d) => new MockAgent(d.letter, 'mem-2')),
      ranges: config.hiddenStats,
      maxTokens: { turn: 450, reflection: 1500, diary: 200 },
      output: second,
      money: null,
      promptTokenLimit: 60_000,
      maxRounds: 1,
      identities,
    });
    void r2;
    // The game header records which agent sits in each letter, and the name it brought.
    const header = JSON.parse(second.replayLines[0] as string) as { seats: { bot: string; agent: string; startName: string | null }[] };
    for (const d of dealt) {
      const seat = header.seats.find((s) => s.bot === d.letter);
      expect(seat?.agent).toBe(d.agent);
      expect(seat?.startName).toBe(bank.agents[d.agent]?.name ?? null);
    }
    // The viewer starts each bot with the name it brought, before any naming in this game.
    const viewed = parseReplay(second.replayLines.join('\n'));
    expect(startNames(viewed)).toEqual(Object.fromEntries(dealt.map((d) => [d.letter, bank.agents[d.agent]?.name ?? null])));
    // And its old notebook is in its prompt from the very first call.
    const blocks = new Map(second.prompts.filter((p) => p.rec === 'block').map((p) => [p.hash, p.text as string]));
    const firstCall = second.prompts.find((p) => p.rec === 'prompt' && p.bot === 'A') as { system: string[] };
    const identityText = blocks.get(firstCall.system[1] as string) ?? '';
    expect(identityText).toContain(identities.A?.notebook ?? 'missing');
  });
});
