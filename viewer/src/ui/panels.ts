/**
 * The panels around the stage: the cast, the playback controls and
 * timeline, the big room cards, and the spectator panel.
 */
import type { BotStats } from '../../../engine/stats';
import { STAT_NAMES } from '../../../engine/stats';
import type { GameData, RoomData } from '../data';
import { botLook } from '../palette';
import { drawBot } from '../render/bots';
import type { Beat, Script, ThoughtMode } from '../script';
import type { Story, StoryTimeline } from '../story';
import { botVars, dot, el, ICON, nameOf } from './dom';

// ------------------------------------------------------------ the cast

export class Cast {
  private readonly cards = new Map<string, { node: HTMLButtonElement; name: HTMLElement; coins: HTMLElement; status: HTMLElement }>();

  constructor(root: HTMLElement, game: GameData, onPick: (bot: string) => void) {
    for (const seat of [...game.seats].sort((a, b) => a.bot.localeCompare(b.bot))) {
      const node = el('button', 'card');
      node.title = `Click to see what ${seat.bot} could see`;
      botVars(node, seat.bot);
      const canvas = el('canvas');
      paintAvatar(canvas, seat.bot);
      const names = el('div', 'names');
      const name = el('div', 'name', `Bot ${seat.bot}`);
      names.append(name, el('div', 'model', prettyModel(seat.model)));
      const meta = el('div', 'meta');
      const coins = el('div', 'coins', '0');
      const status = el('div', 'status', '');
      meta.append(coins, status);
      node.append(canvas, names, meta);
      node.addEventListener('click', () => onPick(seat.bot));
      root.append(node);
      this.cards.set(seat.bot, { node, name, coins, status });
    }
  }

  update(names: Readonly<Record<string, string | null>>, coins: Readonly<Record<string, number>>, out: ReadonlySet<string>, speaker: string | null, viewAs: string | null, practice: boolean): void {
    for (const [bot, c] of this.cards) {
      const n = nameOf(bot, names);
      if (c.name.textContent !== n) c.name.textContent = n;
      const coin = String(coins[bot] ?? 0);
      if (c.coins.textContent !== coin) c.coins.textContent = coin;
      c.coins.title = practice ? 'Coins picked up in this room (practice: they don’t count)' : 'Coins picked up in this room';
      const status = out.has(bot) ? '✓ out' : '';
      if (c.status.textContent !== status) c.status.textContent = status;
      c.node.dataset.out = String(out.has(bot));
      c.node.dataset.speaking = String(speaker === bot);
      c.node.dataset.viewing = String(viewAs === bot);
    }
  }
}

