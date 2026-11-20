/**
 * Stories: a recorded game told in a few minutes (Ingram, 2026-11-20: a
 * Director who can "introduce a run, then show examples of important bits
 * of conversations between the bots, then narrate as faster speed animation
 * zips the user to the next important bit in the story. Instead of 30 mins
 * try to aim for somewhere between 3 and 7").
 *
 * A story is a list of segments:
 *   chapter  a title card
 *   narrate  the narrator speaks over the scene, held still at a moment
 *   quote    a bot's own words, verbatim from the log (a diary entry, a
 *            private thought, a message to Ingram). The story names the
 *            event; the text always comes from the recording, so the
 *            Director can't put words in a bot's mouth.
 *   show     a stretch of the game played at normal speed, optionally only
 *            some bots' turns, with a short caption
 *   zip      a stretch fast-forwarded: the moves play quickly while the
 *            narrator fills the gap
 * Segments point at moments (room, round, step), not at times, so a story
 * stays right however the viewer paces the game. This module turns a story
 * into a timeline over the game's script, for the viewer to play and for
 * the Director to measure. It is pure: the Director and the viewer share it.
 */
import type { GameData, GameEvent } from './data';
import type { Beat, Script, ThoughtMode } from './script';

export type Step = 'declare' | 'talk' | 'commit' | 'resolve';
export const STEPS: readonly Step[] = ['declare', 'talk', 'commit', 'resolve'];

export interface Moment {
  /** Room index: 0 is the first room. */
  room: number;
  round: number;
  step: Step;
}

export type Segment =
  | { type: 'chapter'; title: string; at: Moment }
  | { type: 'narrate'; text: string; at: Moment }
  /** excerpt: only part of a long line, checked to be in it word for word. */
  | { type: 'quote'; eventId: number; at: Moment; excerpt?: string }
  | { type: 'show'; from: Moment; to: Moment; bots: string[]; caption: string; importance: number }
  | { type: 'zip'; from: Moment; to: Moment; text: string };

export interface Story {
  version: 1;
  title: string;
  logline: string;
  /** Who made it: "free" (rules only) or the models that read and edited it. */
  director: string;
  /** Which private thoughts the story's script shows: the story was timed with these. */
  thoughts: ThoughtMode;
  targetMinutes: [number, number];
  segments: Segment[];
  /** Lines worth a voice (milestone 7), by event id. */
  voiceLines: number[];
}

/** Where the scene holds while a card is up: a beat, and how far into it. */
export interface Hold {
  beat: number;
  local: number;
}

export type StoryItem =
  | { kind: 'card'; segment: number; card: 'chapter' | 'narrate' | 'quote'; text: string; eventId: number | null; hold: Hold; dur: number }
  | { kind: 'beat'; segment: number; beat: number; dur: number; caption: string }
  | { kind: 'zip'; segment: number; resolves: number[]; physics: number; hold: Hold; dur: number; text: string };

export interface StoryTimeline {
  items: StoryItem[];
  /** Start time of each item, in story seconds. */
  starts: number[];
  total: number;
}

const STEP_ORDER: Record<Step, number> = { declare: 0, talk: 1, commit: 2, resolve: 3 };

/** Events a quote may show: things a bot wrote, said or thought. */
export const QUOTABLE = new Set(['say', 'shout', 'whisper', 'thought', 'diary', 'note_to_ingram', 'message_to_ingram', 'next_name', 'accusation', 'notebook', 'strategy', 'opinion']);

/** Seconds a caption stays up: long enough to read. */
export const readSeconds = (text: string, min = 3, max = 16) => {
  const words = text.trim() === '' ? 0 : text.trim().split(/\s+/).length;
  return Math.min(max, Math.max(min, 1.4 + 0.3 * words));
};

export const CHAPTER_SECONDS = 2.8;

/**
 * How long a fast-forward takes on screen. With narration, long enough to
 * read it; without (a bridge between two chosen moments), just a quick
 * glimpse of the bots moving on.
 */
export function zipSeconds(physicsSeconds: number, text: string): number {
  if (text.trim() === '') return Math.min(5, Math.max(1.6, 1.2 + physicsSeconds / 45));
  return Math.min(10, Math.max(readSeconds(text, 3, 10), 2.5 + physicsSeconds / 60));
}

const squash = (t: string) => t.replace(/\s+/g, ' ').trim();

/** Is this excerpt really in the line, word for word (spacing aside)? */
export function isExcerptOf(excerpt: string, full: string): boolean {
  const x = squash(excerpt);
  return x.length > 0 && squash(full).includes(x);
}

/** Longest a quote card shows before it is cut (with an ellipsis): a card is read, not studied. */
export const QUOTE_WORDS = 60;

