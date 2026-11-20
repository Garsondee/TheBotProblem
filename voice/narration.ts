/**
 * The narrator's voice (Ingram, 2026-11-20: "We should voice the narrator too", then "the entire 'Story'
 * should be voiced").
 *
 * The narrator is the Director (analysis/director.ts), speaking in its own voice: chapter titles, the
 * narration between moments, what a fast-forward says, and the caption of each moment it shows (said as the
 * moment starts, before the bots speak in it). The narrator gets a voice no bot has, at its natural pitch:
 * the slight robot in the bots' voices is for bots, and the narrator is not one of them.
 */
import type { Story } from '../viewer/src/story';
import type { CastVoice } from './cast';

export interface NarrationLine {
  /** The story segment it belongs to (its index in story.json's segments). */
  segment: number;
  kind: 'chapter' | 'narrate' | 'zip' | 'caption';
  text: string;
}

/** What the narrator says, in story order. */
export function narrationLines(story: Story): NarrationLine[] {
  const out: NarrationLine[] = [];
  story.segments.forEach((seg, segment) => {
    const said =
      seg.type === 'chapter' ? { kind: 'chapter' as const, text: seg.title } :
      seg.type === 'narrate' ? { kind: 'narrate' as const, text: seg.text } :
      seg.type === 'zip' ? { kind: 'zip' as const, text: seg.text } :
      seg.type === 'show' ? { kind: 'caption' as const, text: seg.caption } :
      null;
    if (said && said.text.trim() !== '') out.push({ segment, kind: said.kind, text: said.text.replace(/\s+/g, ' ').trim() });
  });
  return out;
}

/** A storyteller's voice first: deep and British, then others, never one a bot already has. */
export const NARRATOR_VOICES: readonly string[] = ['bm_george', 'bm_fable', 'am_michael', 'bf_emma', 'af_heart'];

export function castNarrator(botVoices: Iterable<string>): CastVoice {
  const taken = new Set(botVoices);
  const voice = NARRATOR_VOICES.find((v) => !taken.has(v)) ?? (NARRATOR_VOICES[0] as string);
  return { voice, speed: 0.95, pitch: 1, why: "the narrator: a storyteller's voice no bot has, a little slower, at its natural pitch (it is not a bot)" };
}
