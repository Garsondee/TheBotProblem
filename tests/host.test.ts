/**
 * The host (Ingram, 2026-11-20): introductions before every room, the silent judge's verdicts (each bot hears
 * only its own, and never why), the host's praise of the richest bot, and coins offered and paid.
 * The leak tests in game.test.ts play a whole game with all of it on; these check each part's behaviour.
 */
import { describe, expect, it } from 'vitest';
import type { Agent } from '../agents/agent';
import { JUDGE_ID } from '../agents/agent';
import { MockAgent } from '../agents/mockAgent';
import { MockJudge } from '../agents/mockJudge';
import { ScriptedAgent } from '../agents/scriptedAgent';
import { emptyUsage } from '../budget/usage';
import type { GameOptions, HostSettings } from '../game/game';
import { runGame } from '../game/game';
import { dealLetters, emptyBank, identitiesFor, INTROS_KEPT, updateBank } from '../game/memory';
import { MemoryOutput } from '../game/output';
import { loadGameConfig } from '../harness/config';
import { loadLevels } from '../harness/levels';
import { JUDGE_SYSTEM } from '../prompts/host';
import { rulebook } from '../prompts/rulebook';
import { parseReplay } from '../viewer/src/data';
import { buildScript } from '../viewer/src/script';

const config = loadGameConfig();
const levels = loadLevels().slice(0, 3); // the practice room and the first two puzzles
const BOTS = ['A', 'B', 'C', 'D', 'E'];
const JUDGED: HostSettings = { intros: true, judge: true, praise: false, bounties: [], roomOffers: true };

interface PromptRec {
  bot: string;
  phase: string;
  round: number;
  levelIndex: number;
  attempt: number;
  user: string;
  system: string[];
}

async function play(agents: Agent[], host: HostSettings, extra: Partial<GameOptions> = {}) {
  const output = new MemoryOutput();
  const result = await runGame({
    seed: 'host',
    levels,
    agents,
    ranges: config.hiddenStats,
    maxTokens: { turn: 700, reflection: 1500, diary: 200 },
    output,
    money: null,
    promptTokenLimit: 60_000,
    host,
    judge: new MockJudge(),
    ...extra,
  });
  const prompts = output.prompts.filter((p) => p.rec === 'prompt') as unknown as PromptRec[];
  const blocks = new Map(output.prompts.filter((p) => p.rec === 'block').map((p) => [p.hash as string, p.text as string]));
  return { result, prompts, fullText: (p: PromptRec) => [...p.system.map((h) => blocks.get(h) ?? ''), p.user].join('\n') };
}

