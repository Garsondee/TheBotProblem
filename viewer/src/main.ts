/**
 * The viewer: plays a recorded game back in the browser.
 *
 * npm run view opens it. Without ?run=<id> it lists the recorded games;
 * with one, it loads that game's replay.jsonl and plays it.
 *
 * Each frame: advance the clock (if playing), find the beat playing now
 * (script.ts), work out where everything is (state.ts), draw the canvas
 * (render/scene.ts), then place the HTML on top (tags, bubbles, cards) and
 * update the panels. Keyboard shortcuts act instantly, with no animation:
 * they get pressed far too often to wait for one.
 */
import '@fontsource/nunito/400.css';
import '@fontsource/nunito/600.css';
import '@fontsource/nunito/700.css';
import '@fontsource/nunito/800.css';
import '@fontsource/nunito/900.css';
import '@fontsource/nunito/400-italic.css';
import '@fontsource/jetbrains-mono/400.css';
import './style.css';
import { PHYS } from '../../engine/constants';
import type { GameData, GameEvent } from './data';
import { parseReplay } from './data';
import { Scene } from './render/scene';
import type { Beat, Script, ThoughtMode } from './script';
import { beatAt, beatForEvent, buildScript } from './script';
import type { Snapshot } from './state';
import { RoomPlayback } from './state';
import { el, shortReason, SVG_NS } from './ui/dom';
import { Cards, Cast, Controls, SPEEDS, Spectator } from './ui/panels';
import type { RunInfo } from './ui/picker';
import { showPicker } from './ui/picker';
import type { Anchor } from './ui/stage';
import { StageText } from './ui/stage';
import { Transcript } from './ui/transcript';

const PHASE_ORDER: Record<string, number> = { level: 0, declare: 1, talk: 2, commit: 3, resolve: 4, reflect: 5 };

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`bot-problem:${key}`);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}
function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(`bot-problem:${key}`, JSON.stringify(value));
  } catch {
    // Private windows and blocked storage: settings just won't be remembered.
  }
}

class Player {
  private t = 0;
  private playing = false;
  private speed = load<number>('speed', 1);
  private thoughts = load<ThoughtMode>('thoughts', 'commit');
  private wiring = load<boolean>('wiring', false);
  private viewAs: string | null = null;
  private spectatorOn = false;
  private script!: Script;
  private namesByBeat: Record<string, string | null>[] = [];
  private readonly playbacks: RoomPlayback[];
  private readonly scene: Scene;
  private readonly words: StageText;
  private readonly transcript: Transcript;
  private readonly cast: Cast;
  private readonly controls: Controls;
  private readonly cards: Cards;
  private readonly spectator: Spectator;
  private readonly stage: HTMLElement;
  private readonly roomLabel: HTMLElement;
  private readonly roundLabel: HTMLElement;
  private readonly phasePill: HTMLElement;
  private lastFrame = performance.now();
  private lastBeat = -1;
  private lastStep: number | null = null;
  private lastRoom = -1;
  private jumped = true;

