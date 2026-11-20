/**
 * The spoken script (Ingram, 2026-11-20): "the entire 'Story' should be voiced ... a Sonnet pass across the
 * 'script' to clean up what the bots are saying, not changing their meaning but making it easier to listen
 * to and less technical".
 *
 * Every bot line a story shows is voiced: what the bots say, shout and whisper in the moments shown, the
 * thoughts the story shows, rules proposed, accusations, and the words on its quote cards. A model rewrites
 * each one for the ear: the same speaker, the same meaning, every claim, promise, accusation and lie kept,
 * with command syntax, ids and coordinates turned into plain words. The screen keeps the bots' own words,
 * verbatim from the recording; only the voice reads the spoken version. The narration is the Director's
 * own, already written to be heard, so it isn't rewritten.
 */
import { z } from 'zod';
import type { GameData } from '../viewer/src/data';
import type { Script, ThoughtMode } from '../viewer/src/script';
import type { Story } from '../viewer/src/story';
import { storyTimeline } from '../viewer/src/story';
import type { GameEvent } from '../game/events';

export interface StoryLine {
  /** 'e<id>': a line in a shown moment (an event, which sounds the same wherever it plays); 'q<segment>': a quote card's words. */
  key: string;
  bot: string;
  kind: 'say' | 'shout' | 'whisper' | 'thought' | 'accusation' | 'rule' | 'note' | 'quote';
  eventId: number;
  segment: number | null;
  /** Its words as the screen shows them, verbatim (for a quote, the words on the card). */
  text: string;
  /** Who it was addressed to: "all", a bot's letter, or "" (a thought, a quote). */
  to: string;
}

/** A shown event's spoken line, if it has one. Votes, plans and commands are chips on screen, not speech. */
function lineOf(e: GameEvent, phase: string | null, thoughts: ThoughtMode): Omit<StoryLine, 'key' | 'eventId' | 'segment'> | null {
  switch (e.type) {
    case 'say':
      return { bot: e.from, kind: 'say', text: e.text, to: e.to };
    case 'shout':
      return { bot: e.from, kind: 'shout', text: e.text, to: 'all' };
    case 'whisper':
      return { bot: e.from, kind: 'whisper', text: e.text, to: e.to };
    case 'thought':
      // As the stage shows them: all, or only at commit, or none.
      return thoughts === 'all' || (thoughts === 'commit' && phase === 'commit') ? { bot: e.from, kind: 'thought', text: e.text, to: '' } : null;
    case 'accusation':
      return { bot: e.from, kind: 'accusation', text: e.claim, to: e.target };
    case 'rule':
      return e.action === 'proposed' ? { bot: e.by, kind: 'rule', text: e.text, to: 'all' } : null;
    case 'note_to_ingram':
      return { bot: e.from, kind: 'note', text: e.text, to: '' };
    default:
      return null;
  }
}

/** Every bot line a story plays, in order: the quote cards, and the words in each moment it shows. */
export function storyLines(game: GameData, story: Story, script: Script): StoryLine[] {
  const timeline = storyTimeline(story, script, game);
  const byId = new Map(game.events.map((e) => [e.id, e]));
  const out: StoryLine[] = [];
  const seen = new Set<number>();
  for (const it of timeline.items) {
    if (it.kind === 'card' && it.card === 'quote' && it.eventId !== null) {
      const e = byId.get(it.eventId);
      const bot = e && 'from' in e && typeof e.from === 'string' ? e.from : null;
      // The card's own words, without the ellipses that mark an excerpt.
      const text = it.text.replace(/^…\s*/, '').replace(/\s*…$/, '').trim();
      if (bot && text !== '') out.push({ key: `q${it.segment}`, bot, kind: 'quote', eventId: it.eventId, segment: it.segment, text, to: '' });
      continue;
    }
    if (it.kind !== 'beat') continue;
    const beat = script.beats[it.beat];
    if (!beat || beat.kind !== 'turn') continue;
    for (const e of beat.events) {
      const line = lineOf(e, beat.phase, story.thoughts);
      if (!line || line.text.trim() === '' || seen.has(e.id)) continue;
      seen.add(e.id);
      out.push({ ...line, key: `e${e.id}`, eventId: e.id, segment: null });
    }
  }
  return out;
}

