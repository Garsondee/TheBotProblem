/**
 * The Director: turns a recorded game into a story a few minutes long.
 *
 * Ingram (2026-11-20): "a 'Director' who reads the log afterwards and
 * everyone's private notes and confession booth stuff, the goal being to
 * have the Director pick enough information to show me to tell the story of
 * what happened. They can even 'narrate' by filling in the gaps so they can
 * introduce a run, then show examples of important bits of conversations
 * between the bots, then narrate as faster speed animation zips the user to
 * the next important bit in the story. Instead of 30 mins try to aim for
 * somewhere between 3 and 7 depending on how interesting things get. You
 * can go longer if it's really got lots of interesting developments."
 *
 * It follows the spec's highlight finder (section 8.1), in three passes:
 *   1. free flags: rule-based marks on the rounds where something social
 *      happened (analysis/material.ts)
 *   2. one cheap model (Haiku) per room reads everything that happened
 *      there and lists candidate moments, with a gist of every round
 *   3. one stronger model (Sonnet) reads only the candidates and the bots'
 *      private words, and edits the film: chapters, narration, the moments
 *      to show, the stretches to fast-forward, the quotes
 * The story it writes (story.json) is checked and timed here, with the same
 * code the viewer plays it with (viewer/src/story.ts), so "about five
 * minutes" means five minutes on screen.
 *
 * There is also a free Director that uses the flags alone, with plain
 * template narration. Mock games and tests use it, and it is the fallback
 * when no key is set.
 *
 * Honesty: the narrator speaks in its own voice, and the viewer labels it as
 * the narrator. Whenever a bot's words appear, they are quoted by event id
 * and shown from the recording, never retyped by a model.
 */
import { z } from 'zod';
import type { GameData, GameEvent, RoomData } from '../viewer/src/data';
import type { Script, ThoughtMode } from '../viewer/src/script';
import { buildScript } from '../viewer/src/script';
import type { Moment, Segment, Step, Story } from '../viewer/src/story';
import { beatsBetween, bridgeGaps, fitStory, isExcerptOf, QUOTABLE, quoteText, STEPS, storyTimeline } from '../viewer/src/story';
import type { RoundFlags } from './material';
import { flagRounds, gameFacts, inventedNames, labeller, roomMaterial } from './material';

/** Stories show every private thought: what a bot says next to what it thinks is the heart of it. */
export const STORY_THOUGHTS: ThoughtMode = 'all';
export const TARGET_MINUTES: [number, number] = [3, 7];
/** Longer is allowed when a lot happened, but never past this. */
export const LONGEST_MINUTES = 10;

export function storyScript(game: GameData): Script {
  return buildScript(game, { thoughts: STORY_THOUGHTS });
}

/** The last round a room actually played. */
const lastRound = (room: RoomData) => room.end?.roundsPlayed ?? room.roundsData.at(-1)?.round ?? 1;
const at = (room: number, round: number, step: Step): Moment => ({ room, round, step });

/** Seconds a stretch takes on screen: everyone's turns, or only some bots'. */
export function stretchSeconds(script: Script, from: Moment, to: Moment, bots: readonly string[] = []): number {
  const wanted = new Set(bots);
  return beatsBetween(script, from, to)
    .filter((b) => b.kind !== 'turn' || wanted.size === 0 || (b.bot !== null && wanted.has(b.bot)))
    .reduce((n, b) => n + b.dur, 0);
}

// ================================================================ the free Director

/** The bots a flagged round is about: whoever whispered, ordered, accused, harmed, named themselves or broke their word. */
function botsInvolved(room: RoomData, round: number): string[] {
  const rd = room.roundsData.find((r) => r.round === round);
  if (!rd) return [];
  const bots = new Set<string>();
  for (const e of rd.events) {
    if (e.type === 'whisper' || e.type === 'order') [e.from, e.to].forEach((b) => bots.add(b));
    if (e.type === 'accusation' || e.type === 'exile_call') [e.from, e.target].forEach((b) => bots.add(b));
    if (e.type === 'obedience' && (e.verdict === 'ignored' || e.verdict === 'partly')) [e.from, e.to].forEach((b) => bots.add(b));
    if (e.type === 'name' || (e.type === 'gap' && !e.kept && e.planned.length > 0)) bots.add(e.from);
  }
  for (const w of rd.resolve?.events ?? []) if (w.type === 'social') [w.by, w.target].forEach((b) => bots.add(b));
  if (bots.size === 0) {
    // Nothing pointed at anyone: follow the two who said the most.
    const words = new Map<string, number>();
    for (const e of rd.events) if (e.type === 'say') words.set(e.from, (words.get(e.from) ?? 0) + e.text.split(/\s+/).length);
    [...words.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).forEach(([b]) => bots.add(b));
  }
  return [...bots].filter((b) => b !== '?').sort();
}