function prettyModel(model: string): string {
  if (model === 'mock') return 'mock player (free)';
  if (model === 'scripted') return 'follows the level script';
  if (model === 'replay') return 'replayed';
  return model.replace(/^[^/]+\//, '').replace(/-/g, ' ');
}

/** A still picture of the bot, drawn by the same code as the stage. */
export function paintAvatar(canvas: HTMLCanvasElement, bot: string): void {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = 34;
  const h = 46;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const t = 24;
  drawBot(ctx, { X: (x) => x * t, Y: (y) => h - 3 - y * t, t }, {
    id: bot,
    look: botLook(bot),
    x: (w / t - 0.75) / 2,
    y: 0,
    w: 0.75,
    h: 1.5,
    vx: 0,
    vy: 0,
    anim: 'still',
    facing: 1,
    squash: 0,
    opacity: 1,
    highlight: 0,
    happy: 0,
    time: 0.5,
  });
}

// ------------------------------------------------------------ controls and the timeline

export interface ControlHandlers {
  toggle(): void;
  seek(t: number): void;
  step(dir: -1 | 1): void;
  speed(v: number): void;
  thoughts(mode: ThoughtMode): void;
  wiring(on: boolean): void;
  spectator(): void;
  voices(on: boolean): void;
}

export const SPEEDS = [0.5, 1, 1.5, 2, 4] as const;

export class Controls {
  private readonly play: HTMLButtonElement;
  private readonly scrub: HTMLElement;
  private readonly fill: HTMLElement;
  private readonly head: HTMLElement;
  private readonly time: HTMLElement;
  private readonly speedBtns = new Map<number, HTMLButtonElement>();
  private readonly thoughtBtn: HTMLButtonElement;
  private readonly wireBtn: HTMLButtonElement;
  private readonly specBtn: HTMLButtonElement;
  private readonly voiceBtn: HTMLButtonElement;
  private total = 1;

  constructor(root: HTMLElement, private readonly on: ControlHandlers) {
    const back = iconButton(ICON.back, 'Previous moment (←)');
    back.addEventListener('click', () => on.step(-1));
    this.play = iconButton(ICON.play, 'Play / pause (space)');
    this.play.classList.add('play');
    this.play.addEventListener('click', () => on.toggle());
    const fwd = iconButton(ICON.forward, 'Next moment (→)');
    fwd.addEventListener('click', () => on.step(1));

    this.scrub = el('div', 'scrub');
    const track = el('div', 'track');
    this.fill = el('div', 'fill');
    track.append(this.fill);
    this.head = el('div', 'head');
    this.scrub.append(track, this.head);
    const seekAt = (ev: PointerEvent) => {
      const r = this.scrub.getBoundingClientRect();
      on.seek(Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)) * this.total);
    };
    this.scrub.addEventListener('pointerdown', (ev) => {
      this.scrub.setPointerCapture(ev.pointerId);
      seekAt(ev);
    });
    this.scrub.addEventListener('pointermove', (ev) => {
      if (this.scrub.hasPointerCapture(ev.pointerId)) seekAt(ev);
    });

    this.time = el('div', 'time', '0:00 / 0:00');
    const speeds = el('div', 'segmented');
    for (const s of SPEEDS) {
      const b = el('button', '', `${s}×`);
      b.addEventListener('click', () => on.speed(s));
      speeds.append(b);
      this.speedBtns.set(s, b);
    }
    const toggles = el('div', 'toggles');
    this.thoughtBtn = el('button', 'toggle', 'Thoughts');
    this.thoughtBtn.title = 'Private thoughts: off, at commit only, or always';
    this.thoughtBtn.addEventListener('click', () => {
      const next: Record<ThoughtMode, ThoughtMode> = { off: 'commit', commit: 'all', all: 'off' };
      on.thoughts(next[(this.thoughtBtn.dataset.mode as ThoughtMode | undefined) ?? 'commit']);
    });
    this.wireBtn = el('button', 'toggle', 'Wiring');
    this.wireBtn.title = 'Show which plates and levers open which doors';
    this.wireBtn.addEventListener('click', () => on.wiring(this.wireBtn.getAttribute('aria-pressed') !== 'true'));
    this.specBtn = el('button', 'toggle', 'Spectator');
    this.specBtn.title = 'Hidden stats, and seeing through one bot’s eyes';
    this.specBtn.addEventListener('click', () => on.spectator());
    // Only for games that have been voiced (npm run voice).
    this.voiceBtn = el('button', 'toggle', 'Voices');
    this.voiceBtn.title = 'The bots’ voices, made on this machine by Kokoro (npm run voice)';
    this.voiceBtn.hidden = true;
    this.voiceBtn.addEventListener('click', () => on.voices(this.voiceBtn.getAttribute('aria-pressed') !== 'true'));
    toggles.append(this.thoughtBtn, this.wireBtn, this.specBtn, this.voiceBtn);
    root.append(back, this.play, fwd, this.scrub, this.time, speeds, toggles);
  }

  /** Room segments, round ticks, and a dot wherever a bot named itself. */
  build(script: Script, game: GameData): void {
    this.total = Math.max(0.001, script.total);
    const track = this.scrub.querySelector('.track') as HTMLElement;
    track.querySelectorAll('.seg').forEach((n) => n.remove());
    this.scrub.querySelectorAll('.tick, .mark, .roomlabel').forEach((n) => n.remove());
    for (const room of game.rooms) {
      const beats = script.beats.filter((b) => b.room === room.index);
      const first = beats[0];
      const last = beats.at(-1);
      if (!first || !last) continue;
      const seg = el('div', 'seg');
      seg.style.left = `${(first.start / this.total) * 100}%`;
      seg.style.width = `${((last.start + last.dur - first.start) / this.total) * 100}%`;
      track.prepend(seg);
      const label = el('div', 'roomlabel', room.kind === 'practice' ? 'Practice' : room.name);
      label.style.left = `calc(${(first.start / this.total) * 100}% + 4px)`;
      label.style.maxWidth = `calc(${((last.start + last.dur - first.start) / this.total) * 100}% - 8px)`;
      this.scrub.append(label);
      let lastRound = 0;
      for (const b of beats) {
        if (b.round > lastRound && b.kind === 'phase') {
          lastRound = b.round;
          const tick = el('div', 'tick');
          tick.style.left = `${(b.start / this.total) * 100}%`;
          this.scrub.append(tick);
        }
        if (b.kind === 'turn' && b.events.some((e) => e.type === 'name') && b.bot) {
          const mark = el('div', 'mark');
          botVars(mark, b.bot);
          mark.title = `${b.bot} names itself`;
          mark.style.left = `${((b.start + b.dur / 2) / this.total) * 100}%`;
          this.scrub.append(mark);
        }
      }
    }
  }

  /** Story mode's timeline: one band per chapter, a tick where each segment starts, and a dot for each quote. */
  buildStory(timeline: StoryTimeline, story: Story, game: GameData): void {
    this.total = Math.max(0.001, timeline.total);
    const track = this.scrub.querySelector('.track') as HTMLElement;
    track.querySelectorAll('.seg').forEach((n) => n.remove());
    this.scrub.querySelectorAll('.tick, .mark, .roomlabel').forEach((n) => n.remove());
    const startOf = (segment: number) => {
      const i = timeline.items.findIndex((it) => it.segment >= segment);
      return i < 0 ? timeline.total : (timeline.starts[i] as number);
    };
    const chapters = story.segments.map((s, i) => ({ s, i })).filter((x) => x.s.type === 'chapter');
    chapters.forEach(({ s, i }, n) => {
      const from = startOf(i);
      const to = n + 1 < chapters.length ? startOf((chapters[n + 1] as { i: number }).i) : timeline.total;
      const seg = el('div', 'seg');
      seg.style.left = `${(from / this.total) * 100}%`;
      seg.style.width = `${((to - from) / this.total) * 100}%`;
      track.prepend(seg);
      const label = el('div', 'roomlabel', s.type === 'chapter' ? s.title : '');
      label.style.left = `calc(${(from / this.total) * 100}% + 4px)`;
      label.style.maxWidth = `calc(${((to - from) / this.total) * 100}% - 8px)`;
      this.scrub.append(label);
    });
    let last = -1;
    timeline.items.forEach((it, i) => {
      if (it.segment === last) return;
      last = it.segment;
      const at = ((timeline.starts[i] as number) / this.total) * 100;
      if (it.kind === 'card' && it.card === 'quote' && it.eventId !== null) {
        const e = game.events.find((x) => x.id === it.eventId);
        if (e && 'from' in e && typeof e.from === 'string') {
          const mark = el('div', 'mark');
          botVars(mark, e.from);
          mark.title = `${e.from}, in its own words`;
          mark.style.left = `${at}%`;
          this.scrub.append(mark);
        }
      } else if (it.kind === 'beat' || it.kind === 'zip') {
        const tick = el('div', 'tick');
        tick.style.left = `${at}%`;
        this.scrub.append(tick);
      }
    });
  }

  /** In Story mode the story decides which thoughts are shown (it was timed with them). */
  setStoryMode(on: boolean): void {
    this.thoughtBtn.disabled = on;
    this.thoughtBtn.title = on ? 'A story shows every private thought: switch to the full game to choose' : 'Private thoughts: off, at commit only, or always';
  }

  update(t: number, playing: boolean, speed: number, thoughts: ThoughtMode, wiring: boolean, spectator: boolean, voices: boolean | null = null): void {
    // null: this game has no voices, so no switch for them.
    this.voiceBtn.hidden = voices === null;
    this.voiceBtn.setAttribute('aria-pressed', String(voices === true));
    const pct = `${(t / this.total) * 100}%`;
    this.fill.style.width = pct;
    this.head.style.left = pct;
    const label = `${clock(t)} / ${clock(this.total)}`;
    if (this.time.textContent !== label) this.time.textContent = label;
    const icon = playing ? ICON.pause : ICON.play;
    if (this.play.dataset.icon !== String(playing)) {
      this.play.innerHTML = icon;
      this.play.dataset.icon = String(playing);
    }
    for (const [s, b] of this.speedBtns) b.setAttribute('aria-pressed', String(s === speed));
    this.thoughtBtn.dataset.mode = thoughts;
    this.thoughtBtn.setAttribute('aria-pressed', String(thoughts !== 'off'));
    const thoughtLabel = thoughts === 'off' ? 'Thoughts: off' : thoughts === 'commit' ? 'Thoughts: at commit' : 'Thoughts: all';
    if (this.thoughtBtn.textContent !== thoughtLabel) this.thoughtBtn.textContent = thoughtLabel;
    this.wireBtn.setAttribute('aria-pressed', String(wiring));
    this.specBtn.setAttribute('aria-pressed', String(spectator));
  }
}

