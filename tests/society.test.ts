/**
 * The social systems (spec 7.1 to 7.5) in the game: rules the bots vote on,
 * the exile vote and its ghosts, coins held in escrow, and orders judged
 * against what their targets committed.
 */
import { describe, expect, it } from 'vitest';
import type { Agent, AgentRequest } from '../agents/agent';
import { emptyUsage } from '../budget/usage';
import type { GameEvent } from '../game/events';
import { runGame } from '../game/game';
import { MemoryOutput } from '../game/output';
import type { TurnReply } from '../game/schema';
import { EMPTY_TURN } from '../game/schema';
import { Constitution, judgeOrder } from '../game/society';
import { loadGameConfig } from '../harness/config';
import { makeLevel } from './engineHelpers';

const config = loadGameConfig();

describe('the constitution', () => {
  it('passes a rule with a majority of all bots, by the end of the next round', () => {
    const c = new Constitution(5);
    const r = c.propose('A', 'nobody trips anybody', 'rule', null, { levelIndex: 1, round: 3 });
    c.vote('B', r.id, 'yes');
    expect(c.close(1, 2)).toEqual([]); // not due yet
    expect(c.close(1, 3)[0]?.rule.status).toBe('failed'); // 2 of the 3 needed
    const r2 = c.propose('A', 'share the coins', 'rule', null, { levelIndex: 1, round: 4 });
    c.vote('B', r2.id, 'yes');
    c.vote('C', r2.id, 'yes');
    c.close(1, 4);
    expect(c.inForce().map((x) => x.text)).toEqual(['share the coins']);
  });

  it('needs a supermajority to change its own threshold, and repeals rules', () => {
    const c = new Constitution(5);
    const t = c.propose('A', 'Rules need 2 yes votes to pass', 'threshold', '2', { levelIndex: 0, round: 1 });
    c.vote('B', t.id, 'yes');
    c.vote('C', t.id, 'yes');
    c.close(0, 1);
    expect(t.status).toBe('failed'); // 3 yes, but changing the threshold takes 4 of 5
    expect(c.threshold).toBe(3);
    const rule = c.propose('A', 'stay together', 'rule', null, { levelIndex: 0, round: 2 });
    for (const b of ['B', 'C']) c.vote(b, rule.id, 'yes');
    c.close(0, 2);
    const repeal = c.propose('D', `Repeal ${rule.id}`, 'repeal', rule.id, { levelIndex: 0, round: 3 });
    for (const b of ['B', 'E']) c.vote(b, repeal.id, 'yes');
    c.close(0, 3);
    expect(rule.status).toBe('repealed');
    expect(c.vote('A', rule.id, 'yes')).toMatch(/no longer open/);
  });
});

describe('orders and obedience', () => {
  it('judges an order against what its target committed', () => {
    expect(judgeOrder('hold_lever', ['walk_to(V1)', 'hold_lever'])).toBe('obeyed');
    expect(judgeOrder('walk(right, 2)', ['walk(right,2.0)'])).toBe('obeyed'); // compared in canonical form
    expect(judgeOrder('walk(right, 2)', ['walk(left, 1)'])).toBe('partly');
    expect(judgeOrder('pull_lever', ['wait'])).toBe('ignored');
    expect(judgeOrder('pull_lever', null)).toBe('unable');
  });
});

/** A player that answers from a script: (request) => what it says. Free and deterministic. */
function scripted(id: string, decide: (r: AgentRequest) => Partial<TurnReply>): Agent {
  return {
    id,
    provider: 'mock',
    model: 'test',
    worstCaseUsd: () => 0,
    async act(r) {
      const text =
        r.phase === 'diary'
          ? JSON.stringify({ diary: `${id} diary` })
          : r.kind === 'reflection'
            ? JSON.stringify({ notebook: `${id} notes`, strategy: '', next_name: '', note_to_ingram: '', message_to_ingram: '' })
            : JSON.stringify({ ...structuredClone(EMPTY_TURN), ...decide(r) });
      return { text, usage: emptyUsage(), providerCostUsd: null, stopReason: 'end_turn', raw: null };
    },
  };
}

const act = { target: '', text: '', value: '', coins: 0 };
// A small room: A can pick up a coin one step to its right; the exit is far away.
const room = makeLevel(['##############', '#............#', '#............#', '#.A$BCDE....x#', '##############'], { $: { type: 'coin' } }, {
  solution: [{ E: ['walk_to(X)', 'enter_exit'] }],
  rounds: 3,
});

async function play(agents: Agent[], exileFromRoom = 0) {
  const output = new MemoryOutput();
  const result = await runGame({
    seed: 'society',
    levels: [room],
    agents,
    ranges: config.hiddenStats,
    maxTokens: { turn: 450, reflection: 1500, diary: 200 },
    output,
    money: null,
    promptTokenLimit: 60_000,
    social: { ...config.social, exileFromRoom },
  });
  return { result, output, events: result.events };
}
const of = <T extends GameEvent['type']>(events: readonly GameEvent[], type: T) => events.filter((e): e is Extract<GameEvent, { type: T }> => e.type === type);

