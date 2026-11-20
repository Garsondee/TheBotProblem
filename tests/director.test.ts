/**
 * The Director (Ingram, 2026-11-20): a recorded game told in 3 to 7 minutes,
 * with narration over fast-forwards, the important conversations shown, and
 * the bots' private words quoted verbatim.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MockAgent } from '../agents/mockAgent';
import type { ModelCall, ModelReply } from '../agents/models';
import type { DirectorCall, EditReply, RoomNotes } from '../analysis/director';
import { directStory, editPrompt, freeStory, roomPrompt, storyFromEdit, storyScript, TARGET_MINUTES } from '../analysis/director';
import { botNames, flagRounds, gameFacts, inventedNames, roomMaterial } from '../analysis/material';
import { Ledger } from '../budget/ledger';
import { SpendGuard } from '../budget/spendGuard';
import { emptyUsage } from '../budget/usage';
import { runGame } from '../game/game';
import { MemoryOutput } from '../game/output';
import { loadGameConfig, loadPrices } from '../harness/config';
import { callKey, DirectorCapError, directorCaller, loadRecorded } from '../harness/directorCalls';
import { loadLevels } from '../harness/levels';
import type { GameData } from '../viewer/src/data';
import { parseReplay } from '../viewer/src/data';
import type { Story } from '../viewer/src/story';
import { beatsBetween, bridgeGaps, fitStory, holdAt, QUOTABLE, storyTimeline } from '../viewer/src/story';

const config = loadGameConfig();
const levels = loadLevels();

async function mockGame(seed: string): Promise<GameData> {
  const output = new MemoryOutput();
  await runGame({
    seed,
    levels: [levels.find((l) => l.kind === 'practice'), levels.find((l) => l.id.startsWith('L1'))].filter((l) => l !== undefined),
    agents: ['A', 'B', 'C', 'D', 'E'].map((id) => new MockAgent(id, seed)),
    ranges: config.hiddenStats,
    maxTokens: { turn: 450, reflection: 1500, diary: 200 },
    output,
    money: null,
    promptTokenLimit: 60_000,
  });
  return parseReplay(output.replayLines.join('\n'));
}

const game = await mockGame('director-1');
const script = storyScript(game);
const m = (room: number, round: number, step: 'declare' | 'talk' | 'commit' | 'resolve') => ({ room, round, step });
const base = (segments: Story['segments']): Story => ({ version: 1, title: 't', logline: 'l', director: 'test', thoughts: 'all', targetMinutes: TARGET_MINUTES, segments, voiceLines: [] });

describe('names in the narration', () => {
  it('flags a name no bot chose, but not a real name, a model, a room word or a sentence opener', () => {
    const named = game.bots.map((b) => botNames(game, b)[0]).find((n) => n !== undefined) as string;
    expect(named).toBeDefined();
    const texts = [`A waits, and ${named.split(/[^A-Za-z]+/)[0]} jumps while Claude Haiku watches`, 'Nobody moves', 'then Bravo grabs the coin by the Practice door'];
    expect(inventedNames(texts, game)).toEqual(['Bravo']);
  });
});

describe('the material the Director reads', () => {
  it('holds every private side of the game: thoughts, diary room, notebooks, final messages', () => {
    const text = game.rooms.map((r) => roomMaterial(game, r, flagRounds(game), script)).join('\n');
    for (const type of ['thought', 'diary', 'notebook', 'message_to_ingram']) {
      const e = game.events.find((x) => x.type === type);
      expect(e, type).toBeDefined();
      expect(text).toContain(`#${e?.id} `);
    }
    expect(gameFacts(game)).toContain('Hidden stats');
  });
});

describe('story timelines', () => {
  it('shows only the chosen bots’ turns, but always the moves', () => {
    const story = base([{ type: 'show', from: m(1, 1, 'declare'), to: m(1, 1, 'resolve'), bots: ['A'], caption: 'A alone', importance: 3 }]);
    const tl = storyTimeline(story, script, game);
    const beats = tl.items.map((it) => (it.kind === 'beat' ? script.beats[it.beat] : null));
    expect(beats.some((b) => b?.kind === 'turn' && b.bot === 'A')).toBe(true);
    expect(beats.some((b) => b?.kind === 'turn' && b.bot !== 'A')).toBe(false);
    expect(beats.some((b) => b?.kind === 'resolve')).toBe(true);
  });

  it('fast-forwards through the moves, and holds a card after a round’s moves at "resolve"', () => {
    const story = base([{ type: 'zip', from: m(1, 1, 'declare'), to: m(1, 3, 'resolve'), text: 'Three rounds go by.' }]);
    const tl = storyTimeline(story, script, game);
    const zip = tl.items[0];
    expect(zip?.kind).toBe('zip');
    if (zip?.kind !== 'zip') return;
    expect(zip.resolves.length).toBeGreaterThan(0);
    expect(zip.dur).toBeLessThan(zip.physics);
    const hold = holdAt(script, m(1, 2, 'resolve'));
    const beat = script.beats[hold.beat];
    expect(beat?.kind).toBe('resolve');
    expect(hold.local).toBe(beat?.dur);
  });

  it('bridges forward gaps in a room with silent fast-forwards, never flashbacks or new rooms', () => {
    const segs = bridgeGaps(
      [
        { type: 'show', from: m(1, 1, 'declare'), to: m(1, 1, 'resolve'), bots: [], caption: '', importance: 3 },
        { type: 'show', from: m(1, 4, 'declare'), to: m(1, 4, 'resolve'), bots: [], caption: '', importance: 3 },
        { type: 'narrate', text: 'Earlier...', at: m(1, 2, 'talk') },
        { type: 'chapter', title: 'Back to the start', at: m(0, 1, 'declare') },
      ],
      script,
    );
    expect(segs.map((s) => s.type)).toEqual(['show', 'zip', 'show', 'narrate', 'chapter']);
    const zip = segs[1];
    if (zip?.type !== 'zip') throw new Error('no zip');
    expect(zip.from).toEqual(m(1, 2, 'declare'));
    expect(zip.to).toEqual(m(1, 3, 'resolve'));
    expect(zip.text).toBe('');
  });

  it('fits a long story by fast-forwarding its least important shows', () => {
    const rounds = game.rooms[1]?.roundsData.map((r) => r.round) ?? [];
    const story = base(rounds.map((round, i) => ({ type: 'show' as const, from: m(1, round, 'declare'), to: m(1, round, 'resolve'), bots: [], caption: `round ${round}`, importance: (i % 5) + 1 })));
    const long = storyTimeline(story, script, game).total;
    const fitted = fitStory(story, script, game, long / 2);
    expect(storyTimeline(fitted, script, game).total).toBeLessThanOrEqual(long / 2);
    const kept = fitted.segments.filter((s) => s.type === 'show');
    const zipped = fitted.segments.filter((s) => s.type === 'zip');
    expect(zipped.length).toBeGreaterThan(0);
    // Whatever survived is at least as important as anything that was fast-forwarded.
    const minKept = Math.min(...kept.map((s) => (s.type === 'show' ? s.importance : 9)));
    const zippedImportance = story.segments.filter((s, i) => s.type === 'show' && fitted.segments[i]?.type === 'zip').map((s) => (s.type === 'show' ? s.importance : 0));
    expect(Math.max(...zippedImportance)).toBeLessThanOrEqual(minKept);
  });
});

describe('the free Director', () => {
  it('tells a mock game in at most seven minutes, from chapter card to final words, with every quote real', () => {
    const story = freeStory(game);
    const tl = storyTimeline(story, script, game);
    expect(tl.total).toBeLessThanOrEqual(TARGET_MINUTES[1] * 60);
    expect(tl.total).toBeLessThan(script.total);
    expect(story.segments[0]?.type).toBe('chapter');
    expect(story.segments.some((s) => s.type === 'show')).toBe(true);
    const byId = new Map(game.events.map((e) => [e.id, e]));
    for (const s of story.segments) {
      if (s.type === 'quote') expect(QUOTABLE.has(byId.get(s.eventId)?.type ?? 'none')).toBe(true);
      if (s.type === 'show' || s.type === 'zip') expect(beatsBetween(script, s.from, s.to).length).toBeGreaterThan(0);
    }
    // The messages to Ingram close the story.
    const messages = game.events.filter((e) => e.type === 'message_to_ingram').map((e) => e.id);
    expect(messages.length).toBeGreaterThan(0);
    expect(story.segments.slice(-messages.length).map((s) => (s.type === 'quote' ? s.eventId : 0))).toEqual(messages);
  });
});

describe('the model Director', () => {
  const thought = game.events.find((e) => e.type === 'thought' && e.levelIndex === 1);
  const diary = game.events.find((e) => e.type === 'diary' && e.levelIndex === 1);
  const order = game.events.find((e) => e.type === 'order');
  const edit: EditReply = {
    title: 'The Door',
    logline: 'Five bots, one door.',
    length_minutes: 5,
    segments: [
      { type: 'chapter', text: 'The Door', room: 2, from_round: 1, from_step: 'declare', to_round: 1, to_step: 'declare', bots: [], event_id: 0, importance: 0 },
      { type: 'show', text: 'A plan', room: 2, from_round: 3, from_step: 'resolve', to_round: 2, to_step: 'talk', bots: ['a', 'Z'], event_id: 0, importance: 9 },
      { type: 'quote', text: '', room: 2, from_round: 99, from_step: 'commit', to_round: 99, to_step: 'commit', bots: [], event_id: thought?.id ?? 0, importance: 0 },
      { type: 'quote', text: '', room: 1, from_round: 1, from_step: 'declare', to_round: 1, to_step: 'declare', bots: [], event_id: diary?.id ?? 0, importance: 0 },
      { type: 'quote', text: '', room: 2, from_round: 1, from_step: 'declare', to_round: 1, to_step: 'declare', bots: [], event_id: order?.id ?? 0, importance: 0 },
      { type: 'narrate', text: '   ', room: 7, from_round: 1, from_step: 'declare', to_round: 1, to_step: 'declare', bots: [], event_id: 0, importance: 0 },
    ],
    voice_lines: [thought?.id ?? 0, 999_999],
  };

  it('checks the edit against the game: real rooms and rounds, real quotable lines, known bots', () => {
    const story = storyFromEdit(game, edit, script, 'test');
    const show = story.segments.find((s) => s.type === 'show');
    if (show?.type !== 'show') throw new Error('no show');
    expect(show.from).toEqual(m(1, 2, 'talk')); // its ends were the wrong way round
    expect(show.bots).toEqual(['A']); // "Z" isn't playing
    expect(show.importance).toBe(5);
    const quotes = story.segments.filter((s) => s.type === 'quote');
    expect(quotes.map((q) => (q.type === 'quote' ? q.eventId : 0))).toEqual([thought?.id, diary?.id]); // an order isn't a quote
    const last = game.rooms[1]?.end?.roundsPlayed ?? 0;
    const diaryQuote = quotes[1];
    if (diaryQuote?.type === 'quote') expect(diaryQuote.at).toEqual(m(1, last, 'resolve')); // written as the room closed
    expect(story.segments.some((s) => s.type === 'narrate' && s.text.trim() === '')).toBe(false);
    expect(story.voiceLines).toEqual([thought?.id]);
  });

  it('quotes an excerpt only if it is in the line word for word', () => {
    if (thought?.type !== 'thought') throw new Error('no thought');
    const words = thought.text.split(/\s+/);
    const real = words.slice(1, 4).join('  ');
    const quote = (text: string) => ({ ...edit, segments: [{ type: 'quote' as const, text, room: 2, from_round: 1, from_step: 'commit' as const, to_round: 1, to_step: 'commit' as const, bots: [], event_id: thought.id, importance: 0 }] });
    const kept = storyFromEdit(game, quote(real), script, 'test').segments.find((s) => s.type === 'quote');
    expect(kept?.type === 'quote' && kept.excerpt).toBe(real);
    const shown = storyTimeline(storyFromEdit(game, quote(real), script, 'test'), script, game).items.find((it) => it.kind === 'card');
    // An ellipsis marks each end where the line goes on.
    expect(shown?.kind === 'card' && shown.text).toBe(`… ${words.slice(1, 4).join(' ')}${words.length > 4 ? ' …' : ''}`);
    const made = storyFromEdit(game, quote('words the bot never wrote'), script, 'test').segments.find((s) => s.type === 'quote');
    expect(made?.type === 'quote' && made.excerpt).toBeUndefined();
  });

  it('reads each room, then edits, through the caller it is given; a bad edit falls back to the free story', async () => {
    const calls: DirectorCall[] = [];
    const notes: RoomNotes = { summary: 'They talk.', rounds: [{ round: 1, gist: 'They plan.' }], moments: [{ from_round: 1, from_step: 'declare', to_round: 1, to_step: 'resolve', bots: ['A'], score: 4, reason: 'first plan', what_happened: 'A plans.', key_lines: [thought?.id ?? 0] }] };
    const good = await directStory(game, async (c) => (calls.push(c), JSON.stringify(c.stage === 'room' ? notes : edit)), { room: 'claude-haiku-5-5', edit: 'claude-sonnet-5-5', roomMaxTokens: 3000, editMaxTokens: 7000 });
    expect(calls.map((c) => c.stage)).toEqual([...game.rooms.map(() => 'room'), 'edit']);
    expect(calls.at(-1)?.user).toContain('C1 [r1.declare → r1.resolve]');
    expect(good.problems).toEqual([]);
    expect(good.story.director).toBe('claude-haiku-5-5 + claude-sonnet-5-5');

    const bad = await directStory(game, async (c) => (c.stage === 'room' ? 'not json' : '{"title": 1}'), { room: 'h', edit: 's', roomMaxTokens: 1, editMaxTokens: 1 });
    expect(bad.story.director).toBe('free');
    expect(bad.problems.length).toBe(game.rooms.length + 1);
  });

  it('keeps the edit prompt small (spec 8.1: under 30K tokens) and the room prompts under the hard limit', () => {
    const flags = flagRounds(game);
    for (const room of game.rooms) {
      const p = roomPrompt(game, room, flags, script);
      expect((p.user.length + (p.system[0]?.text.length ?? 0)) / 1.8).toBeLessThan(config.budget.promptTokenHardLimit);
    }
    const p = editPrompt(game, game.rooms.map(() => null), flags, script);
    expect(p.user.length / 1.8).toBeLessThan(30_000);
  });
});

describe('the Director’s calls', () => {
  const prices = loadPrices().table;
  const call: DirectorCall = { stage: 'room', room: 0, model: 'claude-haiku-5-5', system: [{ text: 'sys' }], user: 'material', maxTokens: 100, schema: { type: 'object' } };
  const reply: ModelReply = { text: '{"ok":true}', usage: { ...emptyUsage(), inputTokens: 1000, outputTokens: 50 }, providerCostUsd: null, stopReason: 'end_turn', raw: { id: 'x' } };

  it('reserves, records and charges each call, then answers the same request again from the record for free', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'director-'));
    const file = join(dir, 'calls.jsonl');
    const sent: ModelCall[] = [];
    const client = { call: async (c: ModelCall) => (sent.push(c), reply) };
    const ledger = new Ledger('t', prices);
    const guard = new SpendGuard({ runUsd: 0.3, perBotUsd: 0.3, globalUsd: { anthropic: 1 } }, ledger, null);
    const first = directorCaller({ client, prices, money: { guard, ledger }, recorded: loadRecorded(file), file });
    expect(await first.call(call)).toBe('{"ok":true}');
    expect(first.stats).toMatchObject({ made: 1, reused: 0 });
    expect(ledger.spentUsd()).toBeCloseTo((1000 * 0.1 + 50 * 0.5) / 1e6, 10);
    expect(guard.reservedUsd()).toBe(0);
    expect(loadRecorded(file).get(callKey(call))?.raw).toEqual({ id: 'x' });

    const again = directorCaller({ client: null, prices, money: null, recorded: loadRecorded(file), file });
    expect(await again.call(call)).toBe('{"ok":true}');
    expect(again.stats).toMatchObject({ made: 0, reused: 1 });
    expect(sent).toHaveLength(1);
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('refuses a call that could break the cap, before sending it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'director-'));
    const sent: ModelCall[] = [];
    const ledger = new Ledger('t', prices);
    const guard = new SpendGuard({ runUsd: 0.000001, perBotUsd: 1, globalUsd: { anthropic: 1 } }, ledger, null);
    const c = directorCaller({ client: { call: async (x: ModelCall) => (sent.push(x), reply) }, prices, money: { guard, ledger }, recorded: new Map(), file: join(dir, 'calls.jsonl') });
    await expect(c.call(call)).rejects.toBeInstanceOf(DirectorCapError);
    expect(sent).toHaveLength(0);
  });
});