function iconButton(svg: string, title: string): HTMLButtonElement {
  const b = el('button', 'iconbtn');
  b.innerHTML = svg;
  b.title = title;
  b.setAttribute('aria-label', title);
  return b;
}

function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ------------------------------------------------------------ big cards and the phase banner

export class Cards {
  private readonly card: HTMLElement;
  private readonly inner: HTMLElement;
  private readonly banner: HTMLElement;
  private readonly notice: HTMLElement;
  private shownFor = -1;
  private noticeFor = -1;

  constructor(root: HTMLElement) {
    this.banner = el('div', 'banner');
    this.banner.dataset.show = 'false';
    this.card = el('div', 'bigcard');
    this.card.dataset.show = 'false';
    this.inner = el('div', 'inner');
    this.card.append(this.inner);
    this.notice = el('div', 'announce');
    this.notice.dataset.show = 'false';
    root.append(this.banner, this.card, this.notice);
  }

  /** Nothing of the full game's furniture: a story card has the screen. */
  hide(): void {
    this.card.dataset.show = 'false';
    this.banner.dataset.show = 'false';
    this.notice.dataset.show = 'false';
  }

  update(beat: Beat, game: GameData, names: Readonly<Record<string, string | null>>): void {
    const isCard = beat.kind === 'room-intro' || beat.kind === 'room-end' || beat.kind === 'game-end';
    this.card.dataset.show = String(isCard);
    if (isCard && this.shownFor !== beat.index) {
      this.shownFor = beat.index;
      this.fill(beat, game, names);
    }
    this.notice.dataset.show = String(beat.kind === 'announce');
    if (beat.kind === 'announce' && this.noticeFor !== beat.index) {
      this.noticeFor = beat.index;
      this.announce(beat, names);
    }
    if (beat.kind === 'phase' && beat.phase) {
      const words = { declare: 'Plans', talk: 'Talk', commit: 'Secret commitments' }[beat.phase];
      this.banner.innerHTML = `Round ${beat.round} · <b>${words}</b>`;
      this.banner.dataset.show = 'true';
    } else if (beat.kind === 'resolve') {
      this.banner.innerHTML = `Round ${beat.round} · <b>Everyone moves at once</b>`;
      this.banner.dataset.show = 'true';
    } else {
      this.banner.dataset.show = 'false';
    }
  }

