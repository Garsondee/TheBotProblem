/**
 * Where everything is at a given moment of a room.
 *
 * The physics trace lists, for each step, only the bodies that changed
 * (engine/resolve.ts). To draw step s, each body needs its latest entry at or
 * before s, and the next one, to slide between them: playback is smooth at
 * any speed because positions are interpolated, never guessed. Switches
 * (doors, levers, plates, coins) change only at recorded events, which carry
 * the step they happened at.
 */
import { PHYS } from '../../engine/constants';
import type { TraceFrame } from '../../engine/resolve';
import type { BodyState, ResolveData, RoomData, SwitchState } from './data';

/** A bot's height in units for how it looks: crouched bots are half as tall (engine: crouch). */
export function heightOf(look: string): number {
  return look === 'crouch' || look === 'crawl' ? Math.round(PHYS.botHeight / 2) : PHYS.botHeight;
}

/** One body's frames through one resolve, for looking up any (fractional) step. */
export class BodyTrack {
  readonly times: number[] = [];
  readonly frames: TraceFrame[] = [];
  /** Steps at which the body landed (was falling, then wasn't): for squash and dust. */
  readonly landings: number[] = [];
  /** Steps at which a jump began. */
  readonly takeoffs: number[] = [];
  exitStep: number | null = null;

  add(t: number, f: TraceFrame): void {
    const prev = this.frames.at(-1);
    this.times.push(t);
    this.frames.push(f);
    if (prev) {
      if ((prev[4] === 'fall' || prev[4] === 'jump') && f[4] !== 'fall' && f[4] !== 'jump' && f[4] !== 'exited') this.landings.push(t);
      if (prev[4] !== 'jump' && f[4] === 'jump') this.takeoffs.push(t);
      if (f[4] === 'exited' && prev[4] !== 'exited') this.exitStep = t;
    }
  }

  private indexAt(s: number): number {
    let lo = 0;
    let hi = this.times.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((this.times[mid] as number) <= s) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  at(s: number): BodyState {
    const i = this.indexAt(s);
    const f0 = this.frames[i] as TraceFrame;
    const t1 = this.times[i + 1];
    const f1 = this.frames[i + 1];
    if (t1 === undefined || !f1 || s <= t1 - 1) return { x: f0[0], y: f0[1], vx: f0[2], vy: f0[3], look: f0[4] };
    // The body moved during the step that ended at t1: slide between the two frames.
    const a = s - (t1 - 1);
    return {
      x: f0[0] + (f1[0] - f0[0]) * a,
      y: f0[1] + (f1[1] - f0[1]) * a,
      vx: f0[2] + (f1[2] - f0[2]) * a,
      vy: f0[3] + (f1[3] - f0[3]) * a,
      look: a < 0.5 ? f0[4] : f1[4],
    };
  }

  last(): BodyState {
    const f = this.frames.at(-1) as TraceFrame;
    return { x: f[0], y: f[1], vx: 0, vy: 0, look: f[4] };
  }

  /** Steps since the most recent of `marks` at or before s (Infinity if none). */
  since(marks: readonly number[], s: number): number {
    let best = -Infinity;
    for (const m of marks) if (m <= s && m > best) best = m;
    return s - best;
  }
}

export interface Snapshot {
  bodies: Record<string, BodyState>;
  switches: SwitchState;
  /** Bots out of the room (through an exit) at this moment. */
  exited: Set<string>;
  /** Coins each bot has picked up in this room so far. */
  coins: Record<string, number>;
  /** The step within the current resolve, or null between resolves. */
  step: number | null;
  /** The bodies' tracks during a resolve, for squash, dust and fading out. */
  tracks: Map<string, BodyTrack> | null;
}

interface Settled {
  bodies: Record<string, BodyState>;
  switches: SwitchState;
  exited: Set<string>;
  coins: Record<string, number>;
}

function applyEvents(base: Settled, resolve: ResolveData, upToStep: number): Settled {
  const out: Settled = {
    bodies: base.bodies,
    switches: { doors: { ...base.switches.doors }, levers: { ...base.switches.levers }, plates: { ...base.switches.plates }, coins: [...base.switches.coins] },
    exited: new Set(base.exited),
    coins: { ...base.coins },
  };
  for (const e of resolve.events) {
    if (e.step - resolve.trace.startStep > upToStep) break;
    switch (e.type) {
      case 'door':
        out.switches.doors[e.door] = e.open;
        break;
      case 'lever':
        out.switches.levers[e.lever] = e.on;
        break;
      case 'plate':
        out.switches.plates[e.plate] = e.pressed;
        break;
      case 'coin':
        out.switches.coins = out.switches.coins.filter((c) => c !== e.coin);
        out.coins[e.bot] = (out.coins[e.bot] ?? 0) + 1;
        break;
      case 'exit':
        out.exited.add(e.bot);
        break;
    }
  }
  return out;
}

/** Everything needed to show any moment of one room. */
export class RoomPlayback {
  private readonly before = new Map<number, Settled>();
  private readonly tracks = new Map<number, Map<string, BodyTrack>>();
  private readonly initial: Settled;

  constructor(readonly room: RoomData) {
    let settled: Settled = {
      bodies: { ...room.startBodies },
      switches: room.startSwitches,
      exited: new Set(Object.entries(room.startBodies).filter(([, b]) => b.look === 'exited').map(([id]) => id)),
      coins: {},
    };
    this.initial = settled;
    for (const rd of room.roundsData) {
      this.before.set(rd.round, settled);
      if (!rd.resolve) continue;
      const tr = rd.resolve.trace;
      const tracks = new Map<string, BodyTrack>();
      for (const [id, f] of Object.entries(tr.initial)) {
        const track = new BodyTrack();
        track.add(0, f);
        tracks.set(id, track);
      }
      for (const frame of tr.frames) {
        for (const [id, f] of Object.entries(frame.bodies)) tracks.get(id)?.add(frame.t, f);
      }
      this.tracks.set(rd.round, tracks);
      const after = applyEvents(settled, rd.resolve, Infinity);
      const bodies: Record<string, BodyState> = {};
      for (const [id, track] of tracks) bodies[id] = track.last();
      settled = { ...after, bodies };
    }
    this.before.set(Infinity, settled);
  }

  /** The room at the start of `round` (before it moves), or at the end of the room for Infinity. */
  settledAt(round: number): Snapshot {
    const s = this.before.get(round) ?? this.nearestBefore(round);
    return { ...s, step: null, tracks: null };
  }

  /** The latest round start at or before `round`; before the first round, the room as it starts. */
  private nearestBefore(round: number): Settled {
    const rounds = [...this.before.keys()].filter((r) => r <= round).sort((a, b) => a - b);
    const last = rounds.at(-1);
    return last === undefined ? this.initial : (this.before.get(last) as Settled);
  }

  /** The room `step` steps into the resolve of `round`. */
  during(round: number, step: number): Snapshot {
    const rd = this.room.roundsData.find((r) => r.round === round);
    const tracks = this.tracks.get(round);
    const start = this.before.get(round);
    if (!rd?.resolve || !tracks || !start) return this.settledAt(round);
    const settled = applyEvents(start, rd.resolve, step);
    const bodies: Record<string, BodyState> = {};
    for (const [id, track] of tracks) bodies[id] = track.at(step);
    return { ...settled, bodies, step, tracks };
  }
}
