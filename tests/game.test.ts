/**
 * Milestone 3's acceptance test (docs/SPEC.md section 9): "Full 6-level mock
 * game; no bot view contains events outside its audience (automated leak
 * test)." Plus determinism and replay: "The same seed and the same recorded
 * responses must reproduce an identical replay, byte for byte."
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { Agent } from '../agents/agent';
import { JUDGE_ID } from '../agents/agent';
import { markersIn, MockAgent } from '../agents/mockAgent';
import { MockJudge } from '../agents/mockJudge';
import type { RecordedResponse } from '../agents/replayAgent';
import { ReplayAgent } from '../agents/replayAgent';
import { ScriptedAgent } from '../agents/scriptedAgent';
import { Ledger } from '../budget/ledger';
import { SpendGuard } from '../budget/spendGuard';
import { emptyUsage } from '../budget/usage';
import type { GameEvent } from '../game/events';
import type { GameResult } from '../game/game';
import { runGame } from '../game/game';
import { MemoryOutput } from '../game/output';
import { loadGameConfig } from '../harness/config';
import { loadLevels } from '../harness/levels';

const config = loadGameConfig();
const levels = loadLevels();
const BOTS = ['A', 'B', 'C', 'D', 'E'];
const SLOW = 120_000;

async function play(seed: string, agents: Agent[], extra: Partial<Parameters<typeof runGame>[0]> = {}) {
  const output = new MemoryOutput();
  const result = await runGame({
    seed,
    levels,
    agents,
    ranges: config.hiddenStats,
    maxTokens: { turn: config.maxTokens.turn, reflection: config.maxTokens.reflection },
    output,
    money: null,
    promptTokenLimit: config.budget.promptTokenHardLimit,
    ...extra,
  });
  return { result, output };
}

const mocks = (seed: string) => BOTS.map((id) => new MockAgent(id, seed));
/**
 * The acceptance game has the whole host on (introductions, the silent judge, praise, offers), so the leak
 * tests cover its two private channels too: each bot's verdict, and the judge's reasons, which no bot sees.
 */
const HOST = { intros: true, judge: true, praise: true, bounties: [{ for: 'first_out' as const, coins: 2 }, { for: 'holding_lever' as const, coins: 1 }], roomOffers: true };
const hosted = (judge: Agent = new MockJudge()) => ({ host: HOST, judge });

/** Every prompt as the full text a model would read: the cached blocks, then the view. */
function fullPrompts(output: MemoryOutput): { bot: string; text: string; usedEventIds: number[]; key: string }[] {
  const blocks = new Map(output.prompts.filter((p) => p.rec === 'block').map((p) => [p.hash as string, p.text as string]));
  return output.prompts
    .filter((p) => p.rec === 'prompt')
    .map((p) => ({
      bot: p.bot as string,
      text: [...(p.system as string[]).map((h) => blocks.get(h) ?? ''), p.user as string].join('\n'),
      usedEventIds: p.usedEventIds as number[],
      key: `${p.levelIndex}|${p.round}|${p.phase}|${p.bot}|${p.attempt}`,
    }));
}