  constructor(
    root: HTMLElement,
    private readonly game: GameData,
    runId: string,
  ) {
    if (!SPEEDS.includes(this.speed as (typeof SPEEDS)[number])) this.speed = 1;
    root.className = 'app';
    root.replaceChildren();

    const top = el('div', 'topbar');
    const brand = el('a', 'brand');
    brand.href = '/';
    brand.style.textDecoration = 'none';
    brand.innerHTML = '<b>The Bot Problem</b>';
    brand.title = `All recorded games (this one: ${runId})`;
    const where = el('div', 'where');
    this.roomLabel = el('span', 'room');
    this.roundLabel = el('span', 'round');
    where.append(this.roomLabel, this.roundLabel);
    this.phasePill = el('span', 'phase-pill');
    top.append(brand, where, this.phasePill);

    const castRow = el('div', 'cast');
    this.stage = el('div', 'stage');
    const canvas = el('canvas', 'scene');
    const overlay = el('div', 'overlay');
    const svg = document.createElementNS(SVG_NS, 'svg');
    overlay.append(svg);
    this.stage.append(canvas, overlay);
    const controlsRow = el('div', 'controls');
    const aside = el('aside', 'transcript');
    root.append(top, castRow, this.stage, controlsRow, aside);

    this.playbacks = game.rooms.map((r) => new RoomPlayback(r));
    this.scene = new Scene(canvas);
    // ?zoom=3&focus=5,3 enlarges the scene around a tile, for checking details. &t=42 starts 42 s in.
    const params = new URLSearchParams(location.search);
    const zoom = Number(params.get('zoom'));
    const [fx, fy] = (params.get('focus') ?? '').split(',').map(Number);
    if (zoom > 1 && Number.isFinite(fx) && Number.isFinite(fy)) this.scene.debugView = { zoom, cx: fx as number, cy: fy as number };
    this.words = new StageText(overlay, svg);
    this.cards = new Cards(overlay);
    this.spectator = new Spectator(this.stage, game, (bot) => this.setViewAs(bot));
    this.cast = new Cast(castRow, game, (bot) => this.setViewAs(this.viewAs === bot ? null : bot));
    this.transcript = new Transcript(aside, (beat) => this.seek(beat.start + 0.001));
    this.controls = new Controls(controlsRow, {
      toggle: () => this.togglePlay(),
      seek: (t) => this.seek(t),
      step: (d) => this.step(d),
      speed: (v) => {
        this.speed = v;
        save('speed', v);
      },
      thoughts: (m) => this.setThoughts(m),
      wiring: (on) => {
        this.wiring = on;
        save('wiring', on);
      },
      spectator: () => {
        this.spectatorOn = !this.spectatorOn;
        this.spectator.shown = this.spectatorOn;
      },
    });
    this.rebuild();
    const startAt = Number(params.get('t'));
    if (startAt > 0) this.seek(startAt);
    // A handle for checking the viewer from the browser console (find a beat, jump to it, play).
    (window as unknown as { botViewer: unknown }).botViewer = {
      beats: () => this.script.beats.map((b) => ({ i: b.index, kind: b.kind, room: b.room, round: b.round, phase: b.phase, bot: b.bot, start: b.start, dur: b.dur, types: b.events.map((e) => e.type) })),
      seek: (t: number) => this.seek(t),
      play: () => {
        if (!this.playing) this.togglePlay();
      },
      pause: () => {
        if (this.playing) this.togglePlay();
      },
    };
    window.addEventListener('keydown', (e) => this.key(e));
    requestAnimationFrame((n) => this.frame(n));
  }

  // ------------------------------------------------------------ the script, and names over time

  private rebuild(): void {
    const keep = this.script ? beatAt(this.script, this.t) : null;
    this.script = buildScript(this.game, { thoughts: this.thoughts });
    this.transcript.build(this.game, this.script);
    this.transcript.setThoughts(this.thoughts !== 'off');
    this.controls.build(this.script, this.game);
    this.namesByBeat = this.computeNames();
    if (keep) {
      // Stay at the same moment: the same beat if it still exists, else the start of its round.
      const k = keep.beat;
      const same =
        this.script.beats.find((b) => b.kind === k.kind && b.room === k.room && b.round === k.round && b.phase === k.phase && b.bot === k.bot) ??
        this.script.beats.find((b) => b.room === k.room && b.round === k.round) ??
        this.script.beats[0];
      if (same) this.t = same.start + Math.min(keep.local, same.dur * 0.99);
    }
    this.jumped = true;
  }

  private computeNames(): Record<string, string | null>[] {
    const beatOfEvent = new Map<number, number>();
    for (const b of this.script.beats) for (const e of b.events) if (!beatOfEvent.has(e.id)) beatOfEvent.set(e.id, b.index);
    const keyOf = (e: GameEvent) => e.levelIndex * 1e6 + e.round * 10 + (PHASE_ORDER[e.phase] ?? 0);
    const beatKey = (b: Beat) =>
      b.kind === 'room-intro' ? b.room * 1e6 :
      b.kind === 'room-end' ? b.room * 1e6 + 999_990 :
      b.kind === 'game-end' ? Infinity :
      b.kind === 'resolve' ? b.room * 1e6 + b.round * 10 + 4 :
      b.room * 1e6 + b.round * 10 + (PHASE_ORDER[b.phase ?? 'level'] ?? 0);
    const namings = this.game.events.filter((e): e is Extract<GameEvent, { type: 'name' }> => e.type === 'name');
    return this.script.beats.map((b) => {
      const names: Record<string, string | null> = Object.fromEntries(this.game.bots.map((id) => [id, null]));
      const key = beatKey(b);
      for (const e of namings) {
        const k = keyOf(e);
        const at = beatOfEvent.get(e.id);
        if (k < key || (k === key && at !== undefined && at <= b.index)) names[e.from] = e.name;
      }
      return names;
    });
  }

  // ------------------------------------------------------------ controls

  private togglePlay(): void {
    if (!this.playing && this.t >= this.script.total - 0.01) this.seek(0);
    this.playing = !this.playing;
  }

  private seek(t: number): void {
    this.t = Math.max(0, Math.min(this.script.total, t));
    this.jumped = true;
  }