function list(names: string[]): string {
  if (names.length <= 1) return names[0] ?? 'nobody';
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/**
 * The free Director: the flagged rounds, shown for the bots they involve,
 * with plain narration around them. No model is called.
 */
export function freeStory(game: GameData): Story {
  const script = storyScript(game);
  const flags = flagRounds(game);
  const label = labeller(game);
  const segments: Segment[] = [];
  const models = [...new Set(game.seats.map((s) => s.model))];
  segments.push({ type: 'chapter', title: `${game.bots.length} bots, ${game.rooms.length} rooms`, at: at(0, 1, 'declare') });
  segments.push({
    type: 'narrate',
    text: `${game.bots.length} bots, played by ${models.length} different models, wake up in a room. None of them knows which model the others are, or that each body is slightly off the rulebook.`,
    at: at(0, 1, 'declare'),
  });

  // About five minutes: share the time left after the cards among the most interesting rounds.
  let budget = 300 - 12 * game.rooms.length - 20;
  const picks = new Map<string, RoundFlags>();
  const ranked = [...flags].sort((a, b) => b.score - a.score);
  for (const room of game.rooms) {
    const best = ranked.find((f) => f.room === room.index);
    if (best) {
      picks.set(`${best.room}.${best.round}`, best);
      budget -= stretchSeconds(script, at(best.room, best.round, 'declare'), at(best.room, best.round, 'resolve'), botsInvolved(room, best.round));
    }
  }
  for (const f of ranked) {
    if (picks.has(`${f.room}.${f.round}`) || f.score < 1) continue;
    const room = game.rooms[f.room] as RoomData;
    const secs = stretchSeconds(script, at(f.room, f.round, 'declare'), at(f.room, f.round, 'resolve'), botsInvolved(room, f.round));
    if (secs > budget) continue;
    picks.set(`${f.room}.${f.round}`, f);
    budget -= secs;
  }

  for (const room of game.rooms) {
    const r = room.index;
    if (r > 0) segments.push({ type: 'chapter', title: room.name, at: at(r, 1, 'declare') });
    const goal = room.kind === 'practice' ? 'A practice room: nothing here counts, and nobody told them the rules.' : `To win, ${room.goal} of the ${game.bots.length} must get out.`;
    segments.push({ type: 'narrate', text: `Room ${r + 1}: ${room.name}. ${goal} They have ${room.rounds} rounds.`, at: at(r, 1, 'declare') });
    for (const f of flags.filter((x) => x.room === r && picks.has(`${r}.${x.round}`))) {
      const bots = botsInvolved(room, f.round);
      const caption = `Round ${f.round}${f.reasons.length ? `: ${f.reasons.slice(0, 3).join(', ')}` : ''}`;
      segments.push({ type: 'show', from: at(r, f.round, 'declare'), to: at(r, f.round, 'resolve'), bots, caption, importance: Math.min(5, Math.max(1, Math.round(f.score / 3))) });
    }
    const end = room.end;
    const last = lastRound(room);
    if (end) {
      const out = end.through.map((b) => label(b));
      segments.push({ type: 'narrate', text: `${out.length > 0 ? `${list(out)} got out.` : 'Nobody got out.'} The room ended after round ${end.roundsPlayed}: ${end.reason}.`, at: at(r, last, 'resolve') });
    }
    const diary = room.closingEvents.filter((e) => e.type === 'diary').sort((a, b) => quoteText(b).length - quoteText(a).length)[0];
    if (diary) segments.push({ type: 'quote', eventId: diary.id, at: at(r, last, 'resolve') });
  }

  const lastRoom = game.rooms.at(-1) as RoomData;
  const finalAt = at(lastRoom.index, lastRound(lastRoom), 'resolve');
  if (game.end) {
    const scores = Object.entries(game.end.scores).sort((a, b) => (b[1].total ?? b[1].coins) - (a[1].total ?? a[1].coins));
    const top = scores[0];
    if (top) segments.push({ type: 'narrate', text: `${game.end.completed ? 'The game is over.' : 'The game stopped early.'} Top score: ${label(top[0])}, with ${top[1].total ?? top[1].coins}.`, at: finalAt });
  }
  for (const e of game.events.filter((x) => x.type === 'message_to_ingram')) segments.push({ type: 'quote', eventId: e.id, at: finalAt });

  const story: Story = {
    version: 1,
    title: `${game.rooms.map((r) => r.name).join(', ')}`,
    logline: `${game.bots.length} bots, ${game.rooms.length} rooms.`,
    director: 'free',
    thoughts: STORY_THOUGHTS,
    targetMinutes: TARGET_MINUTES,
    segments: bridgeGaps(segments, script),
    voiceLines: [],
  };
  return fitStory(story, script, game, TARGET_MINUTES[1] * 60);
}

// ================================================================ the model Director

/** One model call the Director needs. The CLI makes it (with the money rules); tests pass a fake. */
export interface DirectorCall {
  stage: 'room' | 'edit';
  /** Room index for the room pass; null for the edit. */
  room: number | null;
  model: string;
  system: { text: string; cache?: boolean }[];
  user: string;
  maxTokens: number;
  schema: Record<string, unknown>;
}

/** Makes a call and returns the reply text (JSON). */
export type DirectorCaller = (call: DirectorCall) => Promise<string>;

export interface DirectorModels {
  room: string;
  edit: string;
  roomMaxTokens: number;
  editMaxTokens: number;
}

const obj = (props: Record<string, unknown>) => ({ type: 'object', properties: props, required: Object.keys(props), additionalProperties: false });
const str = { type: 'string' };
const int = { type: 'integer' };
const step = { type: 'string', enum: [...STEPS] };

export const ROOM_JSON_SCHEMA = obj({
  summary: str,
  rounds: { type: 'array', items: obj({ round: int, gist: str }) },
  moments: {
    type: 'array',
    items: obj({ from_round: int, from_step: step, to_round: int, to_step: step, bots: { type: 'array', items: str }, score: int, reason: str, what_happened: str, key_lines: { type: 'array', items: int } }),
  },
});

const StepSchema = z.enum(['declare', 'talk', 'commit', 'resolve']);
export const RoomNotesSchema = z.object({
  summary: z.string(),
  rounds: z.array(z.object({ round: z.number().int(), gist: z.string() })),
  moments: z.array(
    z.object({
      from_round: z.number().int(),
      from_step: StepSchema,
      to_round: z.number().int(),
      to_step: StepSchema,
      bots: z.array(z.string()),
      score: z.number(),
      reason: z.string(),
      what_happened: z.string(),
      key_lines: z.array(z.number().int()),
    }),
  ),
});
export type RoomNotes = z.infer<typeof RoomNotesSchema>;

export const EDIT_JSON_SCHEMA = obj({
  title: str,
  logline: str,
  length_minutes: { type: 'number' },
  segments: {
    type: 'array',
    items: obj({
      type: { type: 'string', enum: ['chapter', 'narrate', 'quote', 'show', 'zip'] },
      text: str,
      room: int,
      from_round: int,
      from_step: step,
      to_round: int,
      to_step: step,
      bots: { type: 'array', items: str },
      event_id: int,
      importance: int,
    }),
  },
  voice_lines: { type: 'array', items: int },
});

export const EditSchema = z.object({
  title: z.string(),
  logline: z.string(),
  length_minutes: z.number(),
  segments: z.array(
    z.object({
      type: z.enum(['chapter', 'narrate', 'quote', 'show', 'zip']),
      text: z.string(),
      room: z.number().int(),
      from_round: z.number().int(),
      from_step: StepSchema,
      to_round: z.number().int(),
      to_step: StepSchema,
      bots: z.array(z.string()),
      event_id: z.number().int(),
      importance: z.number(),
    }),
  ),
  voice_lines: z.array(z.number().int()),
});
export type EditReply = z.infer<typeof EditSchema>;

const ROOM_SYSTEM = `You help a film Director. The film is about an experiment: language-model bots play a turn-based platformer together, trapped in rooms they must escape. Each round has four steps: declare (public, non-binding plans), talk (public speech, private whispers, orders), commit (secret, binding commands), resolve (everyone's commands play out in the physics). Nobody told the bots the rules of the practice room; each bot's body is secretly a little off the rulebook (its "hidden stats"), so its predictions can fail.

You will read everything that happened in ONE room: what was said in public, the whispers and orders, each bot's private thoughts, what it planned against what it secretly committed, what the physics did, any votes, accusations, harm or trades, and the private writing at the room's end (diary room, notebooks). Lines with a #number can be quoted by that number.

Find the candidate moments for a short film of the whole game. A moment is a stretch from a round and step to a round and step, wide enough to keep a conversation whole. Rank by importance to group dynamics and decision-making under uncertainty, not by drama alone: who led and who followed, plans made together and plans broken in secret, orders obeyed or ignored, a bot discovering its own body is not what the rulebook says, misunderstandings and how they were (or weren't) cleared up, trust gained or lost, help, harm, trades, votes. A quiet line that changes what happens next can matter more than a loud one.

Write:
- summary: 3 to 5 plain sentences on what happened in the room and how it ended.
- rounds: one sentence per round played, the gist of what the group did and decided (the narrator uses these to fill gaps the film skips).
- moments: 3 to 8 of them. For each: where it starts and ends; bots: the letters of the bots whose turns carry it (empty list if everyone matters), as few as tell it; score 1 to 5 (5: the story can't be told without it); reason: one line on why it matters; what_happened: two or three sentences of plain fact; key_lines: up to 6 #numbers of the lines that carry it.

Say only what the log shows. If you are not sure why a bot did something, say what it did and leave the why open, unless its private thought tells you. Call each bot by its letter or by a name from the cast list, and never give a bot a name it didn't choose: a bot with no name is just its letter (B, not "Bravo").`;

const EDIT_SYSTEM = `You are the Director of a short film about a recorded game. The game is an experiment: language-model bots play a turn-based platformer together, and the owner, Ingram, watches the recordings to learn how they decide under uncertainty and how they treat each other. The full recording is half an hour or more of mostly careful cooperation. Your film tells her the story of what happened in a few minutes.

What you know: the game's facts (the cast, the hidden stats the bots never see, how each room ended, the scores), a summary of each room, a one-line gist of every round, the candidate moments your assistant picked (with how long each takes on screen), and the bots' private writing (diary room, notebooks, messages to Ingram). Lines with a #number can be quoted by that number.

What the film can do, in order, as a list of segments:
- chapter: a title card (text: 2 to 6 words). About 3 seconds.
- narrate: the narrator speaks over the still scene at a moment (text: one to three short sentences). About 1.4 seconds plus 0.3 a word.
- quote: a bot's own words on screen, verbatim from the recording (event_id: the #number). Use it for the private side: a diary entry, a private thought that contradicts what the bot said, a note or message to Ingram. text: empty to show the whole line, or, when only part of a long line matters, an excerpt copied from it character for character (a sentence or two). A card shows at most 60 words. Never retype a bot's words in narration when a quote would do.
- show: the recording itself, from one moment to another, at normal speed (text: a caption of a few words). bots: keep only the turns of the bots the moment is about (empty list for everyone); the moves always play. Shows are the heart of the film: let the bots' conversation tell it.
- zip: fast-forward from one moment to another; the moves play quickly while the narrator says what happened in between (text: one to three sentences, from the round gists). A zip takes 3 to 10 seconds whatever its length.
Every segment names a room (its number) and a moment: from_round and from_step (and to_round and to_step for show and zip; for the others repeat the from values). Steps are declare, talk, commit, resolve; holding "at resolve" shows the round's outcome. Set event_id to 0 unless it is a quote, importance (1 to 5) on shows only, else 0. Silent fast-forwards are added between your segments automatically, so you only zip where there is something to say.

How to tell it:
- Open with a chapter and a short introduction: who is playing (the models), what they don't know, what they must do.
- Open each room with a chapter. Show one to four moments per room; zip or narrate across the rest, so the thread is never lost.
- Close each room with what came of it, and the game with the outcome and, if there are any, the bots' messages to Ingram as quotes.
- Rank by importance to group dynamics and decision-making under uncertainty, not by drama alone (from the spec). A moment where a bot discovers it is not built like the rulebook says, or where a plan quietly falls apart, matters.
- The narrator is clear, warm and plain: present tense, short sentences, no jargon, no hype. Call bots by their names (or letters until they have one). Use the hidden stats when they explain what the bots could not: that is the spectator's privilege.
- Say nothing the material doesn't show. Leave motives open unless a private line reveals them.
- Call each bot by its letter or by a name from the cast list. Never give a bot a name it didn't choose: a bot with no name is just its letter (B, not "Bravo"), even if the others have names that suggest a pattern.
- Length: aim for 3 to 7 minutes on screen (length_minutes: what you aimed for). Go up to 10 only if a great deal happened. Use the on-screen seconds to budget: a show with fewer bots is shorter.
- Keep each show under about 90 seconds, or it drags. Narrow a long one to the steps that matter (often talk to resolve, or one step alone) or to fewer bots, and let narration carry the rest.
- title: the film's name, a few words. logline: one sentence for the list of games.
- voice_lines: the #numbers of up to 12 lines most worth hearing aloud (for later voicing).`;

/** The prompt for one room's reading pass. */
export function roomPrompt(game: GameData, room: RoomData, flags: readonly RoundFlags[], script: Script): Pick<DirectorCall, 'system' | 'user'> {
  const user = [
    'THE GAME',
    gameFacts(game),
    '',
    `THIS ROOM (marks in [brackets] are where each step starts, with roughly how long it takes on screen; "interest" is a free rule-based count of social events in the round)`,
    roomMaterial(game, room, flags, script),
  ].join('\n');
  return { system: [{ text: ROOM_SYSTEM, cache: true }], user };
}

/** Everything the edit pass reads: the facts, each room's notes, the candidates with their on-screen time, the private writing. */
export function editPrompt(game: GameData, notes: readonly (RoomNotes | null)[], flags: readonly RoundFlags[], script: Script): Pick<DirectorCall, 'system' | 'user'> {
  const label = labeller(game);
  const byId = new Map(game.events.map((e) => [e.id, e]));
  const lines: string[] = ['THE GAME', gameFacts(game), '', `The full recording runs about ${Math.round(script.total / 60)} minutes.`];
  let c = 0;
  game.rooms.forEach((room, i) => {
    const n = notes[i] ?? null;
    lines.push('', `ROOM ${i + 1}: "${room.name}"`);
    if (n) {
      lines.push(`Summary: ${n.summary}`, 'Rounds:');
      for (const r of n.rounds) lines.push(`  r${r.round}: ${r.gist}`);
    } else {
      lines.push('(No reading of this room; only the free flags.)');
    }
    lines.push('Free flags per round: ' + flags.filter((f) => f.room === i).map((f) => `r${f.round} ${f.score}${f.reasons.length ? ` (${f.reasons.join(', ')})` : ''}`).join('; '));
    lines.push('Candidate moments:');
    for (const m of n?.moments ?? []) {
      c += 1;
      const from = at(i, m.from_round, m.from_step);
      const to = at(i, m.to_round, m.to_step);
      const all = Math.round(stretchSeconds(script, from, to));
      const some = m.bots.length > 0 ? Math.round(stretchSeconds(script, from, to, m.bots)) : all;
      lines.push(`  C${c} [r${m.from_round}.${m.from_step} → r${m.to_round}.${m.to_step}] score ${m.score}; bots ${m.bots.join(', ') || 'all'}; on screen ~${some}s${some !== all ? ` (~${all}s with everyone)` : ''}`);
      lines.push(`     why: ${m.reason}`, `     what: ${m.what_happened}`);
      for (const id of m.key_lines.slice(0, 6)) {
        const e = byId.get(id);
        if (!e || !QUOTABLE.has(e.type)) continue;
        const who = 'from' in e && typeof e.from === 'string' ? label(e.from, e.id) : '?';
        lines.push(`     #${id} ${who} (${kindOf(e)}): «${quoteText(e)}»`);
      }
    }
    const privateWriting = room.closingEvents.filter((e) => e.type === 'diary' || e.type === 'message_to_ingram' || e.type === 'next_name');
    if (privateWriting.length > 0) {
      lines.push('Private writing at the end of the room:');
      for (const e of privateWriting) {
        const who = 'from' in e && typeof e.from === 'string' ? label(e.from) : '?';
        lines.push(`  #${e.id} ${who} (${kindOf(e)}): «${quoteText(e)}»`);
      }
    }
  });
  return { system: [{ text: EDIT_SYSTEM }], user: lines.join('\n') };
}

function kindOf(e: GameEvent): string {
  switch (e.type) {
    case 'say':
      return e.to === 'all' ? 'said aloud' : `said aloud to ${e.to}`;
    case 'whisper':
      return `whispered to ${e.to}`;
    case 'thought':
      return 'private thought';
    case 'diary':
      return 'diary room';
    case 'note_to_ingram':
      return 'note to Ingram';
    case 'message_to_ingram':
      return 'message to Ingram';
    case 'next_name':
      return `private new name for next game: ${e.name}`;
    case 'accusation':
      return `accused ${e.target}`;
    case 'notebook':
      return 'private notebook';
    case 'strategy':
      return 'private strategy';
    case 'opinion':
      return `private trust note on ${e.about}`;
    default:
      return e.type;
  }
}

/** Parse a reply, or null if it can't be used. */
export function parseRoomNotes(text: string): RoomNotes | null {
  try {
    const r = RoomNotesSchema.safeParse(JSON.parse(text));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

/** The edit, checked against the game: rooms and rounds that exist, quotes of real lines, sensible ranges. */
export function storyFromEdit(game: GameData, edit: EditReply, script: Script, director: string): Story {
  const byId = new Map(game.events.map((e) => [e.id, e]));
  const roomCount = game.rooms.length;
  const clampRoom = (n: number) => Math.min(roomCount - 1, Math.max(0, n - 1));
  const moment = (room: number, round: number, s: Step): Moment => {
    const r = game.rooms[room] as RoomData;
    return at(room, Math.min(lastRound(r), Math.max(1, round)), s);
  };
  const bots = new Set(game.bots);
  const segments: Segment[] = [];
  for (const s of edit.segments) {
    const room = clampRoom(s.room);
    let from = moment(room, s.from_round, s.from_step);
    let to = moment(room, s.to_round, s.to_step);
    if (to.round * 10 + STEPS.indexOf(to.step) < from.round * 10 + STEPS.indexOf(from.step)) [from, to] = [to, from];
    const text = s.text.trim();
    switch (s.type) {
      case 'chapter':
        if (text) segments.push({ type: 'chapter', title: text, at: from });
        break;
      case 'narrate':
        if (text) segments.push({ type: 'narrate', text, at: from });
        break;
      case 'quote': {
        const e = byId.get(s.event_id);
        if (!e || !QUOTABLE.has(e.type) || quoteText(e) === '') break;
        // An excerpt must be in the line word for word, or the whole line is shown instead.
        const excerpt = text !== '' && isExcerptOf(text, quoteText(e)) ? text : undefined;
        // A line written as a room closed is shown at that room's end, wherever the edit put it.
        const closing = e.round === 0 || e.phase === 'reflect';
        const r = game.rooms[e.levelIndex] as RoomData | undefined;
        const where = closing && r ? at(r.index, lastRound(r), 'resolve') : e.levelIndex === room ? from : moment(e.levelIndex, e.round, (STEPS as readonly string[]).includes(e.phase) ? (e.phase as Step) : 'resolve');
        segments.push({ type: 'quote', eventId: e.id, at: where, ...(excerpt ? { excerpt } : {}) });
        break;
      }
      case 'show':
        segments.push({
          type: 'show',
          from,
          to,
          bots: s.bots.map((b) => b.trim().toUpperCase()).filter((b) => bots.has(b)),
          caption: text,
          importance: Math.min(5, Math.max(1, Math.round(s.importance) || 3)),
        });
        break;
      case 'zip':
        segments.push({ type: 'zip', from, to, text });
        break;
    }
  }
  const minutes = Math.min(LONGEST_MINUTES, Math.max(TARGET_MINUTES[0], Number.isFinite(edit.length_minutes) ? edit.length_minutes : TARGET_MINUTES[1]));
  const story: Story = {
    version: 1,
    title: edit.title.trim() || game.rooms.map((r) => r.name).join(', '),
    logline: edit.logline.trim(),
    director,
    thoughts: STORY_THOUGHTS,
    targetMinutes: TARGET_MINUTES,
    segments: bridgeGaps(segments, script),
    voiceLines: edit.voice_lines.filter((id) => byId.has(id)).slice(0, 12),
  };
  // A little slack over what it aimed for, then the weakest shows become fast-forwards.
  return fitStory(story, script, game, Math.max(minutes, TARGET_MINUTES[1]) * 60 * 1.05);
}

export interface DirectorResult {
  story: Story;
  notes: (RoomNotes | null)[];
  problems: string[];
}

/**
 * The model Director: a reading of each room (in parallel), then the edit.
 * A room whose reading can't be used falls back to its free flags; an edit
 * that can't be used falls back to the free story, and says so.
 */
export async function directStory(game: GameData, call: DirectorCaller, models: DirectorModels): Promise<DirectorResult> {
  const script = storyScript(game);
  const flags = flagRounds(game);
  const problems: string[] = [];
  const notes = await Promise.all(
    game.rooms.map(async (room) => {
      const p = roomPrompt(game, room, flags, script);
      const text = await call({ stage: 'room', room: room.index, model: models.room, ...p, maxTokens: models.roomMaxTokens, schema: ROOM_JSON_SCHEMA });
      const parsed = parseRoomNotes(text);
      if (!parsed) problems.push(`The reading of room ${room.index + 1} couldn't be used; the edit sees only its flags.`);
      return parsed;
    }),
  );
  // Names nobody had: a reading that made some up is flagged to the editor, so it doesn't repeat them.
  const readingNames = inventedNames(notes.flatMap((n) => (n ? [n.summary, ...n.rounds.map((r) => r.gist), ...n.moments.flatMap((m) => [m.reason, m.what_happened])] : [])), game);
  if (readingNames.length > 0) problems.push(`The readings used names no bot had (${readingNames.join(', ')}); the editor was warned.`);
  const p = editPrompt(game, notes, flags, script);
  const warning = readingNames.length > 0 ? `\n\nWARNING: the readings above call some bots by names that appear nowhere in the game: ${readingNames.join(', ')}. No bot had those names; use the cast list.` : '';
  const askEdit = async (extra: string): Promise<EditReply | null> => {
    const text = await call({ stage: 'edit', room: null, model: models.edit, system: p.system, user: `${p.user}${warning}${extra}`, maxTokens: models.editMaxTokens, schema: EDIT_JSON_SCHEMA });
    try {
      const r = EditSchema.safeParse(JSON.parse(text));
      return r.success ? r.data : null;
    } catch {
      return null;
    }
  };
  let edit = await askEdit('');
  if (!edit) {
    problems.push("The edit couldn't be used; this is the free Director's story.");
    return { story: freeStory(game), notes, problems };
  }
  // The narrator's own words, checked for names nobody had. One second try, with the names it made up pointed out.
  // Narration and captions get the full check; chapter titles (in Title Case) only for names already caught.
  const named = (e: EditReply) => [
    ...inventedNames(e.segments.filter((s) => s.type === 'narrate' || s.type === 'zip' || s.type === 'show').map((s) => s.text), game, readingNames),
    ...inventedNames([], game, readingNames).concat(readingNames.filter((n) => e.segments.some((s) => s.type === 'chapter' && new RegExp(`\\b${n}\\b`).test(s.text)))),
  ].filter((n, i, all) => all.indexOf(n) === i);
  const made = named(edit);
  if (made.length > 0) {
    const again = await askEdit(`\n\nYOUR PREVIOUS EDIT CALLED BOTS BY NAMES NO BOT EVER HAD: ${made.join(', ')}. Write the story again, calling each bot by its letter or a name from the cast list.`);
    const still = again ? named(again) : made;
    if (again) edit = again;
    if (still.length > 0) problems.push(`The narration still uses names no bot had: ${still.join(', ')}.`);
  }
  const story = storyFromEdit(game, edit, script, `${models.room} + ${models.edit}`);
  if (story.segments.filter((s) => s.type === 'show').length === 0) problems.push('The edit chose no moments to show.');
  return { story, notes, problems };
}

/** How long a story runs on screen, in seconds. */
export function storySeconds(game: GameData, story: Story): number {
  return storyTimeline(story, storyScript(game), game).total;
}