/** The words a quote card shows: the excerpt if it is a true one, else the line, cut to a readable length. */
export function quoteShown(e: GameEvent, excerpt?: string): string {
  const full = quoteText(e);
  if (excerpt && isExcerptOf(excerpt, full)) {
    const x = squash(excerpt);
    const f = squash(full);
    return `${f.startsWith(x) ? '' : '… '}${x}${f.endsWith(x) ? '' : ' …'}`;
  }
  const words = squash(full).split(' ');
  return words.length > QUOTE_WORDS ? `${words.slice(0, QUOTE_WORDS).join(' ')} …` : squash(full);
}

/** The words a quote shows, straight from the recording. */
export function quoteText(e: GameEvent): string {
  switch (e.type) {
    case 'say':
    case 'shout':
    case 'whisper':
    case 'thought':
    case 'diary':
    case 'note_to_ingram':
    case 'message_to_ingram':
    case 'notebook':
    case 'strategy':
      return e.text;
    case 'next_name':
      return `${e.name}: ${e.note}`;
    case 'accusation':
      return e.claim;
    case 'opinion':
      return e.note;
    default:
      return '';
  }
}

export const momentKey = (m: Moment) => m.room * 1e6 + m.round * 10 + STEP_ORDER[m.step];

function stepOf(b: Beat): Step | null {
  if (b.kind === 'resolve') return 'resolve';
  return b.phase;
}

/** The beats from one moment to another, in order (inclusive at both ends). */
export function beatsBetween(script: Script, from: Moment, to: Moment): Beat[] {
  const lo = momentKey(from);
  const hi = momentKey(to);
  return script.beats.filter((b) => {
    const s = stepOf(b);
    if (s === null || b.round < 1) return false;
    const k = momentKey({ room: b.room, round: b.round, step: s });
    return k >= lo && k <= hi;
  });
}

/**
 * Where the scene holds for a card at a moment: the world as it stands
 * during that step. Plans, talk and commits happen in a still world; at
 * "resolve", the hold is after the moves have played (the round's outcome).
 */
export function holdAt(script: Script, at: Moment): Hold {
  const beat =
    beatsBetween(script, at, { room: at.room, round: 9999, step: 'resolve' })[0] ??
    [...script.beats].reverse().find((b) => b.room === at.room && b.kind === 'resolve') ??
    script.beats.find((b) => b.room === at.room) ??
    script.beats[0];
  if (!beat) return { beat: 0, local: 0 };
  return { beat: beat.index, local: beat.kind === 'resolve' && stepOf(beat) === at.step && beat.round === at.round ? beat.dur : 0 };
}

const spanOf = (s: Segment): [Moment, Moment] => ('at' in s ? [s.at, s.at] : [s.from, s.to]);

function nextStep(m: Moment): Moment {
  const i = STEP_ORDER[m.step];
  return i < 3 ? { ...m, step: STEPS[i + 1] as Step } : { room: m.room, round: m.round + 1, step: 'declare' };
}

function prevStep(m: Moment): Moment | null {
  const i = STEP_ORDER[m.step];
  if (i > 0) return { ...m, step: STEPS[i - 1] as Step };
  return m.round > 1 ? { room: m.room, round: m.round - 1, step: 'resolve' } : null;
}

/**
 * Fill the gaps between chosen moments with silent fast-forwards, so the
 * bots are seen moving on rather than jumping across the room. Only forward
 * gaps in the same room are bridged: a flashback or a new room is a cut,
 * and a chapter card usually marks it.
 */
export function bridgeGaps(segments: readonly Segment[], script: Script): Segment[] {
  const out: Segment[] = [];
  let lastEnd: Moment | null = null;
  for (const seg of segments) {
    const [from, to] = spanOf(seg);
    if (lastEnd && lastEnd.room === from.room) {
      const gapFrom = nextStep(lastEnd);
      const gapTo = prevStep(from);
      if (gapTo && momentKey(gapTo) >= momentKey(gapFrom) && beatsBetween(script, gapFrom, gapTo).some((b) => b.kind === 'resolve')) {
        out.push({ type: 'zip', from: gapFrom, to: gapTo, text: '' });
      }
    }
    out.push(seg);
    if (!lastEnd || momentKey(to) > momentKey(lastEnd) || to.room !== lastEnd.room) lastEnd = to;
  }
  return out;
}

/**
 * `voiceSeconds` (npm run voice): lines by event id; a voiced quote stays on screen until it has been heard.
 * `segmentSeconds`: the story's own voiced lines, by segment: the narrator's (chapters, narration,
 * fast-forwards, the captions of shown moments) and the quote cards'. Each card waits for its line, and a
 * shown moment's first beat makes room for its spoken caption.
 */
