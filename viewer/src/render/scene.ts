/**
 * The scene: everything on the canvas, one frame at a time.
 *
 * Layers, back to front: sky and stars, terrain (cached), wiring (optional),
 * switches and the exit, coins, crates, bots, effects, then two overlays:
 * "view as" shading (what one bot can't see) and the spotlight on whoever is
 * talking. Switches ease between states; on a seek they snap, and effects
 * are cleared, so scrubbing never leaves stray dust behind.
 */
import { PHYS, UNITS_PER_TILE as T } from '../../../engine/constants';
import { visibleTiles } from '../../../engine/sight';
import type { BotStats } from '../../../engine/stats';
import { physicsFor } from '../../../engine/stats';
import type { Bot, World } from '../../../engine/world';
import type { ResolveData, RoomData } from '../data';
import { botLook, THEME, WIRE_COLOURS } from '../palette';
import type { Snapshot } from '../state';
import { heightOf } from '../state';
import type { Frame } from './backdrop';
import { drawStars, renderSky, renderTerrain } from './backdrop';
import { drawBot } from './bots';
import type { Ctx } from './draw';
import { alpha, approach, hashOf } from './draw';
import type { Space } from './things';
import { drawCoin, drawCrate, drawDoor, drawExit, drawLever, drawPlate } from './things';

export interface SceneInput {
  room: RoomData;
  snap: Snapshot;
  /** The resolve playing now, if any (for coin pops and happy eyes). */
  resolve: ResolveData | null;
  /** Seconds since the page opened: drives idle motion (coins bobbing, blinking). */
  time: number;
  /** Real seconds since the last frame. */
  dt: number;
  /** The playhead jumped (a seek): snap switches, drop effects. */
  jumped: boolean;
  /** The previous frame's step in this same resolve, so effects fire for everything passed since. */
  prevStep: number | null;
  speaker: string | null;
  listener: string | null;
  viewAs: string | null;
  wiring: boolean;
  stats: Record<string, BotStats>;
  /** Bots exiled from this room: out of the physics, but still here, faint, and still talking. */
  ghosts: ReadonlySet<string>;
  /** Each bot's personality colour, for its eyes (games with personas). */
  auras?: Readonly<Record<string, string>>;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  colour: string;
  text?: string;
}

