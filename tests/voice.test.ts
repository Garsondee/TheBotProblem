/**
 * The bots' voices (spec section 8.3): a distinct voice for each bot, matched loosely to its personality;
 * only the chosen lines, introductions, diary entries and final messages by default, never thoughts; WAV
 * files any browser plays; and turns that stay on screen until their voices have finished.
 * Making the audio itself (Kokoro) is checked by hand: tests never load the model.
 */
import { describe, expect, it } from 'vitest';
import { ScriptedAgent } from '../agents/scriptedAgent';
import type { GameEvent } from '../game/events';
import { runGame } from '../game/game';
import { MemoryOutput } from '../game/output';
import type { Persona } from '../game/persona';
import { loadGameConfig } from '../harness/config';
import { loadLevels } from '../harness/levels';
import { castVoices, VOICES } from '../voice/cast';
import { DEFAULT_KINDS, linesToVoice } from '../voice/lines';
import { wavFromSamples } from '../voice/wav';
import { parseReplay } from '../viewer/src/data';
import { buildScript } from '../viewer/src/script';
import type { Story } from '../viewer/src/story';
import { storyTimeline } from '../viewer/src/story';
import type { VoiceManifest } from '../viewer/src/voiceTiming';
import { narrationSeconds } from '../viewer/src/voiceTiming';
import { castNarrator, NARRATOR_VOICES, narrationLines } from '../voice/narration';

const persona = (t: Partial<Persona['traits']>): Persona => ({ traits: { boldness: 5, warmth: 5, honesty: 5, curiosity: 5, patience: 5, ...t } });
const quality = (id: string) => VOICES.find((v) => v.id === id) as (typeof VOICES)[number];

describe('casting', () => {
  it('gives every bot its own voice, the same every time, matched loosely to its personality', () => {
    const seats = [
      { bot: 'A', persona: persona({ warmth: 10, boldness: 3 }) },
      { bot: 'B', persona: persona({ warmth: 1, boldness: 10 }) },
      { bot: 'C', persona: persona({ curiosity: 10, patience: 1 }) },
      { bot: 'D', persona: persona({ patience: 10 }) },
      { bot: 'E' }, // an older game: no personality recorded
    ];
    const cast = castVoices(seats);
    expect(new Set(Object.values(cast).map((c) => c.voice)).size).toBe(5);
    expect(castVoices([...seats].reverse())).toEqual(cast); // by letter, whatever the order given
    expect(quality(cast.A?.voice as string).warm).toBeGreaterThan(quality(cast.B?.voice as string).warm);
    expect(quality(cast.B?.voice as string).strong).toBeGreaterThan(quality(cast.A?.voice as string).strong);
    // The impatient talk faster; the bold sound lower.
    expect(cast.C?.speed).toBeGreaterThan(cast.D?.speed as number);
    expect(cast.B?.pitch).toBeLessThan(cast.A?.pitch as number);
    expect(cast.E?.why).toMatch(/no personality/);
  });

  it('gives bots from before personalities voices as varied as anyone else\'s', () => {
    const cast = castVoices(['claude-haiku-5-5#1', 'claude-haiku-5-5#2', 'claude-haiku-5-5#3', 'google/gemini#1', 'deepseek#1'].map((agent, i) => ({ bot: 'ABCDE'[i] as string, agent })));
    expect(new Set(Object.values(cast).map((c) => c.voice)).size).toBe(5);
    expect(new Set(Object.values(cast).map((c) => `${c.speed}|${c.pitch}`)).size).toBeGreaterThan(1);
  });

  it('follows the agent, not its letter, so a bot sounds the same in its next game', () => {
    const p = { a: persona({ warmth: 9 }), b: persona({ boldness: 9 }) };
    const game1 = castVoices([{ bot: 'A', agent: 'haiku#1', persona: p.a }, { bot: 'B', agent: 'haiku#2', persona: p.b }]);
    const game2 = castVoices([{ bot: 'A', agent: 'haiku#2', persona: p.b }, { bot: 'B', agent: 'haiku#1', persona: p.a }]);
    expect(game2.B?.voice).toBe(game1.A?.voice);
    expect(game2.A?.voice).toBe(game1.B?.voice);
  });
});

