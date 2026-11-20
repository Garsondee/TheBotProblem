/**
 * npm run voice -- <run>     give a recorded game's bots their voices: free, on this machine (spec section 8.3)
 *
 *   --only story,intro,diary,message,speech   which lines (default: story, intro, diary, message:
 *                     the Director's chosen lines, the introductions, the diary room, the final messages)
 *   --all             every line a bot says aloud as well (takes much longer; still free)
 *   --recast          cast the voices afresh, instead of keeping the run's saved cast
 *
 * Writes runs/<id>/voice/: one WAV per line and index.json, which holds the cast (each bot's voice, speed
 * and pitch, editable: change it and voice again) and each voiced line's file and length. A line's file is
 * named by a hash of its voice, speed and words, so voicing again never makes the same line twice (spec:
 * "Cache audio by text hash so re-runs never regenerate").
 *
 * Money rule 4: "re-voicing a recorded game must cost nothing." Kokoro-82M runs here, on the CPU; its
 * first use downloads the model (about 90 MB) from Hugging Face into node_modules, once.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { GameEvent } from '../../game/events';
import type { Persona } from '../../game/persona';
import type { CastVoice } from '../../voice/cast';
import { castVoices } from '../../voice/cast';
import type { LineKind } from '../../voice/lines';
import { DEFAULT_KINDS, linesToVoice } from '../../voice/lines';
import { wavFromSamples } from '../../voice/wav';
import { PATHS } from '../config';
import { writeJsonAtomic } from '../files';
import { say, warn } from '../log';

const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const ENGINE = 'Kokoro-82M v1.0 (q8, kokoro-js 1.2.1)';
const SAMPLE_RATE = 24_000;
const KINDS: readonly LineKind[] = ['story', 'intro', 'diary', 'message', 'speech'];
/** A voiced line's file name (the viewer's server serves only these). */
const VOICE_FILE = /^[0-9a-f]{16}\.wav$/;

export interface VoiceIndex {
  version: 1;
  engine: string;
  cast: Record<string, CastVoice>;
  lines: Record<string, { file: string; seconds: number; bot: string; kind: LineKind }>;
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    only: { type: 'string' },
    all: { type: 'boolean', default: false },
    recast: { type: 'boolean', default: false },
  },
});