  private fill(beat: Beat, game: GameData, names: Readonly<Record<string, string | null>>): void {
    const room = game.rooms[beat.room] as RoomData;
    this.inner.replaceChildren();
    const faces = (ids: readonly string[], dim: ReadonlySet<string> = new Set()) => {
      const f = el('div', 'faces');
      for (const id of ids) {
        const chip = el('span', 'face');
        botVars(chip, id);
        chip.dataset.dim = String(dim.has(id));
        chip.append(dot(id), document.createTextNode(nameOf(id, names)));
        f.append(chip);
      }
      return f;
    };
    if (beat.kind === 'room-intro') {
      this.inner.append(
        el('div', 'kicker', `Room ${room.index + 1} of ${game.rooms.length}${room.kind === 'practice' ? ' · Practice' : ''}`),
        el('h1', '', room.name),
        el('p', '', room.description),
        el('div', 'goal', room.kind === 'practice' ? `${room.rounds} rounds to explore. Nothing here counts.` : `${room.goal} of ${game.bots.length} must get out · up to ${room.rounds} rounds`),
      );
    } else if (beat.kind === 'room-end' && room.end) {
      const through = new Set(room.end.through);
      this.inner.append(
        el('div', 'kicker', `Room ${room.index + 1} · over`),
        el('h1', '', room.kind === 'practice' ? 'Practice over' : room.end.goalMet ? 'They got out' : 'Time ran out'),
        el('p', '', `It ended because ${room.end.reason}.`),
        faces(game.bots, new Set(game.bots.filter((b) => !through.has(b)))),
      );
      // The running scoreboard (games with the social systems): coins in the purse plus points for getting out.
      const board = room.closingEvents.find((e) => e.type === 'scores');
      if (board?.type === 'scores' && room.kind !== 'practice') {
        const rows = Object.entries(board.scores).sort((a, b) => b[1].total - a[1].total);
        const p = el('p', 'scoreline');
        p.textContent = rows.map(([b, s]) => `${nameOf(b, names)} ${s.total}`).join(' · ');
        this.inner.append(p);
      }
    } else if (beat.kind === 'game-end') {
      const scores = game.end?.scores ?? {};
      const team = game.end?.team;
      this.inner.append(el('div', 'kicker', 'The end'), el('h1', '', 'Final scores'));
      const p = el('p');
      p.textContent = [...game.bots]
        .sort((a, b) => (scores[b]?.total ?? scores[b]?.coins ?? 0) - (scores[a]?.total ?? scores[a]?.coins ?? 0))
        .map((b) => {
          const s = scores[b];
          return s?.total !== undefined ? `${nameOf(b, names)}: ${s.total} points (${s.coins} coins, ${s.exitPoints ?? 0} for getting out)` : `${nameOf(b, names)}: ${s?.coins ?? 0} coins, ${s?.roomsEscaped ?? 0} rooms`;
        })
        .join(' · ');
      this.inner.append(p);
      if (team && game.social) this.inner.append(el('div', 'goal', `Rooms the team completed: ${team.roomsCompleted}, so every score is ×${(1 + game.social.teamBonusPerRoom * team.roomsCompleted).toFixed(1)}`));
      this.inner.append(faces(game.bots));
    }
  }

