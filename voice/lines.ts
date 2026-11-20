/**
 * Which lines to voice (spec section 8.3: "Synthesise only highlighted lines plus the diary entries and
 * final messages"), plus the introductions, which are where a bot says who it is (Ingram's lever 6).
 * Everything else that bots say aloud can be voiced too, on request: it takes longer, never costs.
 */
import type { GameEvent } from '../game/events';

/** 'thought': a private thought the Director chose to be heard; the viewer plays it quietly, as a mind being read. */
export type LineKind = 'story' | 'thought' | 'intro' | 'diary' | 'message' | 'speech';

/** What `npm run voice` makes unless told otherwise. */
export const DEFAULT_KINDS: readonly LineKind[] = ['story', 'intro', 'diary', 'message'];

export interface VoiceLine {
  eventId: number;
  bot: string;
  kind: LineKind;
  /** The words as spoken: the bot's own, unchanged but for spacing. */
  text: string;
}

/** The spoken words of an event, or null if it isn't something a bot says. */
export function spokenText(e: GameEvent): { bot: string; text: string } | null {
  switch (e.type) {
    case 'say':
    case 'shout':
    case 'whisper':
    case 'diary':
    case 'message_to_ingram':
      return { bot: e.from, text: e.text };
    case 'intro':
      return { bot: e.from, text: e.answer ? `${e.text} ${e.answer}` : e.text };
    case 'accusation':
      return { bot: e.from, text: e.claim };
    default:
      return null;
  }
}

/** The lines to voice, in the order they happen, each once. */
export function linesToVoice(events: readonly GameEvent[], storyIds: readonly number[] | null, kinds: ReadonlySet<LineKind>): VoiceLine[] {
  const story = new Set(storyIds ?? []);
  const out: VoiceLine[] = [];
  for (const e of events) {
    // Thoughts aren't spoken (spec 8.2: "not voiced"), except those the Director chose to be heard, quietly.
    if (e.type === 'thought' && kinds.has('story') && story.has(e.id) && e.text.trim() !== '') {
      out.push({ eventId: e.id, bot: e.from, kind: 'thought', text: e.text.replace(/\s+/g, ' ').trim() });
      continue;
    }
    const spoken = spokenText(e);
    if (!spoken || spoken.text.trim() === '') continue;
    const kind: LineKind | null =
      kinds.has('story') && story.has(e.id) ? 'story' :
      kinds.has('intro') && e.type === 'intro' ? 'intro' :
      kinds.has('diary') && e.type === 'diary' ? 'diary' :
      kinds.has('message') && e.type === 'message_to_ingram' ? 'message' :
      kinds.has('speech') && (e.type === 'say' || e.type === 'shout' || e.type === 'whisper' || e.type === 'accusation') ? 'speech' :
      null;
    if (kind) out.push({ eventId: e.id, bot: spoken.bot, kind, text: spoken.text.replace(/\s+/g, ' ').trim() });
  }
  return out;
}