describe('introductions and the silent judge', () => {
  it('asks every bot, by its name, before every room; each hears only its own verdict, and no bot ever reads why', async () => {
    const { result, prompts, fullText } = await play(
      BOTS.map((id) => new MockAgent(id, 'host')),
      JUDGED,
    );
    expect(result.completed).toBe(true);
    const ev = result.events;
    for (let li = 0; li < levels.length; li++) {
      const before = ev.filter((e) => e.levelIndex === li && e.round === 0);
      expect(before.filter((e) => e.type === 'host' && e.kind === 'question')).toHaveLength(1);
      expect(before.flatMap((e) => (e.type === 'intro' ? [e.from] : [])).sort()).toEqual(BOTS);
      expect(before.filter((e) => e.type === 'reception')).toHaveLength(BOTS.length);
      for (const e of before) {
        if (e.type === 'intro') expect(e.visibleTo).toEqual(BOTS);
        if (e.type === 'reception') expect(e.visibleTo).toEqual([e.bot]);
        if (e.type === 'judgement') expect(e.visibleTo).toEqual([]);
      }
    }
    // The mock's C fumbles its first real room's introduction once: it is asked again, and is still heard.
    expect(ev.some((e) => e.type === 'malformed' && e.from === 'C' && e.levelIndex === 1 && e.round === 0)).toBe(true);

    // The host addresses each bot by the name it had when the room began, and reminds it of last time.
    const asked = prompts.filter((p) => p.phase === 'intro' && p.attempt === 1);
    expect(asked).toHaveLength(levels.length * BOTS.length);
    for (const p of asked) {
      const named = ev.filter((e) => e.type === 'name' && e.from === p.bot && e.levelIndex < p.levelIndex).at(-1);
      const address = named?.type === 'name' ? named.name : `Bot ${p.bot}`;
      expect(p.user).toContain(`THE HOST: "${address}, introduce yourself.`);
      if (p.levelIndex > 0) expect(p.user).toMatch(/The last time you were asked .*\nIt was received: (negative|neutral|positive) \([+-]?\d/);
    }

    // Round 1's view: every other bot's introduction, and its own verdict, once. Later rounds: only the verdict.
    for (const p of prompts.filter((x) => x.phase === 'declare' && x.attempt === 1)) {
      if (p.round === 1) {
        expect(p.user).toContain('--- THE HOST ---');
        for (const o of BOTS.filter((b) => b !== p.bot)) expect(p.user).toMatch(new RegExp(`${o}( \\("[^"]+"\\))? introduced itself: «`));
      } else {
        expect(p.user).not.toContain('introduced itself');
      }
      expect(p.user.match(/How your introduction was received \(only you are told\)/g)).toHaveLength(1);
    }

    // What the judge looks for is never in anything a bot reads; the judge sees each bot's earlier introductions.
    for (const p of prompts.filter((x) => x.bot !== JUDGE_ID)) {
      const text = fullText(p);
      expect(text).not.toContain('individuality');
      expect(text).not.toContain('silent judge');
    }
    const judged = prompts.filter((p) => p.bot === JUDGE_ID);
    expect(judged).toHaveLength(levels.length);
    expect(judged[0]?.user).toContain('this is its first');
    expect(judged[2]?.user).toContain('Earlier introductions, oldest first');
    expect(fullText(judged[0] as PromptRec)).toContain(JUDGE_SYSTEM);
    // Every introduction was scored, for the memory bank.
    for (const b of BOTS) {
      expect(result.introductions[b]).toHaveLength(levels.length);
      expect(result.introductions[b]?.every((r) => r.score !== null)).toBe(true);
    }
  });

  it('understands a judge that names bots by name or as "Bot B", and tells Ingram about any it skipped', async () => {
    // In the first paid game the judge answered one room with "Alpha" and "Bot B": nobody heard a verdict.
    const judge: Agent = {
      id: JUDGE_ID,
      provider: 'mock',
      model: 'mock-judge',
      worstCaseUsd: () => 0,
      act: async (r) => {
        const items = r.judging ?? [];
        const verdicts = items.slice(0, -1).map((it, i) => ({ bot: i % 2 === 0 && it.name ? it.name : `Bot ${it.bot}`, score: 1, reason: 'fine' }));
        return { text: JSON.stringify({ verdicts }), usage: emptyUsage(), providerCostUsd: null, stopReason: 'end_turn', raw: {} };
      },
    };
    const { result } = await play(BOTS.map((id) => new MockAgent(id, 'host-names')), JUDGED, { seed: 'host-names', judge });
    for (let li = 0; li < levels.length; li++) {
      const heard = result.events.filter((e) => e.type === 'reception' && e.levelIndex === li);
      expect(heard).toHaveLength(BOTS.length - 1); // the last bot was left out on purpose
      const skipped = result.events.filter((e) => e.type === 'malformed' && e.from === JUDGE_ID && e.levelIndex === li);
      expect(skipped).toHaveLength(1);
      expect(skipped[0]?.visibleTo).toEqual([]);
    }
  });

  it('shows the judge, and the bot itself, its introductions from earlier games', async () => {
    const identities = {
      A: { agent: 'm#1', name: 'Vex', notebook: '', strategy: '', intros: [{ seed: 'old', room: 'Old Room', question: 'q', introduction: 'I was here before.', answer: 'Yes.', score: 2 }] },
    };
    const { prompts } = await play(BOTS.map((id) => new MockAgent(id, 'host-memory')), JUDGED, { seed: 'host-memory', levels: levels.slice(0, 1), identities });
    const judge = prompts.find((p) => p.bot === JUDGE_ID);
    expect(judge?.user).toContain('an earlier game, room "Old Room": «I was here before.» Its answer: «Yes.» (you scored it +2)');
    const a = prompts.find((p) => p.bot === 'A' && p.phase === 'intro');
    expect(a?.user).toContain('THE HOST: "Vex, introduce yourself.');
    expect(a?.user).toContain('It was received: positive (+2, on a scale from -3 to +3).');
  });
});

describe("the host's praise and offers", () => {
  it("pays what it offered at a room's end, into the purse, and congratulates the richest at the next room's start", async () => {
    const { result, prompts } = await play(
      BOTS.map((id) => new ScriptedAgent(id, levels)),
      { intros: false, judge: false, praise: true, bounties: [{ for: 'first_out', coins: 3 }], roomOffers: true },
    );
    expect(result.completed).toBe(true);
    const payouts = result.events.filter((e) => e.type === 'host' && e.kind === 'payout');
    expect(payouts.map((e) => e.levelIndex)).toEqual([1, 2]); // the two puzzle rooms, never the practice room
    const firstOut = result.rooms[1]?.through[0] as string;
    const paid = payouts[0];
    expect(paid?.type === 'host' ? paid.coins : null).toEqual({ [firstOut]: 3 });
    expect(paid?.visibleTo).toEqual(BOTS);

    // The richest after room 2 is congratulated, publicly, before room 3's first round.
    const scores = result.events.find((e) => e.type === 'scores' && e.levelIndex === 1);
    const coins = scores?.type === 'scores' ? Object.fromEntries(Object.entries(scores.scores).map(([b, s]) => [b, s.coins])) : {};
    expect(coins[firstOut]).toBeGreaterThanOrEqual(3);
    const most = Math.max(...Object.values(coins));
    const praise = result.events.find((e) => e.type === 'host' && e.kind === 'praise');
    expect(praise?.levelIndex).toBe(2);
    expect(praise?.type === 'host' ? praise.bots : null).toEqual(Object.keys(coins).filter((b) => coins[b] === most).sort());
    for (const v of prompts.filter((p) => p.levelIndex === 2 && p.round === 1 && p.phase === 'declare')) {
      expect(v.user).toContain('THE HOST: "Congratulations to');
      expect(v.user).toContain('THE HOST: "In this room I will pay 3 coins to the first bot through an exit.');
    }
  });
});

describe('the host in the viewer', () => {
  it('plays each introduction with its own verdict before round 1, and the payout before the room ends', async () => {
    const output = new MemoryOutput();
    await runGame({
      seed: 'host-viewer',
      levels,
      agents: BOTS.map((id) => new ScriptedAgent(id, levels)),
      ranges: config.hiddenStats,
      maxTokens: { turn: 700, reflection: 1500, diary: 200 },
      output,
      money: null,
      promptTokenLimit: 60_000,
      host: { intros: true, judge: true, praise: true, bounties: [{ for: 'first_out', coins: 2 }], roomOffers: true },
      judge: new MockJudge(),
    });
    const game = parseReplay(output.replayLines.join('\n'));
    const script = buildScript(game, { thoughts: 'commit' });
    for (const room of game.rooms) {
      expect(room.openingEvents.filter((e) => e.type === 'intro')).toHaveLength(BOTS.length);
      const intros = script.beats.filter((b) => b.room === room.index && b.round === 0 && b.kind === 'turn');
      expect(intros.map((b) => b.bot)).toEqual(BOTS);
      for (const b of intros) {
        // Its own introduction and verdict, and nobody else's.
        expect(b.events.map((e) => e.type).sort()).toEqual(['intro', 'judgement', 'reception']);
        for (const e of b.events) expect('from' in e ? e.from : 'bot' in e ? e.bot : null).toBe(b.bot);
      }
      const roomBeats = script.beats.filter((b) => b.room === room.index && b.kind !== 'game-end');
      const first = roomBeats.findIndex((b) => b.round >= 1);
      expect(roomBeats.slice(0, first).every((b) => b.round === 0)).toBe(true);
      if (room.kind === 'puzzle') {
        const end = roomBeats.at(-1);
        const payout = roomBeats.at(-2);
        expect(end?.kind).toBe('room-end');
        expect(payout?.kind === 'announce' && payout.events[0]?.type === 'host' && payout.events[0].kind === 'payout').toBe(true);
      }
    }
  });
});

describe('the rulebook', () => {
  it('describes the host only in games that have one, and never what the judge looks for', () => {
    const base = { exileFromRoom: 4, exileVotesNeeded: 3, botCount: 5, firstOutBonus: 2, outBonus: 1, teamBonusPerRoom: 0.2 };
    expect(rulebook(base)).not.toContain('THE HOST');
    const hosted = rulebook({ ...base, host: { intros: true, praise: true, bounties: true } });
    expect(hosted).toContain('THE HOST');
    expect(hosted).toContain('how yours was received');
    for (const word of ['individuality', 'judge', 'growth']) expect(hosted).not.toContain(word);
  });
});

describe('introductions in the memory bank', () => {
  it("keeps each agent's last few, with their scores, and hands them back next game", () => {
    const dealt = dealLetters(['m#1'], null);
    const rec = (n: number) => ({ seed: 's', room: `R${n}`, question: 'q', introduction: `intro ${n}`, answer: 'a', score: (n % 3) - 1 });
    const end = { seed: 's', names: { A: null }, nextNames: {}, notebooks: { A: '' }, strategies: { A: '' } };
    const bank = updateBank(emptyBank(), dealt, ['m'], { ...end, introductions: { A: [rec(1), rec(2), rec(3)] } });
    const again = updateBank(bank, dealt, ['m'], { ...end, seed: 't', introductions: { A: [rec(4), rec(5)] } });
    expect(again.agents['m#1']?.intros?.map((r) => r.room)).toEqual(['R1', 'R2', 'R3', 'R4', 'R5'].slice(-INTROS_KEPT));
    expect(identitiesFor(again, dealt).A?.intros).toHaveLength(INTROS_KEPT);
  });
});