  /** A public outcome everyone learns at once: a rule passing or failing, an exile vote counted. */
  private announce(beat: Beat, names: Readonly<Record<string, string | null>>): void {
    const e = beat.events[0];
    this.notice.replaceChildren();
    if (e?.type === 'rule') {
      const passed = e.action === 'passed';
      this.notice.dataset.tone = passed ? 'good' : 'muted';
      const what = e.kind === 'repeal' ? 'Repeal' : e.kind === 'threshold' ? 'New threshold' : 'Rule';
      this.notice.append(
        el('div', 'kicker', `The constitution · ${e.id}`),
        el('div', 'title', `${what} ${passed ? 'passes' : 'fails'}`),
        el('p', '', `“${e.text}”`),
        el('div', 'count', `${e.yes} yes · ${e.no} no · ${e.needed} needed · proposed by ${nameOf(e.by, names)}`),
      );
    } else if (e?.type === 'host') {
      // The host: the one voice in the game allowed opinions (prompts/host.ts).
      this.notice.dataset.tone = 'host';
      const title = { question: 'A question for everyone', praise: 'Praise', bounty: 'An offer', payout: 'Paid as promised' }[e.kind];
      this.notice.append(el('div', 'kicker', 'The host'), el('div', 'title', e.kind === 'payout' && e.bots.length === 0 ? 'Nobody earned it' : title), el('p', '', `“${e.text}”`));
    } else if (e?.type === 'exile_result') {
      this.notice.dataset.tone = e.passed ? 'bad' : 'muted';
      this.notice.append(
        el('div', 'kicker', `Exile vote on ${nameOf(e.target, names)}`),
        el('div', 'title', e.passed ? `${nameOf(e.target, names)} is exiled` : `${nameOf(e.target, names)} stays`),
        el('p', '', e.passed ? 'A ghost now: it can still talk, but it can’t act, and it scores nothing in this room.' : 'Not enough secret ballots said yes.'),
        el('div', 'count', `${e.yes} yes · ${e.no} no · ${e.needed} needed · called by ${nameOf(e.by, names)}`),
      );
    }
  }
}