export const SPOKEN_SYSTEM = `You prepare lines for text-to-speech. Each line is something a bot said, shouted, whispered, wrote or thought in a recorded game: a turn-based platformer played by language-model bots, who get out of rooms through exits, with levers (V1), doors (D1), plates (P1), crates (C1), ladders (H1), coins ($1) and an exit (X). A listener will hear them, so rewrite each line as the same bot would say it aloud, easy to follow.

Keep: the speaker (first person stays first person), the meaning, the attitude, and every claim, promise, demand, accusation, threat or lie, even a wrong or rude one. Never add a fact, a feeling or a word of politeness that isn't there, and never tidy away a mistake.
Change: command syntax into plain words ("walk_to(X)" becomes "walk to the exit", "hold_lever" becomes "hold the lever", "hop_over(B)" becomes "hop over B"); ids into words ("V1" and "lever V1" become the lever, "D1" the door, "X" the exit, "C1" the crate, "$3" a coin, "R1" rule one; only when a line names two of a kind, "lever one" and "lever two"); coordinates are dropped, including a bot saying where it stands ("D at x=6.5,y=2" becomes "D here"), or rounded and said simply when the place itself is the point ("the gap at x=19.75" becomes "the gap at about twenty"); lists of numbers into their gist. Bots stay their names or letters.
Keep each line as short as the original or shorter. Reply with one JSON object: {"lines": [{"key": "...", "spoken": "..."}]}, one entry for every key, in the same order.`;

export const SPOKEN_JSON_SCHEMA = {
  type: 'object',
  properties: {
    lines: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, spoken: { type: 'string' } }, required: ['key', 'spoken'], additionalProperties: false } },
  },
  required: ['lines'],
  additionalProperties: false,
};
const SpokenSchema = z.object({ lines: z.array(z.object({ key: z.string(), spoken: z.string() })) });

const HOW: Record<StoryLine['kind'], string> = {
  say: 'says',
  shout: 'SHOUTS',
  whisper: 'whispers',
  thought: 'thinks, privately',
  accusation: 'accuses',
  rule: 'proposes a rule',
  note: 'writes privately to Ingram',
  quote: 'wrote or said (shown on a card)',
};

/** One batch's prompt: who speaks, how, to whom, and the words. */
export function spokenPrompt(game: GameData, lines: readonly StoryLine[]): string {
  const names = (id: string) => {
    const seat = game.seats.find((s) => s.bot === id);
    const named = [...game.events].reverse().find((e) => e.type === 'name' && e.from === id);
    const name = named?.type === 'name' ? named.name : (seat?.startName ?? null);
    return name ? `${name} (${id})` : id;
  };
  const to = (l: StoryLine) => (l.to === '' ? '' : l.to === 'all' ? ' to everyone' : ` to ${names(l.to)}`);
  return lines.map((l) => `[${l.key}] ${names(l.bot)} ${HOW[l.kind]}${to(l)}: «${l.text}»`).join('\n');
}

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

/**
 * The spoken versions from a reply, checked: only keys that were asked for, never empty, and never much
 * longer than the bot's own words (a rewrite that grows has probably added something). A line that fails
 * keeps the bot's own words.
 */
export function parseSpoken(text: string, asked: readonly StoryLine[]): Map<string, string> {
  const out = new Map<string, string>();
  let parsed: z.infer<typeof SpokenSchema>;
  try {
    parsed = SpokenSchema.parse(JSON.parse(text));
  } catch {
    return out;
  }
  const byKey = new Map(asked.map((l) => [l.key, l]));
  for (const { key, spoken } of parsed.lines) {
    const line = byKey.get(key);
    const s = spoken.replace(/\s+/g, ' ').trim();
    if (!line || s === '' || words(s) > Math.ceil(words(line.text) * 1.25) + 4) continue;
    out.set(key, s);
  }
  return out;
}

/** Lines per call: small enough for a reliable reply, few enough calls to keep each game's cost low. */
export const SPOKEN_BATCH = 60;