export function storyTimeline(
  story: Story,
  script: Script,
  game: GameData,
  voiceSeconds?: ReadonlyMap<number, number>,
  segmentSeconds?: ReadonlyMap<number, number>,
): StoryTimeline {
  const byId = new Map(game.events.map((e) => [e.id, e]));
  const items: StoryItem[] = [];
  /** At least long enough to read, and long enough to hear if it is voiced. */
  const heard = (i: number, read: number, pad: number) => Math.max(read, (segmentSeconds?.get(i) ?? -pad) + pad);
  story.segments.forEach((seg, i) => {
    switch (seg.type) {
      case 'chapter':
        items.push({ kind: 'card', segment: i, card: 'chapter', text: seg.title, eventId: null, hold: holdAt(script, seg.at), dur: heard(i, CHAPTER_SECONDS, 0.6) });
        break;
      case 'narrate':
        items.push({ kind: 'card', segment: i, card: 'narrate', text: seg.text, eventId: null, hold: holdAt(script, seg.at), dur: heard(i, readSeconds(seg.text), 0.7) });
        break;
      case 'quote': {
        const e = byId.get(seg.eventId);
        const text = e ? quoteShown(e, seg.excerpt) : '';
        if (!e || text === '') return;
        // Its own words voiced (the card), or else the whole line (older voicing).
        const voice = segmentSeconds?.get(i) ?? voiceSeconds?.get(e.id) ?? 0;
        items.push({ kind: 'card', segment: i, card: 'quote', text, eventId: e.id, hold: holdAt(script, seg.at), dur: Math.max(readSeconds(text, 4, 18) + 0.6, voice + 0.8) });
        break;
      }
      case 'show': {
        const wanted = new Set(seg.bots.map((b) => b.toUpperCase()));
        // The narrator says the caption as the moment starts, before the bots speak: its first beat makes room.
        const caption = segmentSeconds?.get(i);
        let first = true;
        // Phase titles and the moves always stay; turns stay for the bots this moment is about.
        for (const b of beatsBetween(script, seg.from, seg.to)) {
          if (b.kind === 'turn' && wanted.size > 0 && b.bot && !wanted.has(b.bot)) continue;
          items.push({ kind: 'beat', segment: i, beat: b.index, dur: b.dur + (first && caption !== undefined ? caption + 0.3 : 0), caption: seg.caption });
          first = false;
        }
        break;
      }
      case 'zip': {
        const beats = beatsBetween(script, seg.from, seg.to);
        if (beats.length === 0) return;
        const resolves = beats.filter((b) => b.kind === 'resolve');
        const physics = resolves.reduce((n, b) => n + b.dur, 0);
        items.push({ kind: 'zip', segment: i, resolves: resolves.map((b) => b.index), physics, hold: holdAt(script, seg.from), dur: heard(i, zipSeconds(physics, seg.text), 0.6), text: seg.text });
        break;
      }
    }
  });
  const starts: number[] = [];
  let t = 0;
  for (const it of items) {
    starts.push(t);
    t += it.dur;
  }
  return { items, starts, total: t };
}

/** The item playing at story time t, and how far into it we are. */
export function storyItemAt(timeline: StoryTimeline, t: number): { index: number; item: StoryItem; local: number } | null {
  const { items, starts } = timeline;
  if (items.length === 0) return null;
  let lo = 0;
  let hi = items.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((starts[mid] as number) <= t) lo = mid;
    else hi = mid - 1;
  }
  const item = items[lo] as StoryItem;
  return { index: lo, item, local: Math.min(item.dur, Math.max(0, t - (starts[lo] as number))) };
}

/** During a zip: which resolve beat is playing, and how far into it, at this point of the fast-forward. */
export function zipPosition(item: Extract<StoryItem, { kind: 'zip' }>, local: number, script: Script): Hold {
  if (item.resolves.length === 0 || item.physics <= 0) return item.hold;
  let p = (Math.min(item.dur, Math.max(0, local)) / item.dur) * item.physics;
  for (const index of item.resolves) {
    const b = script.beats[index] as Beat;
    if (p <= b.dur) return { beat: index, local: p };
    p -= b.dur;
  }
  const last = item.resolves.at(-1) as number;
  return { beat: last, local: (script.beats[last] as Beat).dur };
}

/**
 * Make a story fit its time: while it runs long, the least important "show"
 * becomes a fast-forward with its caption as narration. Nothing is cut
 * outright, so the story keeps its thread.
 */
export function fitStory(story: Story, script: Script, game: GameData, maxSeconds: number): Story {
  let s: Story = { ...story, segments: [...story.segments] };
  for (let guard = 0; guard < 100; guard++) {
    if (storyTimeline(s, script, game).total <= maxSeconds) break;
    const shows = s.segments.map((seg, i) => ({ seg, i })).filter((x): x is { seg: Extract<Segment, { type: 'show' }>; i: number } => x.seg.type === 'show');
    if (shows.length <= 1) break;
    // The weakest; among equals, the longest goes first (it saves the most time).
    const len = (x: (typeof shows)[number]) => beatsBetween(script, x.seg.from, x.seg.to).reduce((n, b) => n + b.dur, 0);
    const weakest = shows.reduce((a, b) => (b.seg.importance < a.seg.importance || (b.seg.importance === a.seg.importance && len(b) > len(a)) ? b : a));
    const segments = [...s.segments];
    segments[weakest.i] = { type: 'zip', from: weakest.seg.from, to: weakest.seg.to, text: weakest.seg.caption };
    s = { ...s, segments };
  }
  return s;
}