describe('which lines are voiced', () => {
  const at = { levelIndex: 1, level: 'L1', round: 2, phase: 'talk' as const, visibleTo: [] };
  const events = [
    { ...at, id: 1, type: 'say', from: 'A', to: 'all', text: 'Hold the door, please.' },
    { ...at, id: 2, type: 'thought', from: 'A', text: 'B will never hold it.' },
    { ...at, id: 3, type: 'intro', from: 'B', text: 'I am Vex.', answer: 'Coins, mostly.', phase: 'intro' as const, round: 0 },
    { ...at, id: 4, type: 'diary', from: 'C', text: 'I trust nobody.' },
    { ...at, id: 5, type: 'message_to_ingram', from: 'D', text: 'Thank you for the game.' },
    { ...at, id: 6, type: 'shout', from: 'E', text: 'Now!' },
  ] as unknown as GameEvent[];

  it("by default: the story's chosen lines, introductions, diaries and final messages; a thought only if the Director chose it", () => {
    const lines = linesToVoice(events, [1], new Set(DEFAULT_KINDS));
    expect(lines.map((l) => [l.eventId, l.kind])).toEqual([[1, 'story'], [3, 'intro'], [4, 'diary'], [5, 'message']]);
    expect(lines.find((l) => l.eventId === 3)?.text).toBe('I am Vex. Coins, mostly.');
    // Chosen by the Director: heard, quietly (the viewer plays a 'thought' at half volume).
    expect(linesToVoice(events, [1, 2], new Set(DEFAULT_KINDS)).find((l) => l.eventId === 2)?.kind).toBe('thought');
  });

  it('everything said aloud, when asked', () => {
    const lines = linesToVoice(events, null, new Set(['speech']));
    expect(lines.map((l) => l.eventId)).toEqual([1, 6]);
  });
});

describe('the WAV files', () => {
  it('are 16-bit mono PCM at the given rate, clipped at full scale', () => {
    const wav = wavFromSamples(new Float32Array([0, 0.5, -1, 2]), 24_000);
    const v = new DataView(wav.buffer);
    const text = (at: number) => String.fromCharCode(...wav.slice(at, at + 4));
    expect([text(0), text(8), text(12), text(36)]).toEqual(['RIFF', 'WAVE', 'fmt ', 'data']);
    expect(v.getUint16(20, true)).toBe(1); // PCM
    expect(v.getUint16(22, true)).toBe(1); // mono
    expect(v.getUint32(24, true)).toBe(24_000);
    expect(v.getUint16(34, true)).toBe(16);
    expect(v.getUint32(40, true)).toBe(8);
    expect(wav.length).toBe(44 + 8);
    expect([v.getInt16(44, true), v.getInt16(46, true), v.getInt16(48, true), v.getInt16(50, true)]).toEqual([0, 16384, -32768, 32767]);
  });
});