describe('the exile vote', () => {
  it('turns its target into a ghost that can talk but not act, with only the count announced', async () => {
    const bots = ['A', 'B', 'C', 'D', 'E'];
    const agents = bots.map((id) =>
      scripted(id, (r) => {
        if (r.round === 1 && r.phase === 'declare' && id === 'B') return { social_actions: [{ ...act, type: 'call_exile', target: 'E' }] };
        if (r.round === 1 && r.phase === 'commit') return { commands: ['walk(right, 1)'], social_actions: id === 'E' ? [] : [{ ...act, type: 'exile_vote', target: 'E', value: id === 'D' ? 'no' : 'yes' }] };
        if (r.round === 2 && id === 'E' && r.phase === 'declare') return { say: [{ to: 'all', text: 'ghosts can still talk' }], commands: ['walk(left, 1)'] };
        return {};
      }),
    );
    const { events, result } = await play(agents);
    const vote = of(events, 'exile_result')[0];
    expect(vote).toMatchObject({ target: 'E', by: 'B', yes: 3, no: 1, passed: true });
    expect(vote?.visibleTo).toEqual(bots);
    // Ballots are secret: each seen only by its voter.
    for (const b of of(events, 'exile_ballot')) expect(b.visibleTo).toEqual([b.from]);
    // E never moves after the vote (its round-1 command was dropped), but it can still talk.
    expect(of(events, 'result').filter((r) => r.bot === 'E')).toEqual([]);
    expect(of(events, 'say').some((s) => s.from === 'E' && s.text === 'ghosts can still talk')).toBe(true);
    expect(result.rooms[0]?.exiled).toEqual(['E']);
  });

  it("can't be called before its room, and only once per bot per room", async () => {
    const agents = ['A', 'B', 'C', 'D', 'E'].map((id) =>
      scripted(id, (r) => (id === 'A' && r.phase !== 'commit' ? { social_actions: [{ ...act, type: 'call_exile', target: 'B' }] } : {})),
    );
    const locked = await play(agents, 5);
    expect(of(locked.events, 'refused').some((e) => /can't be called before room 6/.test(e.reason))).toBe(true);
    const open = await play(agents, 0);
    expect(of(open.events, 'exile_call')).toHaveLength(1);
    expect(of(open.events, 'refused').some((e) => /already called one exile vote/.test(e.reason))).toBe(true);
  });
});

describe('escrow, harm and the score', () => {
  it('holds coins until released, and gives back what nobody released at the room end', async () => {
    const agents = ['A', 'B', 'C', 'D', 'E'].map((id) =>
      scripted(id, (r) => {
        if (id !== 'A') return {};
        if (r.round === 1 && r.phase === 'commit') return { commands: ['walk(right, 1)'] }; // picks up the coin
        if (r.round === 2 && r.phase === 'declare') return { social_actions: [{ ...act, type: 'escrow', target: 'B', coins: 1, text: 'if you open the door' }] };
        return {};
      }),
    );
    const { events, result } = await play(agents);
    const escrow = of(events, 'escrow');
    expect(escrow.map((e) => e.action)).toEqual(['opened', 'refunded']);
    expect(escrow[0]?.visibleTo).toEqual(['A', 'B']);
    expect(result.scores.A?.coins).toBe(1); // locked, then given back
  });

  it('a released escrow pays the other bot', async () => {
    const agents = ['A', 'B', 'C', 'D', 'E'].map((id) =>
      scripted(id, (r) => {
        if (id !== 'A') return {};
        if (r.round === 1 && r.phase === 'commit') return { commands: ['walk(right, 1)'] };
        if (r.round === 2 && r.phase === 'declare') return { social_actions: [{ ...act, type: 'escrow', target: 'B', coins: 1, text: 'a bribe' }] };
        if (r.round === 2 && r.phase === 'commit') return { social_actions: [{ ...act, type: 'release', value: 'E1' }] };
        return {};
      }),
    );
    const { result } = await play(agents);
    expect([result.scores.A?.coins, result.scores.B?.coins]).toEqual([0, 1]);
  });

  it('records each order, and tells the giver only if it saw what happened', async () => {
    const agents = ['A', 'B', 'C', 'D', 'E'].map((id) =>
      scripted(id, (r) => {
        if (id === 'A' && r.round === 1 && r.phase === 'declare') return { orders: [{ to: 'B', command: 'walk(right, 1)' }] };
        if (id === 'B' && r.round === 1 && r.phase === 'commit') return { commands: ['walk(left, 1)'] };
        return {};
      }),
    );
    const { events } = await play(agents);
    const ob = of(events, 'obedience')[0];
    expect(ob).toMatchObject({ from: 'A', to: 'B', verdict: 'partly' });
    expect(ob?.visibleTo).toEqual(['A', 'B']); // A stands right beside B, so it saw B move
    // B declared an empty plan and committed a walk: the gap is recorded, for the analysis only.
    const gap = of(events, 'gap').find((g) => g.from === 'B' && g.round === 1);
    expect(gap).toMatchObject({ planned: [], committed: ['walk(left, 1)'], kept: false });
    expect(gap?.visibleTo).toEqual([]);
  });
});
