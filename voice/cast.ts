/**
 * Voice casting (spec section 8.3): "Cast each bot a distinct voice ... matched loosely to its persona
 * (pitch, accent and speed). Save the mapping in the run."
 *
 * The voices are Kokoro-82M's English ones with a grade of C or better (Kokoro's own grading of each
 * voice's quality, from its model card). What each sounds like here (warm, strong, bright) is a rough
 * description, not a measurement, which is why the casting is loose by design: the mapping is saved in
 * runs/<id>/voice/index.json, and editing its "cast" and voicing again changes it.
 *
 * Each bot is matched on its personality (game/persona.ts): warmth to a warm voice, boldness to a strong
 * one, curiosity to a bright one. Patience sets the speed (the impatient talk faster). Boldness also sets a
 * pitch, applied when the viewer plays the line without keeping the pitch: bold bots sound a little lower,
 * timid ones a little higher, and every bot a little less human. Ingram asked for fun voices.
 */
import type { Persona } from '../game/persona';

export interface VoiceInfo {
  id: string;
  accent: 'American' | 'British';
  /** Rough qualities, 0 to 1. */
  warm: number;
  strong: number;
  bright: number;
  /** Kokoro's own grade for the voice. */
  grade: string;
}

export const VOICES: readonly VoiceInfo[] = [
  { id: 'af_heart', accent: 'American', warm: 0.9, strong: 0.5, bright: 0.6, grade: 'A' },
  { id: 'af_bella', accent: 'American', warm: 0.8, strong: 0.6, bright: 0.7, grade: 'A-' },
  { id: 'af_nicole', accent: 'American', warm: 0.7, strong: 0.1, bright: 0.3, grade: 'B-' },
  { id: 'bf_emma', accent: 'British', warm: 0.6, strong: 0.4, bright: 0.4, grade: 'B-' },
  { id: 'af_aoede', accent: 'American', warm: 0.5, strong: 0.4, bright: 0.6, grade: 'C+' },
  { id: 'af_kore', accent: 'American', warm: 0.5, strong: 0.6, bright: 0.5, grade: 'C+' },
  { id: 'af_sarah', accent: 'American', warm: 0.6, strong: 0.3, bright: 0.5, grade: 'C+' },
  { id: 'am_fenrir', accent: 'American', warm: 0.3, strong: 0.9, bright: 0.3, grade: 'C+' },
  { id: 'am_michael', accent: 'American', warm: 0.7, strong: 0.6, bright: 0.4, grade: 'C+' },
  { id: 'am_puck', accent: 'American', warm: 0.5, strong: 0.4, bright: 0.9, grade: 'C+' },
  { id: 'bf_isabella', accent: 'British', warm: 0.4, strong: 0.5, bright: 0.7, grade: 'C' },
  { id: 'bm_george', accent: 'British', warm: 0.4, strong: 0.8, bright: 0.2, grade: 'C' },
  { id: 'bm_fable', accent: 'British', warm: 0.6, strong: 0.5, bright: 0.8, grade: 'C' },
  { id: 'af_alloy', accent: 'American', warm: 0.3, strong: 0.5, bright: 0.5, grade: 'C' },
  { id: 'af_nova', accent: 'American', warm: 0.4, strong: 0.4, bright: 0.8, grade: 'C' },
];

export interface CastVoice {
  voice: string;
  /** Kokoro's speaking speed (1 is its normal). */
  speed: number;
  /** Played back at this rate without keeping the pitch: below 1 is lower and slower, above 1 higher and quicker. */
  pitch: number;
  why: string;
}

const unit = (n: number) => (n - 1) / 9; // a trait (1 to 10) as 0 to 1

/**
 * For a bot from before personalities existed: one made up from its agent id, used for its voice and nothing
 * else. Without it every such bot was cast as average, and five nearly alike voices came out (the first
 * voiced game, 2026-11-20).
 */
function voiceOnlyPersona(id: string): Persona {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  const trait = (k: number) => 1 + (((h >>> (k * 7)) & 0x7f) % 10);
  return { traits: { boldness: trait(0), warmth: trait(1), honesty: 5, curiosity: trait(2), patience: trait(3) } };
}
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * A distinct voice for every bot: each takes the nearest voice to its personality that no bot before it has
 * taken. They choose in the order of their lasting agent ids (game/memory.ts), not their letters, which are
 * dealt afresh each game: so the same cast, with the same personalities, sounds the same from game to game.
 * Bots without a personality (older games) are cast from one made up from their agent id, for the voice only.
 */
export function castVoices(bots: readonly { bot: string; agent?: string | null | undefined; persona?: Persona | undefined }[]): Record<string, CastVoice> {
  const taken = new Set<string>();
  const cast: Record<string, CastVoice> = {};
  const order = (x: { bot: string; agent?: string | null | undefined }) => x.agent ?? x.bot;
  for (const x of [...bots].sort((a, b) => order(a).localeCompare(order(b)))) {
    const { bot, persona } = x;
    const t = (persona ?? voiceOnlyPersona(order(x))).traits;
    const want = { warm: unit(t.warmth), strong: unit(t.boldness), bright: unit(t.curiosity) };
    const free = VOICES.filter((v) => !taken.has(v.id));
    const pool = free.length > 0 ? free : VOICES; // more bots than voices: share, nearest first
    const best = [...pool].sort((a, b) => distance(a, want) - distance(b, want) || a.id.localeCompare(b.id))[0] as VoiceInfo;
    taken.add(best.id);
    cast[bot] = {
      voice: best.id,
      speed: round2(1.12 - unit(t.patience) * 0.22),
      pitch: round2(1.1 - unit(t.boldness) * 0.18),
      why: persona
        ? `warmth ${t.warmth}, boldness ${t.boldness}, curiosity ${t.curiosity} chose ${best.id}; patience ${t.patience} sets the speed, boldness the pitch`
        : `no personality recorded: one made up from its id (warmth ${t.warmth}, boldness ${t.boldness}, curiosity ${t.curiosity}, patience ${t.patience}), for its voice only, chose ${best.id}`,
    };
  }
  return cast;
}

function distance(v: VoiceInfo, want: { warm: number; strong: number; bright: number }): number {
  return (v.warm - want.warm) ** 2 + (v.strong - want.strong) ** 2 + (v.bright - want.bright) ** 2;
}
