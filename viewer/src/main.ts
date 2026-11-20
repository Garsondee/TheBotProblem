/**
 * The viewer: plays a recorded game back in the browser.
 *
 * npm run view opens it. Without ?run=<id> it lists the recorded games;
 * with one, it loads that game's replay.jsonl and plays it.
 *
 * Two modes. Story (when the Director has made runs/<id>/story.json, and
 * the default then: Ingram wants the story, not half an hour of footage)
 * plays the story's timeline: chapter cards, narration over held scenes,
 * quotes, the chosen moments, and fast-forwards. Full plays every beat of
 * the game. ?mode=full opens the full game.
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
import { parseReplay, startNames } from './data';
import { Scene } from './render/scene';
import type { Beat, Script, ThoughtMode } from './script';
import { beatAt, beatForEvent, buildScript } from './script';
import type { VoiceManifest } from './voices';
import { segmentSeconds, VoicePlayer, voiceSeconds } from './voices';
import type { Snapshot } from './state';
import { heightOf, RoomPlayback } from './state';
import type { Story, StoryItem, StoryTimeline } from './story';
import { storyItemAt, storyTimeline, zipPosition } from './story';
import { el, shortReason, SVG_NS } from './ui/dom';
import { Cards, Cast, Controls, SPEEDS, Spectator } from './ui/panels';
import type { RunInfo } from './ui/picker';
import { showPicker } from './ui/picker';
import type { Anchor } from './ui/stage';
import { StageText } from './ui/stage';
import { StoryLayer } from './ui/story';
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

type Mode = 'story' | 'full';

class Player {
  private t = 0;
  /** Story time: where the story's own timeline is (Story mode). */
  private storyT = 0;
  private mode: Mode;
  private timeline: StoryTimeline | null = null;
  private ghostsByBeat: Set<string>[] = [];
  private readonly storyLayer: StoryLayer;
  private readonly modeButtons = new Map<Mode, HTMLButtonElement>();
  /** Personality colours by bot (games with personas): the eyes show them. */
  private readonly auras: Record<string, string>;
  private playing = false;
  private speed = load<number>('speed', 1);
  private thoughts = load<ThoughtMode>('thoughts', 'commit');
  private wiring = load<boolean>('wiring', false);
  private viewAs: string | null = null;
  private spectatorOn = false;
  /** The bots' voices, for games that have been voiced (npm run voice). */
  private readonly voices: VoicePlayer | null;
  private readonly voiceLengths: Map<number, number> | null;
  /** The story's own voiced lines that still fit it, by segment (the narrator's, the quote cards'): how long each plays. */
  private readonly narrationFits: Map<number, number> | null;
  private voicesOn = load<boolean>('voices', true);
  /** The beat or story item whose lines were last queued. */
  private voicedKey = '';
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
    private readonly story: Story | null,
    startMode: Mode,
    voiceManifest: VoiceManifest | null,
  ) {
    this.mode = story ? startMode : 'full';
    this.voices = voiceManifest ? new VoicePlayer(runId, voiceManifest) : null;
    this.voiceLengths = voiceManifest ? voiceSeconds(voiceManifest) : null;
    this.narrationFits = voiceManifest && story ? segmentSeconds(voiceManifest, story.segments) : null;
    this.auras = Object.fromEntries(game.seats.flatMap((s) => (s.colour ? [[s.bot, s.colour.hex]] : [])));
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
    if (story) {
      const modes = el('div', 'segmented modes');
      modes.title = `Story: "${story.title}", told by the Director in a few minutes. Full game: every moment.`;
      for (const [m, label] of [['story', 'Story'], ['full', 'Full game']] as const) {
        const b = el('button', '', label);
        b.addEventListener('click', () => this.setMode(m));
        modes.append(b);
        this.modeButtons.set(m, b);
      }
      top.append(modes);
    }

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
    this.storyLayer = new StoryLayer(overlay);
    this.spectator = new Spectator(this.stage, game, (bot) => this.setViewAs(bot));
    this.cast = new Cast(castRow, game, (bot) => this.setViewAs(this.viewAs === bot ? null : bot));
    // A line in the transcript opens that moment in the full game, whatever the mode.
    this.transcript = new Transcript(aside, (beat) => {
      if (this.mode === 'story') this.setMode('full');
      this.t = Math.max(0, Math.min(this.script.total, beat.start + 0.001));
      this.jumped = true;
    });
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
      voices: (on) => {
        this.voicesOn = on;
        save('voices', on);
        this.voices?.stop();
        this.voicedKey = '';
        // Voiced turns last as long as their lines; without voices they go back to reading time.
        this.rebuild();
      },
    });
    this.rebuild();
    const startAt = Number(params.get('t'));
    if (startAt > 0) this.seek(startAt);
    // A handle for checking the viewer from the browser console (find a beat, jump to it, play).
    (window as unknown as { botViewer: unknown }).botViewer = {
      beats: () => this.script.beats.map((b) => ({ i: b.index, kind: b.kind, room: b.room, round: b.round, phase: b.phase, bot: b.bot, start: b.start, dur: b.dur, types: b.events.map((e) => e.type) })),
      story: () => (this.timeline ? this.timeline.items.map((it, i) => ({ i, kind: it.kind, segment: it.segment, start: this.timeline?.starts[i], dur: it.dur })) : null),
      mode: (m?: Mode) => {
        if (m) this.setMode(m);
        return this.mode;
      },
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
    const keep = this.script && this.mode === 'full' ? beatAt(this.script, this.t) : null;
    const story = this.mode === 'story' ? this.story : null;
    // A story was timed with its own thoughts setting, so it always plays with it.
    const thoughts = story ? story.thoughts : this.thoughts;
    const heard = this.voices && this.voicesOn && this.voiceLengths ? this.voiceLengths : undefined;
    this.script = buildScript(this.game, { thoughts, ...(heard ? { voiceSeconds: heard } : {}) });
    this.transcript.build(this.game, this.script);
    this.transcript.setThoughts(thoughts !== 'off');
    if (story) {
      this.timeline = storyTimeline(story, this.script, this.game, heard, heard && this.narrationFits ? this.narrationFits : undefined);
      this.controls.buildStory(this.timeline, story, this.game);
      this.storyLayer.setStory(story);
    } else {
      this.timeline = null;
      this.controls.build(this.script, this.game);
      this.storyLayer.hide();
    }
    this.controls.setStoryMode(story !== null);
    for (const [m, b] of this.modeButtons) b.setAttribute('aria-pressed', String(m === this.mode));
    this.namesByBeat = this.computeNames();
    this.ghostsByBeat = this.computeGhosts();
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
      // A bot that remembers an earlier game starts with the name it brought.
      const names = startNames(this.game);
      const key = beatKey(b);
      for (const e of namings) {
        const k = keyOf(e);
        const at = beatOfEvent.get(e.id);
        if (k < key || (k === key && at !== undefined && at <= b.index)) names[e.from] = e.name;
      }
      return names;
    });
  }

  /** Bots exiled in a beat's room by then: they stay on screen as ghosts. */
  private computeGhosts(): Set<string>[] {
    const results = this.game.events.filter((e): e is Extract<GameEvent, { type: 'exile_result' }> => e.type === 'exile_result' && e.passed);
    const beatOfEvent = new Map<number, number>();
    for (const b of this.script.beats) for (const e of b.events) if (!beatOfEvent.has(e.id)) beatOfEvent.set(e.id, b.index);
    return this.script.beats.map((b) => {
      const ghosts = new Set<string>();
      for (const e of results) {
        if (e.levelIndex !== b.room) continue;
        const shown = beatOfEvent.get(e.id);
        // From the count's own announcement on; without one, from the round after.
        if ((shown !== undefined && b.index >= shown) || (shown === undefined && b.round > e.round) || b.kind === 'room-end') ghosts.add(e.target);
      }
      return ghosts;
    });
  }

  /** Switch between the story and the full game, staying near the same moment. */
  private setMode(mode: Mode): void {
    if (mode === this.mode || (mode === 'story' && !this.story)) return;
    const here = this.currentBeat();
    this.mode = mode;
    this.rebuild();
    if (mode === 'full') {
      const same = this.script.beats.find((b) => b.kind === here.beat.kind && b.room === here.beat.room && b.round === here.beat.round && b.phase === here.beat.phase && b.bot === here.beat.bot);
      this.t = same ? same.start + Math.min(here.local, same.dur * 0.99) : 0;
    } else if (this.timeline) {
      // The first story item at or after this moment.
      const at = here.beat;
      const i = this.timeline.items.findIndex((it) => this.itemBeat(it) >= at.index);
      this.storyT = i >= 0 ? (this.timeline.starts[i] as number) : 0;
    }
    this.jumped = true;
  }

  /** The beat a story item shows (or holds, or starts its fast-forward from). */
  private itemBeat(it: StoryItem): number {
    return it.kind === 'beat' ? it.beat : it.kind === 'card' ? it.hold.beat : (it.resolves[0] ?? it.hold.beat);
  }

  /** Where the playhead is, as a beat of the script, in either mode. */
  private currentBeat(): { beat: Beat; local: number; story: { index: number; item: StoryItem; local: number } | null } {
    if (this.mode === 'story' && this.timeline) {
      const at = storyItemAt(this.timeline, this.storyT);
      if (at) {
        const it = at.item;
        if (it.kind === 'beat') {
          const beat = this.script.beats[it.beat] as Beat;
          return { beat, local: Math.min(beat.dur, at.local), story: at };
        }
        const hold = it.kind === 'card' ? it.hold : zipPosition(it, at.local, this.script);
        return { beat: this.script.beats[hold.beat] as Beat, local: hold.local, story: at };
      }
    }
    return { ...beatAt(this.script, this.t), story: null };
  }

  // ------------------------------------------------------------ controls

  private get total(): number {
    return this.mode === 'story' && this.timeline ? this.timeline.total : this.script.total;
  }

  private get now(): number {
    return this.mode === 'story' && this.timeline ? this.storyT : this.t;
  }

  private togglePlay(): void {
    if (!this.playing && this.now >= this.total - 0.01) this.seek(0);
    this.playing = !this.playing;
  }

  private seek(t: number): void {
    const clamped = Math.max(0, Math.min(this.total, t));
    if (this.mode === 'story' && this.timeline) this.storyT = clamped;
    else this.t = clamped;
    this.jumped = true;
  }

  private step(dir: -1 | 1): void {
    if (this.mode === 'story' && this.timeline) {
      // Step by segment: a chapter, a narration, a quote, a whole chosen moment.
      const tl = this.timeline;
      const at = storyItemAt(tl, this.storyT);
      if (!at) return;
      const startOfSegment = (seg: number) => tl.starts[tl.items.findIndex((it) => it.segment === seg)] ?? 0;
      const here = startOfSegment(at.item.segment);
      if (dir < 0 && this.storyT - here > 0.6) return this.seek(here);
      const next = dir > 0 ? tl.items.find((it) => it.segment > at.item.segment) : [...tl.items].reverse().find((it) => it.segment < at.item.segment);
      if (next) this.seek(startOfSegment(next.segment));
      return;
    }
    const { beat, local } = beatAt(this.script, this.t);
    if (dir < 0 && local > 0.6) return this.seek(beat.start);
    const next = this.script.beats[beat.index + dir];
    if (next) this.seek(next.start);
  }

  private stepRound(dir: -1 | 1): void {
    if (this.mode === 'story') return this.step(dir);
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
    if (this.mode === 'full') this.rebuild();
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
      const next = this.now + dt * this.speed;
      if (next >= this.total) {
        this.seek(this.total);
        this.jumped = false;
        this.playing = false;
      } else if (this.mode === 'story' && this.timeline) {
        this.storyT = next;
      } else {
        this.t = next;
      }
    }
    const { beat, local, story: storyAt } = this.currentBeat();
    // A story card or a fast-forward has the screen: no bubbles, no phase banner.
    const cardUp = storyAt !== null && storyAt.item.kind !== 'beat';
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
    const speaker = beat.kind === 'turn' && !cardUp ? beat.bot : null;
    const link = cardUp ? undefined : beat.events.find((e) => e.type === 'whisper' || e.type === 'order');
    const listener = link && (link.type === 'whisper' || link.type === 'order') ? link.to : null;
    const ghosts = this.ghostsByBeat[beat.index] ?? new Set<string>();

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
      ghosts,
      auras: this.auras,
    });

    // Where each bot's head and feet are on screen, for the HTML on top.
    const tile = this.scene.space.tile;
    const anchors = new Map<string, Anchor>();
    const crates = new Set(room.level.crates.map((c) => c.id));
    for (const [id, b] of Object.entries(snap.bodies)) {
      if (crates.has(id) || ((b.look === 'exited' || snap.exited.has(id)) && !ghosts.has(id))) continue;
      const head = this.scene.toScreen(b.x + PHYS.botWidth / 2, b.y + heightOf(b.look));
      const feet = this.scene.toScreen(b.x + PHYS.botWidth / 2, b.y);
      anchors.set(id, { x: head.x, head: head.y - tile * 0.42, feet: feet.y });
    }
    const inRoom = this.game.bots.filter((id) => anchors.has(id));
    this.words.syncTags(this.game.bots, names);
    this.words.placeTags(anchors, new Set(speaker ? [speaker] : []));
    if (cardUp) this.words.clear();
    else this.words.showBeat(beat, this.game, room, names, this.mode === 'story' && this.story ? this.story.thoughts : this.thoughts);
    this.words.placeWords(anchors, rect.width, rect.height);
    const failing = new Map<string, string>();
    // Failure labels belong to the moves playing; over a held story card they would only clutter it.
    if (beat.kind === 'resolve' && beat.resolve && step !== null && !(storyAt?.item.kind === 'card')) {
      for (const r of beat.resolve.results) {
        if (r.status !== 'failed' && r.status !== 'cut') continue;
        const end = r.endStep - beat.resolve.trace.startStep;
        if (step >= end && step <= end + 110) failing.set(r.bot, `✕ ${shortReason(r.reason ?? (r.status === 'cut' ? 'ran out of time' : 'failed'))}`);
      }
    }
    this.words.placeResults(failing, anchors);
    void inRoom;

    if (cardUp) this.cards.hide();
    else this.cards.update(beat, this.game, names);
    if (storyAt && this.story) this.storyLayer.update(storyAt.index, storyAt.item, storyAt.local, this.story, this.game, names);
    this.cast.update(names, snap.coins, snap.exited, speaker, this.viewAs, room.kind === 'practice');
    this.transcript.highlight(beat.index);

    const roomText = `${room.name}`;
    if (this.roomLabel.textContent !== roomText) this.roomLabel.textContent = roomText;
    const roundText = beat.round > 0 && beat.kind !== 'room-end' ? `Round ${beat.round} of ${room.rounds}` : room.kind === 'practice' ? 'Practice room' : `Room ${room.index + 1} of ${this.game.rooms.length}`;
    if (this.roundLabel.textContent !== roundText) this.roundLabel.textContent = roundText;
    const phase = beat.kind === 'resolve' ? 'resolve' : beat.phase ?? '';
    // Beats outside the rounds: the room's start, the introductions (round 0), the host's payout and the room's end.
    const between = beat.kind === 'room-intro' ? 'Starting' : beat.kind === 'game-end' ? 'The end' : beat.round === 0 ? 'Introductions' : 'Room over';
    let phaseText = { declare: 'Plans', talk: 'Talk', commit: 'Commit', resolve: 'Moving', '': between }[phase] ?? '';
    let pillPhase: string = phase;
    if (cardUp && storyAt) {
      const it = storyAt.item;
      phaseText = it.kind === 'zip' ? 'Fast-forward' : it.kind === 'card' ? { chapter: 'Chapter', narrate: 'Narrator', quote: 'In their words' }[it.card] : phaseText;
      pillPhase = 'story';
    }
    if (this.phasePill.textContent !== phaseText) this.phasePill.textContent = phaseText;
    this.phasePill.dataset.phase = pillPhase;
    this.controls.update(this.now, this.playing, this.speed, this.mode === 'story' && this.story ? this.story.thoughts : this.thoughts, this.wiring, this.spectatorOn, this.voices ? this.voicesOn : null);

    // Voices: each new beat (or story card) queues its voiced lines; pausing or jumping silences them.
    if (this.voices) {
      if (!this.playing || this.jumped || !this.voicesOn) {
        this.voices.stop();
        this.voicedKey = '';
      } else {
        const key = storyAt ? `s${storyAt.index}` : `b${beat.index}`;
        if (key !== this.voicedKey) {
          this.voicedKey = key;
          const item = storyAt?.item;
          const fits = this.narrationFits ?? new Map<number, number>();
          if (item?.kind === 'card') {
            // A quote card: its own words in the bot's voice (or, from older voicing, the whole line); a chapter
            // or a narration: the narrator.
            const played = this.voices.playSegment(item.segment, fits, this.speed);
            if (!played && item.card === 'quote' && item.eventId !== null) this.voices.play([item.eventId], this.speed);
          } else if (item?.kind === 'zip') {
            this.voices.playSegment(item.segment, fits, this.speed);
          } else if (!cardUp) {
            // A shown moment: the narrator says its caption as it starts, then the bots speak.
            const prev = storyAt && this.timeline ? this.timeline.items[storyAt.index - 1] : undefined;
            if (item && (!prev || prev.segment !== item.segment)) this.voices.playSegment(item.segment, fits, this.speed);
            this.voices.play(beat.events.map((e) => e.id), this.speed);
          }
        }
      }
    }

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
    // The Director's story, if it has made one (npm run direct). Without one, the full game plays.
    const storyRes = await fetch(`/api/runs/${encodeURIComponent(run)}/story.json`);
    const story = storyRes.ok ? ((await storyRes.json()) as Story) : null;
    const startMode: Mode = new URLSearchParams(location.search).get('mode') === 'full' ? 'full' : 'story';
    // The bots' voices, if the game has been voiced (npm run voice).
    const voiceRes = await fetch(`/api/runs/${encodeURIComponent(run)}/voice/index.json`);
    const voices = voiceRes.ok ? ((await voiceRes.json()) as VoiceManifest) : null;
    await document.fonts.ready;
    new Player(app, game, run, story, startMode, voices);
  } catch (err) {
    app.replaceChildren(el('div', 'error', (err as Error).message));
  }
}

void start();