export class Scene {
  /** This frame's ghosts (see SceneInput.ghosts). */
  private ghosts: ReadonlySet<string> = new Set();
  private readonly ctx: Ctx;
  private dpr = 1;
  private cssW = 0;
  private cssH = 0;
  private frame: Frame = { tile: 1, x: 0, y: 0, w: 0, h: 0 };
  private sky: HTMLCanvasElement | null = null;
  private terrain: HTMLCanvasElement | null = null;
  private terrainKey = '';
  private roomId = '';
  private readonly shown = new Map<string, number>();
  private readonly facing = new Map<string, 1 | -1>();
  private particles: Particle[] = [];
  private spot = { x: 0, y: 0, a: 0, id: '' };
  private sightKey = '';
  private sightCanvas: HTMLCanvasElement | null = null;
  private wires = new Map<string, string>();
  /** For inspecting details: draw this many times larger, centred on a tile (?zoom=3&focus=5,3). */
  debugView: { zoom: number; cx: number; cy: number } | null = null;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d') as Ctx;
  }

  resize(cssW: number, cssH: number): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (cssW === this.cssW && cssH === this.cssH && dpr === this.dpr) return;
    this.cssW = cssW;
    this.cssH = cssH;
    this.dpr = dpr;
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    this.terrainKey = '';
  }

  /** The level's rectangle on the canvas, and pixels per tile. */
  get space(): Frame {
    return this.frame;
  }

  /** Where a point in engine units is on the canvas, in CSS pixels. */
  toScreen(xUnits: number, yUnits: number): { x: number; y: number } {
    const f = this.frame;
    return { x: f.x + (xUnits / T) * f.tile, y: f.y + f.h - (yUnits / T) * f.tile };
  }

  private layout(room: RoomData): void {
    const { width, height } = room.level;
    const pad = 14;
    const fit = Math.max(4, Math.min((this.cssW - pad * 2) / width, (this.cssH - pad * 2) / height));
    const dv = this.debugView;
    const tile = dv ? fit * dv.zoom : fit;
    const w = tile * width;
    const h = tile * height;
    this.frame = dv
      ? { tile, x: Math.round(this.cssW / 2 - dv.cx * tile), y: Math.round(this.cssH / 2 - (height - dv.cy) * tile), w, h }
      : { tile, x: Math.round((this.cssW - w) / 2), y: Math.round((this.cssH - h) / 2), w, h };
    const key = `${room.id}|${this.cssW}x${this.cssH}@${this.dpr}|${dv ? `${dv.zoom},${dv.cx},${dv.cy}` : ''}`;
    if (key !== this.terrainKey) {
      this.terrainKey = key;
      this.sky = renderSky(this.cssW, this.cssH, this.frame, this.dpr);
      this.terrain = renderTerrain(room.level, this.frame, this.dpr);
      this.sightKey = '';
    }
    if (room.id !== this.roomId) {
      this.roomId = room.id;
      this.shown.clear();
      this.particles = [];
      // Each door gets a colour; the plates and levers that open it share it.
      this.wires = new Map();
      room.level.doors.forEach((d, i) => {
        const c = WIRE_COLOURS[i % WIRE_COLOURS.length] as string;
        this.wires.set(d.id, c);
        for (const id of d.openWhen) if (!this.wires.has(id)) this.wires.set(id, c);
      });
    }
  }

  private ease(key: string, target: number, dt: number, snap: boolean, rate = 9): number {
    const now = this.shown.get(key);
    const next = now === undefined || snap ? target : approach(now, target, dt, rate);
    this.shown.set(key, next);
    return next;
  }

  draw(input: SceneInput): void {
    const { room, snap, dt, time } = input;
    this.layout(room);
    const ctx = this.ctx;
    const f = this.frame;
    const H = room.level.height;
    const space: Space = { X: (tx) => f.x + tx * f.tile, Y: (ty) => f.y + (H - ty) * f.tile, t: f.tile };
    const jumped = input.jumped;
    this.ghosts = input.ghosts;
    if (jumped) this.particles = [];
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    // Sky, stars, terrain.
    if (this.sky) ctx.drawImage(this.sky, 0, 0, this.cssW, this.cssH);
    drawStars(ctx, f, time);
    if (this.terrain) ctx.drawImage(this.terrain, f.x, f.y, f.w, f.h);

    // Wiring: dotted lines from each plate or lever to the door it opens.
    if (input.wiring) this.drawWiring(ctx, room, space, time);

    // Switches and the exit.
    const accent = (id: string) => this.wires.get(id) ?? '#9aa5c4';
    for (const p of room.level.plates) drawPlate(ctx, space, p, this.ease(`p:${p.id}`, snap.switches.plates[p.id] ? 1 : 0, dt, jumped, 14), accent(p.id));
    for (const l of room.level.levers) drawLever(ctx, space, l, this.ease(`l:${l.id}`, snap.switches.levers[l.id] ? 1 : 0, dt, jumped, 12), accent(l.id));
    for (const d of room.level.doors) drawDoor(ctx, space, d, this.ease(`d:${d.id}`, snap.switches.doors[d.id] ? 1 : 0, dt, jumped, 7), accent(d.id));
    const used = [...snap.exited].length;
    for (const e of room.level.exits) drawExit(ctx, space, e, Math.max(0, e.slots - (room.level.exits.length === 1 ? used : 0)), time);
    room.level.coins.forEach((c, i) => {
      if (snap.switches.coins.includes(c.id)) drawCoin(ctx, space, c, time, hashOf(c.id) + i);
    });

    // Crates.
    for (const c of room.level.crates) {
      const b = snap.bodies[c.id];
      if (b) drawCrate(ctx, space, b.x / T, b.y / T, c.weight > 1000);
    }

    // Effects for whatever happened since the last frame (only when playing forward, not after a seek).
    const step = snap.step;
    if (!jumped && step !== null && input.prevStep !== null && step > input.prevStep) this.spawnEffects(input, space, input.prevStep, step);

    // Bots, lowest first, so a bot standing on another's head is drawn in front.
    const botIds = Object.keys(snap.bodies).filter((id) => !room.level.crates.some((c) => c.id === id));
    botIds.sort((a, b) => (snap.bodies[a]?.y ?? 0) - (snap.bodies[b]?.y ?? 0) || a.localeCompare(b));
    const speakerGlow = this.ease('speaker', input.speaker ? 1 : 0, dt, jumped, 8);
    for (const id of botIds) {
      const b = snap.bodies[id];
      if (!b) continue;
      const track = snap.tracks?.get(id) ?? null;
      let opacity = 1;
      const ghost = input.ghosts.has(id);
      if (ghost) {
        opacity = 0.34;
      } else if (b.look === 'exited') {
        if (step === null || !track || track.exitStep === null) continue;
        opacity = Math.max(0, 1 - (step - track.exitStep) / 22);
        if (opacity <= 0) continue;
      }
      if (Math.abs(b.vx) > 20) this.facing.set(id, b.vx > 0 ? 1 : -1);
      const since = track && step !== null ? track.since(track.landings, step) : Infinity;
      const coinSince = this.coinSince(input, id);
      drawBot(ctx, space, {
        id,
        look: botLook(id),
        x: b.x / T,
        // A ghost hovers a little above the floor; a bot leaving through the exit rises as it fades.
        y: b.y / T + (ghost ? 0.12 + Math.sin(time * 1.6 + id.charCodeAt(0)) * 0.05 : b.look === 'exited' ? (1 - opacity) * 0.6 : 0),
        w: PHYS.botWidth / T,
        // A crouched bot is half as tall (engine: crouch).
        h: heightOf(b.look) / T,
        vx: (b.vx / T) * 60,
        vy: (b.vy / T) * 60,
        anim: ghost ? 'idle' : b.look,
        facing: this.facing.get(id) ?? 1,
        squash: since < 9 ? 1 - since / 9 : 0,
        opacity,
        highlight: input.speaker === id ? speakerGlow : 0,
        happy: !ghost && (coinSince < 50 || b.look === 'exited') ? 1 : 0,
        aura: input.auras?.[id] ?? null,
        time,
      });
    }
    if (input.listener && input.speaker) this.drawListenerRing(ctx, space, snap, input.listener, time);

    this.drawParticles(ctx, dt);
    if (input.viewAs) this.drawSight(ctx, room, snap, input.viewAs, input.stats);
    this.drawSpotlight(ctx, snap, input.speaker, dt, jumped);
  }

  /** Steps since this bot last picked up a coin in the resolve playing now (Infinity if it hasn't). */
  private coinSince(input: SceneInput, bot: string): number {
    const step = input.snap.step;
    const r = input.resolve;
    if (step === null || !r) return Infinity;
    let best = Infinity;
    for (const e of r.events) {
      if (e.type !== 'coin' || e.bot !== bot) continue;
      const local = e.step - r.trace.startStep;
      if (local <= step) best = Math.min(best, step - local);
    }
    return best;
  }

  private spawnEffects(input: SceneInput, space: Space, from: number, to: number): void {
    const { snap, room } = input;
    if (!snap.tracks) return;
    const t = space.t;
    for (const [id, track] of snap.tracks) {
      const look = botLook(id);
      for (const s of track.landings) {
        if (s <= from || s > to) continue;
        const b = track.at(s);
        const cx = space.X((b.x + PHYS.botWidth / 2) / T);
        const cy = space.Y(b.y / T);
        for (let i = 0; i < 7; i++) {
          const dir = i % 2 === 0 ? 1 : -1;
          this.particles.push({ x: cx + dir * t * 0.15, y: cy - t * 0.04, vx: dir * t * (0.8 + hashOf(`${id}${s}${i}`) * 1.6), vy: -t * (0.4 + hashOf(`${s}${i}`) * 0.9), life: 0, max: 0.45, size: t * 0.09, colour: 'rgba(200, 212, 240, 0.55)' });
        }
      }
      if (track.exitStep !== null && track.exitStep > from && track.exitStep <= to) {
        const b = track.at(track.exitStep);
        const cx = space.X((b.x + PHYS.botWidth / 2) / T);
        const cy = space.Y((b.y + heightOf(b.look) / 2) / T);
        for (let i = 0; i < 14; i++) {
          const a = (i / 14) * Math.PI * 2;
          this.particles.push({ x: cx, y: cy, vx: Math.cos(a) * t * 1.6, vy: Math.sin(a) * t * 1.6 - t * 0.4, life: 0, max: 0.8, size: t * 0.08, colour: look.light });
        }
      }
    }
    // Coins picked up: a pop, and +1 in the colour of whoever took it.
    for (const e of input.resolve?.events ?? []) {
      if (e.type !== 'coin') continue;
      const local = e.step - (input.resolve?.trace.startStep ?? 0);
      if (local <= from || local > to) continue;
      const def = room.level.coins.find((c) => c.id === e.coin);
      if (!def) continue;
      const cx = space.X(def.tx + 0.5);
      const cy = space.Y(def.ty + 0.5);
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2;
        this.particles.push({ x: cx, y: cy, vx: Math.cos(a) * t * 2, vy: Math.sin(a) * t * 2, life: 0, max: 0.5, size: t * 0.07, colour: THEME.coin });
      }
      this.particles.push({ x: cx, y: cy - t * 0.3, vx: 0, vy: -t * 1.1, life: 0, max: 1.1, size: t * 0.42, colour: botLook(e.bot).light, text: room.kind === 'practice' ? '+0' : '+1' });
    }
  }

  private drawParticles(ctx: Ctx, dt: number): void {
    const alive: Particle[] = [];
    for (const p of this.particles) {
      p.life += dt;
      if (p.life >= p.max) continue;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += (p.text ? 0 : 60) * dt;
      p.vx *= 1 - 2.5 * dt;
      const a = 1 - p.life / p.max;
      if (p.text) {
        ctx.font = `800 ${Math.round(p.size)}px Nunito, system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillStyle = alpha('#0b1024', 0.6 * a);
        ctx.fillText(p.text, p.x + 1.5, p.y + 1.5);
        ctx.fillStyle = p.colour.startsWith('#') ? alpha(p.colour, a) : p.colour;
        ctx.fillText(p.text, p.x, p.y);
      } else {
        ctx.globalAlpha = a;
        ctx.fillStyle = p.colour;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * (0.6 + 0.4 * a), 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      alive.push(p);
    }
    this.particles = alive;
  }

  private drawWiring(ctx: Ctx, room: RoomData, s: Space, time: number): void {
    const centre = (id: string): { x: number; y: number } | null => {
      const p = room.level.plates.find((x) => x.id === id);
      if (p) return { x: s.X(p.tx + p.width / 2), y: s.Y(p.ty) - s.t * 0.15 };
      const l = room.level.levers.find((x) => x.id === id);
      if (l) return { x: s.X(l.tx + 0.5), y: s.Y(l.ty) - s.t * 0.4 };
      return null;
    };
    ctx.save();
    ctx.setLineDash([s.t * 0.12, s.t * 0.18]);
    ctx.lineDashOffset = -time * s.t * 0.6;
    ctx.lineWidth = Math.max(1, s.t * 0.05);
    for (const d of room.level.doors) {
      const to = { x: s.X(d.tx + 0.5), y: s.Y(d.ty + d.height) + s.t * 0.4 };
      for (const id of d.openWhen) {
        const from = centre(id);
        if (!from) continue;
        ctx.strokeStyle = alpha(this.wires.get(d.id) ?? '#ffffff', 0.55);
        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        const mx = (from.x + to.x) / 2;
        const my = Math.min(from.y, to.y) - s.t * 2.2;
        ctx.quadraticCurveTo(mx, my, to.x, to.y);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  private drawListenerRing(ctx: Ctx, s: Space, snap: Snapshot, id: string, time: number): void {
    const b = snap.bodies[id];
    if (!b || (b.look === 'exited' && !this.ghosts.has(id))) return;
    const cx = s.X((b.x + PHYS.botWidth / 2) / T);
    const cy = s.Y((b.y + heightOf(b.look) / 2) / T);
    ctx.save();
    ctx.strokeStyle = alpha(botLook(id).light, 0.8);
    ctx.lineWidth = Math.max(1.5, s.t * 0.05);
    ctx.setLineDash([s.t * 0.14, s.t * 0.12]);
    ctx.lineDashOffset = -time * s.t;
    ctx.beginPath();
    ctx.ellipse(cx, cy, s.t * 0.75, s.t * 1.05, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  /** Shade everything one bot can't see, using its true (hidden) sight range: the spectator sees what it really saw. */
  private drawSight(ctx: Ctx, room: RoomData, snap: Snapshot, id: string, stats: Record<string, BotStats>): void {
    const b = snap.bodies[id];
    const st = stats[id];
    if (!b || !st || b.look === 'exited') return;
    const key = `${room.id}|${id}|${Math.round(b.x / 500)}|${Math.round(b.y / 500)}|${JSON.stringify(snap.switches.doors)}`;
    if (key !== this.sightKey || !this.sightCanvas) {
      this.sightKey = key;
      const viewer = { id, x: b.x, y: b.y, w: PHYS.botWidth, h: heightOf(b.look), phys: physicsFor(st) } as unknown as Bot;
      const world = { level: room.level, doors: snap.switches.doors, bots: [viewer] } as unknown as World;
      const seen = visibleTiles(world, viewer);
      const c = this.sightCanvas ?? document.createElement('canvas');
      c.width = room.level.width;
      c.height = room.level.height;
      const sctx = c.getContext('2d') as Ctx;
      const img = sctx.createImageData(c.width, c.height);
      for (let ty = 0; ty < c.height; ty++) {
        for (let tx = 0; tx < c.width; tx++) {
          const i = ((c.height - 1 - ty) * c.width + tx) * 4;
          img.data[i] = 6;
          img.data[i + 1] = 9;
          img.data[i + 2] = 22;
          img.data[i + 3] = seen[ty * c.width + tx] ? 0 : 200;
        }
      }
      sctx.putImageData(img, 0, 0);
      this.sightCanvas = c;
    }
    const f = this.frame;
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.sightCanvas, f.x, f.y, f.w, f.h);
    ctx.restore();
  }

  private drawSpotlight(ctx: Ctx, snap: Snapshot, speaker: string | null, dt: number, jumped: boolean): void {
    const b = speaker ? snap.bodies[speaker] : undefined;
    // A ghost still speaks, so it still gets the light when it does.
    const here = b !== undefined && (b.look !== 'exited' || (speaker !== null && this.ghosts.has(speaker)));
    const target = here ? 1 : 0;
    if (b && here) {
      const p = this.toScreen(b.x + PHYS.botWidth / 2, b.y + heightOf(b.look) * 0.6);
      if (jumped || this.spot.a < 0.02 || this.spot.id !== speaker) {
        this.spot.x = jumped || this.spot.a < 0.02 ? p.x : approach(this.spot.x, p.x, dt, 12);
        this.spot.y = jumped || this.spot.a < 0.02 ? p.y : approach(this.spot.y, p.y, dt, 12);
      } else {
        this.spot.x = approach(this.spot.x, p.x, dt, 14);
        this.spot.y = approach(this.spot.y, p.y, dt, 14);
      }
      this.spot.id = speaker ?? '';
    }
    this.spot.a = jumped ? target : approach(this.spot.a, target, dt, 7);
    if (this.spot.a < 0.01) return;
    const t = this.frame.tile;
    const g = this.ctx.createRadialGradient(this.spot.x, this.spot.y, t * 2.2, this.spot.x, this.spot.y, t * 9);
    g.addColorStop(0, 'rgba(6, 9, 22, 0)');
    g.addColorStop(1, `rgba(6, 9, 22, ${0.4 * this.spot.a})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.cssW, this.cssH);
  }
}