const runArg = positionals[0];
if (!runArg) {
  warn('Which game? npm run voice -- <run id>, for example npm run voice -- 20261120-042702-game');
  process.exit(1);
}
const runDir = existsSync(join(PATHS.runs, runArg)) ? join(PATHS.runs, runArg) : resolve(runArg);
if (!existsSync(join(runDir, 'replay.jsonl'))) {
  warn(`No replay.jsonl in ${runArg}.`);
  process.exit(1);
}
const kinds = new Set<LineKind>(values.all ? KINDS : values.only ? (values.only.split(',').map((s) => s.trim()) as LineKind[]) : DEFAULT_KINDS);
for (const k of kinds) {
  if (!KINDS.includes(k)) {
    warn(`--only ${k}: the kinds are ${KINDS.join(', ')}.`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------- the game, its story and its saved cast
const records = readFileSync(join(runDir, 'replay.jsonl'), 'utf8')
  .split('\n')
  .filter((l) => l.trim() !== '')
  .map((l) => JSON.parse(l) as Record<string, unknown> & { rec: string });
const header = records.find((r) => r.rec === 'game') as { seats: { bot: string; agent?: string | null; persona?: Persona }[] } | undefined;
if (!header) {
  warn('That replay has no game header.');
  process.exit(1);
}
const events = records.filter((r) => r.rec === 'event') as unknown as GameEvent[];
const storyPath = join(runDir, 'story.json');
const storyIds = existsSync(storyPath) ? ((JSON.parse(readFileSync(storyPath, 'utf8')) as { voiceLines?: number[] }).voiceLines ?? []) : null;
if (kinds.has('story') && !storyIds) say('No story yet (npm run direct makes one), so no chosen lines: the rest only.');

const voiceDir = join(runDir, 'voice');
mkdirSync(voiceDir, { recursive: true });
const indexPath = join(voiceDir, 'index.json');
const before: VoiceIndex | null = existsSync(indexPath) ? (JSON.parse(readFileSync(indexPath, 'utf8')) as VoiceIndex) : null;
const cast: Record<string, CastVoice> = !values.recast && before ? before.cast : castVoices(header.seats);
say(`Voicing ${basename(runDir)} with ${ENGINE}.`);
for (const [bot, c] of Object.entries(cast)) say(`  ${bot}: ${c.voice}, speed ${c.speed}, pitch ${c.pitch}  (${c.why})`);

// ---------------------------------------------------------------- the lines
const lines = linesToVoice(events, storyIds, kinds);
const index: VoiceIndex = { version: 1, engine: ENGINE, cast, lines: {} };
/** Underscores read aloud as words: walk_to is "walk to". The recording keeps the bot's own spelling. */
const spoken = (text: string) => text.replace(/_/g, ' ');
/** Kokoro reads up to a few hundred characters well at once: longer lines go sentence by sentence. */
function chunks(text: string): string[] {
  const out: string[] = [];
  for (const sentence of text.split(/(?<=[.!?…])\s+/)) {
    const last = out.at(-1);
    if (last !== undefined && last.length + sentence.length < 220) out[out.length - 1] = `${last} ${sentence}`;
    else out.push(sentence);
  }
  return out.filter((s) => s.trim() !== '');
}

type Tts = { generate(text: string, o: { voice: string; speed: number }): Promise<{ audio: Float32Array; sampling_rate: number }> };
let tts: Tts | null = null;
async function engine(): Promise<Tts> {
  if (tts) return tts;
  say('Loading Kokoro (the first time, it downloads the model, about 90 MB)...');
  const { KokoroTTS } = await import('kokoro-js');
  tts = (await KokoroTTS.from_pretrained(MODEL, { dtype: 'q8', device: 'cpu' })) as unknown as Tts;
  return tts;
}

const started = Date.now();
let made = 0;
let reused = 0;
let audioSeconds = 0;
for (const [i, line] of lines.entries()) {
  const c = cast[line.bot];
  if (!c) continue;
  const file = `${createHash('sha256').update(`${c.voice}|${c.speed}|${line.text}`).digest('hex').slice(0, 16)}.wav`;
  const path = join(voiceDir, file);
  let seconds: number;
  if (existsSync(path)) {
    seconds = (statSync(path).size - 44) / 2 / SAMPLE_RATE;
    reused += 1;
  } else {
    const t0 = Date.now();
    const tts = await engine();
    const parts: Float32Array[] = [];
    for (const piece of chunks(spoken(line.text))) {
      const out = await tts.generate(piece, { voice: c.voice, speed: c.speed });
      if (out.sampling_rate !== SAMPLE_RATE) throw new Error(`Kokoro gave ${out.sampling_rate} Hz audio; this expects ${SAMPLE_RATE}.`);
      parts.push(out.audio, new Float32Array(Math.round(SAMPLE_RATE * 0.18))); // a breath between sentences
    }
    const samples = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      samples.set(p, at);
      at += p.length;
    }
    writeFileSync(path, wavFromSamples(samples, SAMPLE_RATE));
    seconds = samples.length / SAMPLE_RATE;
    made += 1;
    say(`  [${i + 1}/${lines.length}] ${line.bot} (${line.kind}): ${seconds.toFixed(1)}s of voice, made in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
  audioSeconds += seconds;
  index.lines[String(line.eventId)] = { file, seconds: Math.round(seconds * 100) / 100, bot: line.bot, kind: line.kind };
}
await writeJsonAtomic(indexPath, index);
// Lines no longer in the index (after a re-cast, say) are this command's own leftovers: tidy them away.
const kept = new Set(Object.values(index.lines).map((l) => l.file));
const stale = readdirSync(voiceDir).filter((f) => VOICE_FILE.test(f) && !kept.has(f));
for (const f of stale) rmSync(join(voiceDir, f));
if (stale.length > 0) say(`Removed ${stale.length} voiced line${stale.length === 1 ? '' : 's'} no longer used.`);
say('');
say(`Voiced ${lines.length} lines (${made} made, ${reused} already there): ${Math.round(audioSeconds)}s of speech, in ${Math.round((Date.now() - started) / 1000)}s. Free.`);
say(`Saved: ${join(basename(runDir), 'voice')}. Play it with npm run view; the Voices switch turns them on and off.`);