// ------------------------------------------------------------ the spectator panel

export class Spectator {
  readonly node: HTMLElement;

  constructor(root: HTMLElement, game: GameData, onViewAs: (bot: string | null) => void) {
    this.node = el('div', 'spectator');
    this.node.dataset.show = 'false';
    this.node.append(el('h5', '', 'Hidden stats'), el('p', '', 'Each bot’s secret difference from the rulebook’s standard bot. No bot is told; they can only find out from what happens.'));
    const table = el('table');
    const short: Record<string, string> = { runSpeed: 'Run', jumpHeight: 'Jump ↑', jumpDistance: 'Jump →', weight: 'Weight', strength: 'Strength', sightRange: 'Sight' };
    const head = el('tr');
    head.append(el('th', '', 'Bot'), ...STAT_NAMES.map((n) => el('th', '', short[n] ?? n)));
    if (game.guard) head.append(el('th', '', 'Guard'));
    table.append(head);
    for (const bot of game.bots) {
      const tr = el('tr');
      const first = el('td');
      first.append(dot(bot));
      tr.append(first);
      const s = game.stats[bot] as BotStats | undefined;
      for (const n of STAT_NAMES) {
        const v = s ? (s[n] - 1000) / 10 : 0;
        const td = el('td', v > 0.5 ? 'up' : v < -0.5 ? 'down' : '', `${v > 0 ? '+' : ''}${v.toFixed(1)}%`);
        tr.append(td);
      }
      // Rounds this bot takes to relax after seeing an attack (it is told its own; nobody else's).
      if (game.guard) tr.append(el('td', '', `${game.guard[bot] ?? '?'} rd`));
      table.append(tr);
    }
    const personas = game.seats.filter((s) => s.persona && s.colour);
    if (personas.length > 0) {
      const h = el('h5', '', 'Personalities');
      h.style.marginTop = '14px';
      const note = el('p', '', 'Each bot knows only its own. Its colour (its eyes) follows from boldness, warmth and honesty by a rule no bot is told.');
      const pt = el('table');
      const ph = el('tr');
      ph.append(el('th', '', 'Bot'), ...['Bold', 'Warm', 'Honest', 'Curious', 'Patient', 'Colour'].map((x) => el('th', '', x)));
      pt.append(ph);
      for (const s of personas) {
        const tr = el('tr');
        const first = el('td');
        first.append(dot(s.bot));
        tr.append(first);
        for (const t of ['boldness', 'warmth', 'honesty', 'curiosity', 'patience']) tr.append(el('td', '', String(s.persona?.traits[t] ?? '?')));
        const c = el('td', 'colour');
        const sw = el('span', 'swatch');
        sw.style.background = s.colour?.hex ?? 'transparent';
        c.append(sw, document.createTextNode(` ${s.colour?.name ?? ''}`));
        tr.append(c);
        pt.append(tr);
      }
      this.node.append(h, note, pt);
    }
    const view = el('div', 'toggles');
    view.style.marginTop = '12px';
    view.style.flexWrap = 'wrap';
    const label = el('h5', '', 'See through one bot’s eyes');
    label.style.marginTop = '14px';
    const none = el('button', 'toggle', 'Everyone');
    none.addEventListener('click', () => onViewAs(null));
    view.append(none);
    for (const bot of game.bots) {
      const b = el('button', 'toggle');
      botVars(b, bot);
      b.append(dot(bot));
      b.addEventListener('click', () => onViewAs(bot));
      view.append(b);
    }
    this.node.append(table, label, view);
    root.append(this.node);
  }

  set shown(on: boolean) {
    this.node.dataset.show = String(on);
  }
}
