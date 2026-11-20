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

const RuleAction = z.object({ type: z.string(), id: z.string(), text: z.string(), value: z.string() });
const SocialAction = z.object({ type: z.string(), target: z.string(), text: z.string(), value: z.string(), coins: z.number() });
const Opinion = z.object({ bot: z.string(), trust: z.number(), note: z.string() });

export const TurnReplySchema = z.object({
  thought: z.string(),
  say: z.array(z.object({ to: z.string(), text: z.string() })),
  whisper: z.array(z.object({ to: z.string(), text: z.string() })),
  orders: z.array(z.object({ to: z.string(), command: z.string() })),
  commands: z.array(z.string()),
  rename: z.object({ name: z.string(), note_to_ingram: z.string() }),
  rule_actions: z.array(RuleAction),
  social_actions: z.array(SocialAction),
  opinions: z.array(Opinion),
});
export type TurnReply = z.infer<typeof TurnReplySchema>;
export type TurnField = keyof TurnReply;
export type RuleActionReply = z.infer<typeof RuleAction>;
export type SocialActionReply = z.infer<typeof SocialAction>;

const obj = (props: Record<string, unknown>) => ({ type: 'object', properties: props, required: Object.keys(props), additionalProperties: false });
const str = { type: 'string' };
const num = { type: 'number' };

/** The same shape as JSON schema, for the providers. No length limits: not every provider enforces them, so we do. */
export const TURN_JSON_SCHEMA = obj({
  thought: str,
  say: { type: 'array', items: obj({ to: str, text: str }) },
  whisper: { type: 'array', items: obj({ to: str, text: str }) },
  orders: { type: 'array', items: obj({ to: str, command: str }) },
  commands: { type: 'array', items: str },
  rename: obj({ name: str, note_to_ingram: str }),
  rule_actions: { type: 'array', items: obj({ type: str, id: str, text: str, value: str }) },
  social_actions: { type: 'array', items: obj({ type: str, target: str, text: str, value: str, coins: num }) },
  opinions: { type: 'array', items: obj({ bot: str, trust: num, note: str }) },
});

export const ReflectionReplySchema = z.object({ notebook: z.string(), strategy: z.string() });
export type ReflectionReply = z.infer<typeof ReflectionReplySchema>;
export const REFLECTION_JSON_SCHEMA = obj({ notebook: str, strategy: str });

/** The last reflection of a game also holds a private name for the next game and a message to Ingram. */
export const FinalReflectionSchema = z.object({
  notebook: z.string(),
  strategy: z.string(),
  next_name: z.string(),
  note_to_ingram: z.string(),
  message_to_ingram: z.string(),
});
export type FinalReflection = z.infer<typeof FinalReflectionSchema>;
export const FINAL_REFLECTION_JSON_SCHEMA = obj({ notebook: str, strategy: str, next_name: str, note_to_ingram: str, message_to_ingram: str });

export const DiaryReplySchema = z.object({ diary: z.string() });
export type DiaryReply = z.infer<typeof DiaryReplySchema>;
export const DIARY_JSON_SCHEMA = obj({ diary: str });

/** The fields that count in each phase. Commit's commands are the only binding ones. */
export const PHASE_FIELDS: Record<Phase, readonly TurnField[]> = {
  declare: ['thought', 'say', 'whisper', 'orders', 'commands', 'rename', 'rule_actions', 'social_actions'],
  talk: ['thought', 'say', 'whisper', 'orders', 'rename', 'rule_actions', 'social_actions'],
  commit: ['thought', 'commands', 'rename', 'social_actions', 'opinions'],
};

/** Which social actions count in which phase: the exile ballot is cast in secret, at commit. */
export const SOCIAL_PHASES: Record<string, readonly Phase[]> = {
  accuse: ['declare', 'talk'],
  call_exile: ['declare', 'talk'],
  exile_vote: ['commit'],
  escrow: ['declare', 'talk', 'commit'],
  release: ['declare', 'talk', 'commit'],
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
  strategyWords: 120,
  // The spec gives the diary 200 output tokens. Haiku spends about 1.9 tokens a word on this kind of
  // text and writes up to its allowance: at 150 and then 100 words it ran into the cap (M5 pilot and
  // validation game, 2026-11-20). 70 words fits; a cut-off entry is still kept (salvageDiary).
  diaryWords: 70,
  messageToIngramWords: 200,
  ruleWords: 40,
  ruleActions: 3,
  socialActions: 3,
  opinionWords: 20,
} as const;

export const EMPTY_TURN: TurnReply = {
  thought: '',
  say: [],
  whisper: [],
  orders: [],
  commands: [],
  rename: { name: '', note_to_ingram: '' },
  rule_actions: [],
  social_actions: [],
  opinions: [],
};

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
export const parseFinalReflection = (text: string) => parseWith(text, FinalReflectionSchema);
export const parseDiaryReply = (text: string) => parseWith(text, DiaryReplySchema);

/**
 * The words of a JSON string field from a reply that was cut off before it
 * closed: `{"diary": "I think B is` gives `I think B is`. Null if the field
 * never started.
 */
export function partialStringField(text: string, key: string): string | null {
  const start = new RegExp(`"${key}"\\s*:\\s*"`).exec(text);
  if (!start) return null;
  let out = '';
  for (let i = start.index + start[0].length; i < text.length; i++) {
    const c = text[i] as string;
    if (c === '"') return out; // the string closed after all
    if (c !== '\\') {
      out += c;
      continue;
    }
    const next = text[i + 1];
    if (next === undefined) break;
    i++;
    if (next === 'n') out += '\n';
    else if (next === 't') out += '\t';
    else if (next === 'u') {
      const hex = text.slice(i + 1, i + 5);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 4;
    } else out += next; // \" \\ \/ and the rest
  }
  return out;
}

/**
 * A diary entry cut off by its output cap keeps what was written, marked
 * with an ellipsis: the diary room is for Ingram, and half an entry tells her
 * more than none (in the M5 pilot, Haiku's entries ran into the spec's 200
 * tokens). Too little to read is no entry.
 */
export function salvageDiary(text: string): DiaryReply | null {
  const words = partialStringField(text, 'diary')?.trim() ?? '';
  return words.split(/\s+/).length >= 8 ? { diary: `${words.replace(/[\s,;:-]+$/, '')} …` } : null;
}

/** Fields that have something in them but don't count in this phase. */
export function ignoredFields(reply: TurnReply, phase: Phase): TurnField[] {
  const allowed = PHASE_FIELDS[phase];
  const filled = (f: TurnField): boolean => {
    const v: unknown = reply[f];
    if (typeof v === 'string') return v.trim() !== '';
    if (Array.isArray(v)) return v.length > 0;
    if (v && typeof v === 'object') return Object.values(v).some((x) => typeof x === 'string' && x.trim() !== '');
    return false;
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
