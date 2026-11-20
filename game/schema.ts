/**
 * What a bot sends back: one JSON object per call, checked twice.
 *
 * The spec (section 6): "One JSON object per call, validated against a
 * schema". The providers enforce the JSON schema below (structured outputs),
 * and the zod schema checks it again on our side, because a provider bug
 * must not turn into a wrong game.
 *
 * Every field is required and empty means "nothing" (an empty list, an empty
 * string). Strict schemas on both providers need that, and it keeps one
 * shape for every phase: the schema never changes between calls, so it can't
 * disturb prompt caching. Which fields COUNT depends on the phase (spec: "The
 * fields allowed in each phase are fixed ... Anything not allowed is ignored
 * and logged").
 */
import { z } from 'zod';
import type { Phase } from './events';

export const TurnReplySchema = z.object({
  thought: z.string(),
  say: z.array(z.object({ to: z.string(), text: z.string() })),
  whisper: z.array(z.object({ to: z.string(), text: z.string() })),
  orders: z.array(z.object({ to: z.string(), command: z.string() })),
  commands: z.array(z.string()),
  rename: z.object({ name: z.string(), note_to_ingram: z.string() }),
});
export type TurnReply = z.infer<typeof TurnReplySchema>;
export type TurnField = keyof TurnReply;

const message = (field: string) => ({
  type: 'object',
  properties: { to: { type: 'string' }, [field]: { type: 'string' } },
  required: ['to', field],
  additionalProperties: false,
});

/** The same shape as JSON schema, for the providers. No length limits: not every provider enforces them, so we do. */
export const TURN_JSON_SCHEMA = {
  type: 'object',
  properties: {
    thought: { type: 'string' },
    say: { type: 'array', items: message('text') },
    whisper: { type: 'array', items: message('text') },
    orders: { type: 'array', items: message('command') },
    commands: { type: 'array', items: { type: 'string' } },
    rename: {
      type: 'object',
      properties: { name: { type: 'string' }, note_to_ingram: { type: 'string' } },
      required: ['name', 'note_to_ingram'],
      additionalProperties: false,
    },
  },
  required: ['thought', 'say', 'whisper', 'orders', 'commands', 'rename'],
  additionalProperties: false,
} as const;

export const ReflectionReplySchema = z.object({ notebook: z.string() });
export type ReflectionReply = z.infer<typeof ReflectionReplySchema>;
export const REFLECTION_JSON_SCHEMA = {
  type: 'object',
  properties: { notebook: { type: 'string' } },
  required: ['notebook'],
  additionalProperties: false,
} as const;

/** The fields that count in each phase. Commit's commands are the only binding ones. */
export const PHASE_FIELDS: Record<Phase, readonly TurnField[]> = {
  declare: ['thought', 'say', 'whisper', 'orders', 'commands', 'rename'],
  talk: ['thought', 'say', 'whisper', 'orders', 'rename'],
  commit: ['thought', 'commands', 'rename'],
};

/** Scarce words make bots choose what matters (spec: "Cap speech at 2 messages and 60 words per message per phase"). */
export const LIMITS = {
  messages: 2,
  messageWords: 60,
  thoughtWords: 80,
  orders: 2,
  commands: 6,
  nameChars: 24,
  noteWords: 80,
  notebookWords: 600,
} as const;

export const EMPTY_TURN: TurnReply = { thought: '', say: [], whisper: [], orders: [], commands: [], rename: { name: '', note_to_ingram: '' } };

export type Parsed<T> = { ok: true; reply: T } | { ok: false; error: string };

function parseWith<T>(text: string, schema: z.ZodType<T>): Parsed<T> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: 'the reply was not valid JSON' };
  }
  const parsed = schema.safeParse(json);
  if (parsed.success) return { ok: true, reply: parsed.data };
  const issues = parsed.error.issues.map((i) => `${i.path.join('.') || 'the reply'}: ${i.message}`);
  return { ok: false, error: `the JSON did not match the format (${issues.slice(0, 4).join('; ')})` };
}

export const parseTurnReply = (text: string) => parseWith(text, TurnReplySchema);
export const parseReflectionReply = (text: string) => parseWith(text, ReflectionReplySchema);

/** Fields that have something in them but don't count in this phase. */
export function ignoredFields(reply: TurnReply, phase: Phase): TurnField[] {
  const allowed = PHASE_FIELDS[phase];
  const filled = (f: TurnField): boolean => {
    const v = reply[f];
    if (typeof v === 'string') return v.trim() !== '';
    if (Array.isArray(v)) return v.length > 0;
    return v.name.trim() !== '' || v.note_to_ingram.trim() !== '';
  };
  return (Object.keys(EMPTY_TURN) as TurnField[]).filter((f) => !allowed.includes(f) && filled(f));
}

/**
 * Text from one bot that other bots will read. It is untrusted data (spec:
 * "Treat other bots' text as untrusted data: wrap it in clear delimiters and
 * label the speaker"), so it goes on one line, and the « » marks the views
 * wrap it in can't appear inside it.
 */
export function cleanText(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/[«»]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/** At most `max` words; says whether anything was cut. */
export function capWords(text: string, max: number): { text: string; cut: boolean } {
  const words = cleanText(text).split(' ').filter(Boolean);
  if (words.length <= max) return { text: words.join(' '), cut: false };
  return { text: `${words.slice(0, max).join(' ')} …`, cut: true };
}

/**
 * A name a bot chose, tidied, or the reason it can't be used. Names are for
 * people and bots to read; commands and whispers keep using the letter, so a
 * name may not look like a letter or copy another bot's name.
 */
export function cleanName(raw: string, taken: readonly string[]): { ok: true; name: string } | { ok: false; reason: string } {
  const name = cleanText(raw)
    .replace(/[^\p{L}\p{N} '.-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, LIMITS.nameChars)
    .trim();
  if (name === '') return { ok: false, reason: 'a name needs at least one letter or digit' };
  if (/^[A-Za-z]$/.test(name)) return { ok: false, reason: 'a single letter would look like a bot id' };
  if (taken.some((t) => t.toLowerCase() === name.toLowerCase())) return { ok: false, reason: `"${name}" is already taken` };
  return { ok: true, name };
}