  private step(dir: -1 | 1): void {
    const { beat, local } = beatAt(this.script, this.t);
    if (dir < 0 && local > 0.6) return this.seek(beat.start);
    const next = this.script.beats[beat.index + dir];
    if (next) this.seek(next.start);
  }

  private stepRound(dir: -1 | 1): void {
    const { beat } = beatAt(this.script, this.t);
    const beats = this.script.beats;
    const sameRound = (b: Beat) => b.room === beat.room && b.round === beat.round;
    if (dir > 0) {
      const next = beats.find((b) => b.index > beat.index && !sameRound(b) && (b.kind === 'phase' || b.kind === 'room-intro' || b.kind === 'room-end' || b.kind === 'game-end'));
      if (next) this.seek(next.start);
    } else {
      const firstOfThis = beats.find(sameRound);
      const target = firstOfThis && this.t - firstOfThis.start > 1 ? firstOfThis : [...beats].reverse().find((b) => b.index < (firstOfThis?.index ?? 0) && (b.kind === 'phase' || b.kind === 'room-intro'));
      if (target) {
        const start = beats.find((b) => b.room === target.room && b.round === target.round) ?? target;
        this.seek(start.start);
      }
    }
  }

  private setThoughts(mode: ThoughtMode): void {
    this.thoughts = mode;
    save('thoughts', mode);
    this.rebuild();
  }

  private setViewAs(bot: string | null): void {
    this.viewAs = bot;
  }

  private key(e: KeyboardEvent): void {
    if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return;
    switch (e.key) {
      case ' ':
        e.preventDefault();
        this.togglePlay();
        break;
      case 'ArrowRight':
        e.preventDefault();
        if (e.shiftKey) this.stepRound(1);
        else this.step(1);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (e.shiftKey) this.stepRound(-1);
        else this.step(-1);
        break;
      case '+':
      case '=': {
        const i = SPEEDS.indexOf(this.speed as (typeof SPEEDS)[number]);
        this.speed = SPEEDS[Math.min(SPEEDS.length - 1, i + 1)] ?? this.speed;
        save('speed', this.speed);
        break;
      }
      case '-': {
        const i = SPEEDS.indexOf(this.speed as (typeof SPEEDS)[number]);
        this.speed = SPEEDS[Math.max(0, i - 1)] ?? this.speed;
        save('speed', this.speed);
        break;
      }
      case 't':
        this.setThoughts(({ off: 'commit', commit: 'all', all: 'off' } as const)[this.thoughts]);
        break;
      case 'w':
        this.wiring = !this.wiring;
        save('wiring', this.wiring);
        break;
      case 'Escape':
        this.viewAs = null;
        break;
      default:
        break;
    }
  }

  // ------------------------------------------------------------ one frame