describe('the narrator', () => {
  const at = { room: 1, round: 1, step: 'declare' as const };
  const story: Story = {
    version: 1,
    title: 'T',
    logline: '',
    director: 'test',
    thoughts: 'commit',
    targetMinutes: [3, 7],
    voiceLines: [],
    segments: [
      { type: 'chapter', title: 'Room 2: The Last Door', at },
      { type: 'narrate', text: 'Alpha  holds the lever.', at },
      { type: 'show', from: at, to: at, bots: [], caption: 'A caption stays silent', importance: 1 },
      { type: 'zip', from: at, to: at, text: '' },
      { type: 'zip', from: at, to: at, text: 'The door opens.' },
    ],
  };

  it('says the chapters, the narration and what a fast-forward says; never a caption', () => {
    expect(narrationLines(story)).toEqual([
      { segment: 0, kind: 'chapter', text: 'Room 2: The Last Door' },
      { segment: 1, kind: 'narrate', text: 'Alpha holds the lever.' },
      { segment: 4, kind: 'zip', text: 'The door opens.' },
    ]);
  });

  it('has a voice no bot has, at its natural pitch', () => {
    expect(castNarrator([]).voice).toBe(NARRATOR_VOICES[0]);
    expect(castNarrator([NARRATOR_VOICES[0] as string]).voice).toBe(NARRATOR_VOICES[1]);
    expect(castNarrator(['af_heart']).pitch).toBe(1);
  });

  it('is heard only where its words still fit the story, and its cards wait for it', async () => {
    const manifest: VoiceManifest = {
      version: 1,
      engine: 'test',
      cast: {},
      lines: {},
      narrator: { voice: 'bm_george', speed: 0.95, pitch: 1 },
      narration: {
        0: { file: 'a.wav', seconds: 4, kind: 'chapter', text: 'Room 2: The Last Door' },
        1: { file: 'b.wav', seconds: 20, kind: 'narrate', text: 'Alpha holds the lever.' },
        4: { file: 'c.wav', seconds: 3, kind: 'zip', text: 'The door used to open.' }, // the story changed since
      },
    };
    const fits = narrationSeconds(manifest, story.segments);
    expect([...fits.keys()]).toEqual([0, 1]);

    const config = loadGameConfig();
    const levels = loadLevels().slice(0, 2);
    const output = new MemoryOutput();
    await runGame({
      seed: 'narrator',
      levels,
      agents: ['A', 'B', 'C', 'D', 'E'].map((id) => new ScriptedAgent(id, levels)),
      ranges: config.hiddenStats,
      maxTokens: { turn: 700, reflection: 1500, diary: 200 },
      output,
      money: null,
      promptTokenLimit: 60_000,
    });
    const game = parseReplay(output.replayLines.join('\n'));
    const script = buildScript(game, { thoughts: 'commit' });
    const plain = storyTimeline(story, script, game);
    const voiced = storyTimeline(story, script, game, undefined, fits);
    const durOf = (tl: typeof plain, segment: number) => tl.items.find((it) => it.segment === segment)?.dur ?? 0;
    expect(durOf(voiced, 0)).toBeCloseTo(4.6, 5); // the chapter card waits for its spoken title
    expect(durOf(voiced, 1)).toBeCloseTo(20.7, 5); // the narration card waits for its line
    expect(durOf(plain, 1)).toBeLessThan(20);
  });
});

describe('voices in the viewer', () => {
  it('keeps a voiced turn on screen until its line has been heard', async () => {
    const config = loadGameConfig();
    const levels = loadLevels().slice(0, 2);
    const output = new MemoryOutput();
    await runGame({
      seed: 'voices',
      levels,
      agents: ['A', 'B', 'C', 'D', 'E'].map((id) => new ScriptedAgent(id, levels)),
      ranges: config.hiddenStats,
      maxTokens: { turn: 700, reflection: 1500, diary: 200 },
      output,
      money: null,
      promptTokenLimit: 60_000,
    });
    const game = parseReplay(output.replayLines.join('\n'));
    const plain = buildScript(game, { thoughts: 'commit' });
    const said = game.events.find((e) => e.type === 'say') as GameEvent;
    const voiced = buildScript(game, { thoughts: 'commit', voiceSeconds: new Map([[said.id, 30]]) });
    const before = plain.beats.find((b) => b.events.some((e) => e.id === said.id));
    const after = voiced.beats.find((b) => b.events.some((e) => e.id === said.id));
    expect(before?.dur).toBeLessThan(30);
    expect(after?.dur).toBeCloseTo(30.6, 5);
    expect(voiced.total - plain.total).toBeCloseTo(30.6 - (before?.dur ?? 0), 5);
  });
});
