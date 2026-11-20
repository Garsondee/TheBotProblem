/**
 * How long voiced lines play (npm run voice; spec section 8.3), worked out from the voice manifest. Pure:
 * no browser in here, so the tests can check the timing; viewer/src/voices.ts plays the sound.
 */

/** runs/<id>/voice/index.json (harness/cli/voice.ts writes it). */
export interface VoiceManifest {
  version: 1;
  engine: string;
  cast: Record<string, { voice: string; speed: number; pitch: number; why?: string }>;
  lines: Record<string, { file: string; seconds: number; bot: string; kind: string }>;
  /** The narrator's voice and its lines, by story segment, each with the words it says (voice/narration.ts). */
  narrator?: { voice: string; speed: number; pitch: number; why?: string };
  narration?: Record<string, { file: string; seconds: number; kind: string; text: string }>;
}

/** How long each voiced line plays, by event id: its length at its bot's pitch. */
export function voiceSeconds(m: VoiceManifest): Map<number, number> {
  return new Map(Object.entries(m.lines).map(([id, l]) => [Number(id), l.seconds / (m.cast[l.bot]?.pitch ?? 1)]));
}

/** The words a story segment's narrator says (a chapter's title, a narration, a fast-forward's line), or null. */
function narratorWords(seg: { type: string; title?: string; text?: string }): string | null {
  const text = seg.type === 'chapter' ? seg.title : seg.type === 'narrate' || seg.type === 'zip' ? seg.text : undefined;
  return text === undefined ? null : text.replace(/\s+/g, ' ').trim();
}

/**
 * The narration that still fits this story, by segment: how long each plays. A line counts only if the
 * segment still says the same words, so a story directed again after voicing never plays the wrong line.
 */
export function narrationSeconds(m: VoiceManifest, segments: readonly { type: string; title?: string; text?: string }[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const [i, line] of Object.entries(m.narration ?? {})) {
    const seg = segments[Number(i)];
    if (seg && narratorWords(seg) === line.text) out.set(Number(i), line.seconds / (m.narrator?.pitch ?? 1));
  }
  return out;
}