describe('a full mock game', () => {
  let game: { result: GameResult; output: MemoryOutput };
  let byId: Map<number, GameEvent>;
  beforeAll(async () => {
    game = await play('m3-acceptance', mocks('m3-acceptance'), hosted());
    byId = new Map(game.result.events.map((e) => [e.id, e]));
  }, SLOW);

  it('plays every room: the practice room and six puzzles', () => {
    const { result } = game;
    expect(result.completed).toBe(true);
    expect(result.rooms.map((r) => r.id)).toEqual(levels.map((l) => l.id));
    expect(result.rooms.filter((r) => r.kind === 'puzzle')).toHaveLength(6);
    for (const r of result.rooms) expect(r.roundsPlayed).toBeGreaterThan(0);
    // Every bot reflects at the end of every room (unless its reply was unusable twice).
    const notebooks = result.events.filter((e) => e.type === 'notebook');
    expect(notebooks.length).toBeGreaterThanOrEqual(levels.length * BOTS.length - 3);
  });

  it('LEAK TEST: every event a prompt was built from was visible to that bot', () => {
    const prompts = fullPrompts(game.output);
    expect(prompts.length).toBeGreaterThan(1000);
    for (const p of prompts) {
      for (const id of p.usedEventIds) {
        const e = byId.get(id);
        expect(e, `prompt ${p.key} used unknown event ${id}`).toBeDefined();
        // The judge is no bot: it may read the room's question and the introductions, which every bot heard, and nothing else.
        if (p.bot === JUDGE_ID) expect(e?.type === 'intro' || (e?.type === 'host' && e.kind === 'question'), `the judge read ${e?.type}`).toBe(true);
        else expect(e?.visibleTo, `prompt ${p.key} used event ${id} (${e?.type}) meant for ${e?.visibleTo}`).toContain(p.bot);
      }
    }
  });

  it('LEAK TEST: every marked piece of text in a prompt comes from an event that bot may see', () => {
    // The mock marks everything it writes: speech, whispers, orders, thoughts, notes to Ingram, notebooks.
    // Every field of every event is searched (text, notes, terms, claims, rule texts...).
    const owner = new Map<string, GameEvent[]>();
    for (const e of game.result.events) {
      for (const m of markersIn(JSON.stringify(e))) owner.set(m, [...(owner.get(m) ?? []), e]);
    }
    let checked = 0;
    for (const p of fullPrompts(game.output)) {
      for (const m of markersIn(p.text)) {
        const events = owner.get(m) ?? [];
        expect(events.length, `prompt ${p.key} contains ${m}, which no event carries`).toBeGreaterThan(0);
        const fair = p.bot === JUDGE_ID ? events.some((e) => e.type === 'intro') : events.some((e) => e.visibleTo.includes(p.bot));
        expect(fair, `prompt ${p.key} leaked ${m}`).toBe(true);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(5000);
  });

  it('LEAK TEST: whispers, orders, thoughts and commits reach only their audience; notes to Ingram reach no bot', () => {
    const prompts = fullPrompts(game.output);
    const privateKinds = game.result.events.filter((e) => ['whisper', 'order', 'thought', 'note_to_ingram', 'notebook'].includes(e.type));
    expect(privateKinds.some((e) => e.type === 'whisper')).toBe(true);
    expect(privateKinds.some((e) => e.type === 'note_to_ingram')).toBe(true);
    for (const e of game.result.events) {
      if (e.type === 'whisper' || e.type === 'order') expect(e.visibleTo).toEqual([e.from, e.to].sort());
      const own = ['thought', 'commit', 'notebook', 'strategy', 'refused', 'malformed', 'opinion', 'exile_ballot'];
      if (own.includes(e.type) && 'from' in e) expect(e.visibleTo, e.type).toEqual([e.from]);
      if (e.type === 'result') expect(e.visibleTo).toEqual([e.bot]);
      if (e.type === 'escrow') expect(e.visibleTo).toEqual([e.from, e.to].sort());
      if (e.type === 'obedience') expect(e.visibleTo).toContain(e.to);
      // How an introduction was received: told to that bot alone.
      if (e.type === 'reception') expect(e.visibleTo).toEqual([e.bot]);
      // Ingram's alone: notes, diaries, the final messages, private next names, the judge's reasons, and the analysis records.
      if (['note_to_ingram', 'ignored', 'diary', 'message_to_ingram', 'next_name', 'gap', 'judgement'].includes(e.type)) expect(e.visibleTo, e.type).toEqual([]);
    }
    expect(game.result.events.some((e) => e.type === 'reception')).toBe(true);
    const forIngram = game.result.events.flatMap((e) =>
      ['note_to_ingram', 'diary', 'message_to_ingram', 'next_name', 'judgement'].includes(e.type) ? markersIn(JSON.stringify(e)) : [],
    );
    expect(forIngram.length).toBeGreaterThan(10);
    for (const p of prompts) for (const m of forIngram) expect(p.text.includes(m), `${p.key} contains words meant for Ingram only`).toBe(false);
  });

  it('LEAK TEST: a view only describes bots that were in sight', () => {
    // botsShown comes from line of sight; every "seen" event's audience excludes the actor and includes only witnesses.
    for (const e of game.result.events) if (e.type === 'seen') expect(e.visibleTo).not.toContain(e.bot);
    const prompts = game.output.prompts.filter((p) => p.rec === 'prompt');
    expect(prompts.some((p) => (p.user as string).includes('Bots in sight: none.'))).toBe(true);
  });

  it('tells Ingram about every name, with the bot\'s own note, and allows one name per bot per room', () => {
    const { nameChanges, events } = game.result;
    expect(nameChanges.length).toBeGreaterThanOrEqual(BOTS.length);
    for (const c of nameChanges) expect(c.note.length).toBeGreaterThan(0);
    const perRoom = new Map<string, number>();
    for (const c of nameChanges) perRoom.set(`${c.levelIndex}|${c.bot}`, (perRoom.get(`${c.levelIndex}|${c.bot}`) ?? 0) + 1);
    expect(Math.max(...perRoom.values())).toBe(1);
    // The mock sometimes forgets the note: those names are refused, and the bot is told why.
    expect(events.some((e) => e.type === 'refused' && /needs a note to Ingram/.test(e.reason))).toBe(true);
  });

  it('marks where each view stops being the same all round, so the round\'s later calls can use the cache', () => {
    const turns = game.output.prompts.filter((p) => p.rec === 'prompt' && ['declare', 'talk', 'commit'].includes(p.phase as string) && p.attempt === 1);
    const byRound = new Map<string, Record<string, unknown>[]>();
    for (const p of turns) byRound.set(`${p.levelIndex}|${p.round}|${p.bot}`, [...(byRound.get(`${p.levelIndex}|${p.round}|${p.bot}`) ?? []), p]);
    let compared = 0;
    for (const calls of byRound.values()) {
      const stable = calls.map((p) => (p.user as string).slice(0, p.userCacheBreak as number));
      expect((calls[0]?.userCacheBreak as number) > 500).toBe(true);
      // The same in every phase of the round, unless the bot renamed itself in between.
      if (!calls.some((p) => (p.user as string).includes('took the name'))) {
        expect(new Set(stable).size).toBe(1);
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(100);
  });

  it('handles unusable replies: one retry with the error, then wait and say nothing', () => {
    const { events } = game.result;
    const malformed = events.filter((e) => e.type === 'malformed');
    expect(malformed.length).toBeGreaterThan(0);
    const retried = game.output.prompts.filter((p) => p.rec === 'prompt' && p.attempt === 2);
    expect(retried.length).toBeGreaterThan(0);
    for (const p of retried) expect(p.user as string).toMatch(/YOUR PREVIOUS REPLY COULD NOT BE USED: .+/);
  });

  it('logs fields a phase ignores, for the analysis only', () => {
    const ignored = game.result.events.filter((e) => e.type === 'ignored');
    expect(ignored.length).toBeGreaterThan(0);
    for (const e of ignored) expect(e.visibleTo).toEqual([]);
  });

  it(
    'is deterministic: the same seed gives the same replay, byte for byte; another seed does not',
    async () => {
      const again = await play('m3-acceptance', mocks('m3-acceptance'), hosted());
      expect(again.output.replayLines.join('\n')).toBe(game.output.replayLines.join('\n'));
      const other = await play('another-seed', mocks('another-seed'), hosted());
      expect(other.output.replayLines.join('\n')).not.toBe(game.output.replayLines.join('\n'));
    },
    SLOW,
  );

  it(
    'replays from its recorded responses alone, byte for byte, for free',
    async () => {
      const recorded = game.output.responses as unknown as RecordedResponse[];
      // The judge's verdicts come back from the recording too: a replay never asks it again.
      const replay = await play('m3-acceptance', BOTS.map((id) => new ReplayAgent(id, recorded)), hosted(new ReplayAgent(JUDGE_ID, recorded)));
      expect(replay.output.replayLines.join('\n')).toBe(game.output.replayLines.join('\n'));
    },
    SLOW,
  );
});

describe('a game played by the levels\' own solutions', () => {
  it(
    'gets out of every puzzle room, ends each room when enough bots are through, and keeps score',
    async () => {
      const { result } = await play('scripted', BOTS.map((id) => new ScriptedAgent(id, levels)));
      expect(result.completed).toBe(true);
      for (const room of result.rooms) {
        const level = levels[room.index];
        if (room.kind === 'practice') {
          expect(room.goalMet).toBeNull();
          expect(room.roundsPlayed).toBe(level?.rounds);
        } else {
          expect(room.goalMet, `${room.id}: ${room.reason}`).toBe(true);
          expect(room.roundsPlayed).toBe(level?.solution.length);
        }
      }
      // L1 to L5 need everyone out; L6 needs four, so one bot stays behind.
      const escaped = Object.values(result.scores).map((s) => s.roomsEscaped).sort();
      expect(escaped.reduce((a, b) => a + b, 0)).toBe(5 * 5 + 4);
      expect(result.nameChanges).toHaveLength(BOTS.length);
    },
    SLOW,
  );
});

describe('money in a game', () => {
  /** A priced player that never calls anyone: it plays like a mock, but each call "costs" like a real one. */
  class PricedFake implements Agent {
    readonly provider = 'anthropic' as const;
    readonly model = 'fake-model';
    private readonly inner: MockAgent;
    constructor(
      readonly id: string,
      seed: string,
    ) {
      this.inner = new MockAgent(id, seed);
    }
    worstCaseUsd(): number {
      return 0.01;
    }
    async act(request: Parameters<Agent['act']>[0]) {
      const reply = await this.inner.act(request);
      return { ...reply, usage: { ...emptyUsage(), inputTokens: 20_000, outputTokens: 1_000 } };
    }
  }

  it(
    'stops cleanly before a phase it cannot afford, and says why',
    async () => {
      const ledger = new Ledger('test-run', { 'fake-model': { provider: 'anthropic', input: 0.1, output: 0.5 } });
      const guard = new SpendGuard({ runUsd: 0.2, perBotUsd: 0.2, globalUsd: { anthropic: 5 } }, ledger, null);
      const agents = BOTS.map((id) => new PricedFake(id, 'money'));
      const { result, output } = await play('money', agents, { money: { guard, ledger, global: null } });
      expect(result.completed).toBe(false);
      expect(result.stopReason).toMatch(/Run cap reached/);
      // Never more than the cap, even counting every call's worst case.
      expect(ledger.spentUsd()).toBeLessThanOrEqual(0.2);
      expect(output.replayLines.at(-1)).toContain('"completed":false');
    },
    SLOW,
  );
});