  private frame(now: number): void {
    const dt = Math.min(0.1, Math.max(0, (now - this.lastFrame) / 1000));
    this.lastFrame = now;
    if (this.playing) {
      this.t += dt * this.speed;
      if (this.t >= this.script.total) {
        this.t = this.script.total;
        this.playing = false;
      }
    }
    const { beat, local } = beatAt(this.script, this.t);
    const room = this.game.rooms[beat.room];
    const pb = this.playbacks[beat.room];
    if (!room || !pb) return;

    let snap: Snapshot;
    let step: number | null = null;
    if (beat.kind === 'resolve' && beat.resolve) {
      step = Math.min(beat.resolve.trace.steps, local * beat.resolve.trace.stepsPerSecond);
      snap = pb.during(beat.round, step);
    } else if (beat.kind === 'room-end' || beat.kind === 'game-end') {
      snap = pb.settledAt(Infinity);
    } else if (beat.kind === 'room-intro') {
      snap = pb.settledAt(0);
    } else {
      snap = pb.settledAt(beat.round);
    }
    // Did the playhead jump? Then nothing should animate its way to the new place.
    const sameBeat = beat.index === this.lastBeat;
    const jumped =
      this.jumped ||
      beat.room !== this.lastRoom ||
      (!sameBeat && beat.index !== this.lastBeat + 1) ||
      (sameBeat && step !== null && this.lastStep !== null && (step < this.lastStep || step - this.lastStep > 45));
    const prevStep = step === null ? null : sameBeat ? this.lastStep : beat.index === this.lastBeat + 1 ? 0 : null;

    const names = this.namesByBeat[beat.index] ?? {};
    const speaker = beat.kind === 'turn' ? beat.bot : null;
    const link = beat.events.find((e) => e.type === 'whisper' || e.type === 'order');
    const listener = link && (link.type === 'whisper' || link.type === 'order') ? link.to : null;

    const rect = this.stage.getBoundingClientRect();
    this.scene.resize(Math.round(rect.width), Math.round(rect.height));
    this.scene.draw({
      room,
      snap,
      resolve: beat.kind === 'resolve' ? beat.resolve : null,
      time: now / 1000,
      dt,
      jumped,
      prevStep,
      speaker,
      listener,
      viewAs: this.viewAs,
      wiring: this.wiring,
      stats: this.game.stats,
    });

    // Where each bot's head and feet are on screen, for the HTML on top.
    const tile = this.scene.space.tile;
    const anchors = new Map<string, Anchor>();
    const crates = new Set(room.level.crates.map((c) => c.id));
    for (const [id, b] of Object.entries(snap.bodies)) {
      if (crates.has(id) || b.look === 'exited' || snap.exited.has(id)) continue;
      const head = this.scene.toScreen(b.x + PHYS.botWidth / 2, b.y + PHYS.botHeight);
      const feet = this.scene.toScreen(b.x + PHYS.botWidth / 2, b.y);
      anchors.set(id, { x: head.x, head: head.y - tile * 0.42, feet: feet.y });
    }
    const inRoom = this.game.bots.filter((id) => anchors.has(id));
    this.words.syncTags(this.game.bots, names);
    this.words.placeTags(anchors, new Set(speaker ? [speaker] : []));
    this.words.showBeat(beat, this.game, room, names, this.thoughts);
    this.words.placeWords(anchors, rect.width, rect.height);
    const failing = new Map<string, string>();
    if (beat.kind === 'resolve' && beat.resolve && step !== null) {
      for (const r of beat.resolve.results) {
        if (r.status !== 'failed' && r.status !== 'cut') continue;
        const end = r.endStep - beat.resolve.trace.startStep;
        if (step >= end && step <= end + 110) failing.set(r.bot, `✕ ${shortReason(r.reason ?? (r.status === 'cut' ? 'ran out of time' : 'failed'))}`);
      }
    }
    this.words.placeResults(failing, anchors);
    void inRoom;

    this.cards.update(beat, this.game, names);
    this.cast.update(names, snap.coins, snap.exited, speaker, this.viewAs, room.kind === 'practice');
    this.transcript.highlight(beat.index);

    const roomText = `${room.name}`;
    if (this.roomLabel.textContent !== roomText) this.roomLabel.textContent = roomText;
    const roundText = beat.round > 0 && beat.kind !== 'room-end' ? `Round ${beat.round} of ${room.rounds}` : room.kind === 'practice' ? 'Practice room' : `Room ${room.index + 1} of ${this.game.rooms.length}`;
    if (this.roundLabel.textContent !== roundText) this.roundLabel.textContent = roundText;
    const phase = beat.kind === 'resolve' ? 'resolve' : beat.phase ?? '';
    const phaseText = { declare: 'Plans', talk: 'Talk', commit: 'Commit', resolve: 'Moving', '': beat.kind === 'room-intro' ? 'Starting' : beat.kind === 'room-end' ? 'Room over' : 'The end' }[phase] ?? '';
    if (this.phasePill.textContent !== phaseText) this.phasePill.textContent = phaseText;
    this.phasePill.dataset.phase = phase;
    this.controls.update(this.t, this.playing, this.speed, this.thoughts, this.wiring, this.spectatorOn);

    this.lastBeat = beat.index;
    this.lastStep = step;
    this.lastRoom = beat.room;
    this.jumped = false;
    requestAnimationFrame((n) => this.frame(n));
  }

  /** For the transcript: seek to the moment an event is shown. */
  seekToEvent(id: number): void {
    const b = beatForEvent(this.script, id);
    if (b) this.seek(b.start);
  }
}

async function start(): Promise<void> {
  const app = document.getElementById('app') as HTMLElement;
  const run = new URLSearchParams(location.search).get('run');
  try {
    if (!run) {
      const runs = (await (await fetch('/api/runs')).json()) as RunInfo[];
      showPicker(app, runs, (id) => {
        location.search = `?run=${encodeURIComponent(id)}`;
      });
      return;
    }
    const res = await fetch(`/api/runs/${encodeURIComponent(run)}/replay.jsonl`);
    if (!res.ok) throw new Error(`No replay for run "${run}".`);
    const game = parseReplay(await res.text());
    await document.fonts.ready;
    new Player(app, game, run);
  } catch (err) {
    app.replaceChildren(el('div', 'error', (err as Error).message));
  }
}

void start();
