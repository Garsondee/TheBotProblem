/**
 * The bots' voices (npm run voice; spec section 8.3): "The viewer plays audio in sync with bubbles and never
 * overlaps two voices; it queues them."
 *
 * Each line was made once, on Ingram's machine, by Kokoro; the viewer only plays the files. A bot's pitch is
 * applied here, by playing its lines a little faster or slower without keeping the pitch, so the same
 * recording can be re-pitched without voicing it again.
 */

/** runs/<id>/voice/index.json (harness/cli/voice.ts writes it). */
export interface VoiceManifest {
  version: 1;
  engine: string;
  cast: Record<string, { voice: string; speed: number; pitch: number; why?: string }>;
  lines: Record<string, { file: string; seconds: number; bot: string; kind: string }>;
}

/** How long each voiced line plays, by event id: its length at its bot's pitch. */
export function voiceSeconds(m: VoiceManifest): Map<number, number> {
  return new Map(Object.entries(m.lines).map(([id, l]) => [Number(id), l.seconds / (m.cast[l.bot]?.pitch ?? 1)]));
}

export class VoicePlayer {
  private queue: { url: string; rate: number; volume: number }[] = [];
  private current: HTMLAudioElement | null = null;

  constructor(
    private readonly run: string,
    private readonly manifest: VoiceManifest,
  ) {}

  /**
   * Queue the voiced lines among these events, in order, behind anything still playing. At a faster playback
   * speed they play faster too (and higher: the pitch isn't kept), so they keep up with the pictures.
   */
  play(eventIds: readonly number[], speed = 1): void {
    for (const id of eventIds) {
      const line = this.manifest.lines[String(id)];
      if (!line) continue;
      // A thought the Director chose is heard quietly: a mind being read, not a bot speaking.
      this.queue.push({ url: `/api/runs/${encodeURIComponent(this.run)}/voice/${line.file}`, rate: (this.manifest.cast[line.bot]?.pitch ?? 1) * speed, volume: line.kind === 'thought' ? 0.5 : 1 });
    }
    if (!this.current) this.next();
  }

  /** Pausing, seeking, or switching voices off: silence at once, and forget what was waiting. */
  stop(): void {
    this.queue = [];
    if (this.current) {
      this.current.onended = null;
      this.current.pause();
    }
    this.current = null;
  }

  private next(): void {
    const item = this.queue.shift();
    if (!item) {
      this.current = null;
      return;
    }
    const audio = new Audio(item.url);
    // Played faster or slower without keeping the pitch: the robot in the voice is on purpose.
    audio.preservesPitch = false;
    audio.playbackRate = item.rate;
    audio.volume = item.volume;
    audio.onended = () => this.next();
    audio.onerror = () => this.next();
    this.current = audio;
    audio.play().catch(() => this.next());
  }
}
