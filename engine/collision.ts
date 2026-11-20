/**
 * Collision: how far a box can move before something stops it.
 *
 * Every solid thing is an axis-aligned box: solid tiles, closed doors,
 * crates and bots. Moving a body is done one axis at a time (spec section 4:
 * "axis-separated AABB collision"): first sideways, then up or down. Each
 * sweep finds the nearest obstacle ahead and stops the body flush against it.
 *
 * Boxes are half-open, [x, x + w), so two boxes that touch edge to edge do
 * not overlap. With whole-number units this is exact: a bot standing on the
 * floor has y equal to the floor's top, not "nearly".
 *
 * One-way platforms and ladder tops only stop bodies moving DOWN onto them
 * from above, and a bot that is dropping through or climbing ignores them.
 */
import { PHYS, UNITS_PER_TILE as T } from './constants';
import type { DoorDef, ExitDef, LeverDef, CoinDef, Level, PlateDef } from './level';
import { isLadderTop, TILE, tileAt } from './level';
import type { Body, Bot, Contact, World } from './world';

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

const overlapsVertically = (a: Box, b: Box) => a.y < b.y + b.h && b.y < a.y + a.h;
const overlapsHorizontally = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w;

export const doorBox = (d: DoorDef): Box => ({ x: d.tx * T, y: d.ty * T, w: T, h: d.height * T });
export const exitBox = (e: ExitDef): Box => ({ x: e.tx * T, y: e.ty * T, w: T, h: 2 * T });
export const coinBox = (c: CoinDef): Box => ({ x: c.tx * T + T / 4, y: c.ty * T + T / 4, w: T / 2, h: T / 2 });
export const leverReachBox = (l: LeverDef): Box => ({
  x: l.tx * T - PHYS.leverReach,
  y: l.ty * T,
  w: T + 2 * PHYS.leverReach,
  h: T,
});
/** A plate is the floor's top surface across its width; it sits in the tile above that floor. */
export const plateSpan = (p: PlateDef) => ({ x0: p.tx * T, x1: (p.tx + p.width) * T, y: p.ty * T });

const WALL: Contact = { kind: 'tile', tile: 'solid' };

interface Obstacle {
  box: Box;
  contact: Contact;
}

/**
 * Does `other` let the moving bot `self` through? Bots are solid to each other only when it means
 * something: a bot standing its ground on purpose (the block command), or one moving the same way (bots
 * going the same way push as one, so two can still shift a heavy crate). A bot standing still, or coming
 * the other way, lets it through: in the first paid games (2026-11-20) two thirds of failed commands were
 * bots stuck behind bots that never meant to be in the way. Up and down, only climbing passes through
 * (two bots can share a ladder); anything falling still lands on a head, so bots can stand on each other.
 */
function letsThrough(other: Bot, self: Bot, axis: 'x' | 'y', dir: number): boolean {
  if (other.blocking) return false;
  if (axis === 'x') return other.vx === 0 || Math.sign(other.vx) !== Math.sign(dir);
  return self.onLadder && (other.vy === 0 || Math.sign(other.vy) !== Math.sign(dir));
}

/**
 * How the bot asking is moving, which decides which bots are solid to it: a move along one axis (the
 * letsThrough rule); 'still', a place it would occupy (landing, a ladder, the far side of a bot): only a
 * bot standing its ground takes up room; 'all', every bot, for what holds things up (heads to stand on,
 * room to stand up from a crouch).
 */
type Motion = { axis: 'x' | 'y'; dir: number } | 'still' | 'all';

/** Everything solid that isn't a tile: closed doors, crates, and bots still in play that don't let `self` through. */
function obstacles(world: World, self: Body, motion: Motion): Obstacle[] {
  const out: Obstacle[] = [];
  for (const door of world.level.doors) {
    if (!world.doors[door.id]) out.push({ box: doorBox(door), contact: { kind: 'door', id: door.id } });
  }
  for (const crate of world.crates) {
    if (crate !== self) out.push({ box: crate, contact: { kind: 'crate', id: crate.id } });
  }
  // Two bots swapping places pass through each other for that slot, and only each other. Crates never pass through bots.
  const selfBot = 'passThrough' in self ? (self as Bot) : null;
  const passing = selfBot?.passThrough ?? null;
  for (const bot of world.bots) {
    if (bot === self || bot.exited || bot.id === passing || bot.passThrough === self.id) continue;
    if (selfBot && motion !== 'all' && (motion === 'still' ? !bot.blocking : letsThrough(bot, selfBot, motion.axis, motion.dir))) continue;
    out.push({ box: bot, contact: { kind: 'bot', id: bot.id } });
  }
  return out;
}

export interface Sweep {
  /** How far the body can actually move (same sign as asked, never further). */
  moved: number;
  /** What stopped it, if anything did. */
  contact: Contact | null;
}

/** How far `body` can move sideways by `dx`. Doesn't move it. */
export function sweepX(world: World, body: Box, dx: number): Sweep {
  if (dx === 0) return { moved: 0, contact: null };
  const level = world.level;
  let limit = dx;
  let contact: Contact | null = null;
  const rowFrom = Math.floor(body.y / T);
  const rowTo = Math.floor((body.y + body.h - 1) / T);
  if (dx > 0) {
    const front = body.x + body.w;
    const end = front + dx;
    tiles: for (let col = Math.ceil(front / T); col * T < end; col++) {
      for (let row = rowFrom; row <= rowTo; row++) {
        if (tileAt(level, col, row) === TILE.SOLID) {
          limit = col * T - front;
          contact = WALL;
          break tiles;
        }
      }
    }
    for (const o of obstacles(world, body as Body, { axis: 'x', dir: dx })) {
      if (overlapsVertically(o.box, body) && o.box.x >= front && o.box.x - front < limit) {
        limit = o.box.x - front;
        contact = o.contact;
      }
    }
  } else {
    const back = body.x;
    const end = back + dx;
    tiles: for (let col = Math.floor(back / T) - 1; (col + 1) * T > end; col--) {
      for (let row = rowFrom; row <= rowTo; row++) {
        if (tileAt(level, col, row) === TILE.SOLID) {
          limit = (col + 1) * T - back;
          contact = WALL;
          break tiles;
        }
      }
    }
    for (const o of obstacles(world, body as Body, { axis: 'x', dir: dx })) {
      const right = o.box.x + o.box.w;
      if (overlapsVertically(o.box, body) && right <= back && right - back > limit) {
        limit = right - back;
        contact = o.contact;
      }
    }
  }
  return { moved: limit, contact: limit === dx ? null : contact };
}

/**
 * How far `body` can move up or down by `dy`. Moving down, one-way platforms
 * and ladder tops also stop it, unless `passPlatforms` (dropping or climbing).
 */
export function sweepY(world: World, body: Box, dy: number, passPlatforms: boolean): Sweep {
  if (dy === 0) return { moved: 0, contact: null };
  const level = world.level;
  let limit = dy;
  let contact: Contact | null = null;
  const colFrom = Math.floor(body.x / T);
  const colTo = Math.floor((body.x + body.w - 1) / T);
  if (dy > 0) {
    const top = body.y + body.h;
    const end = top + dy;
    tiles: for (let row = Math.ceil(top / T); row * T < end; row++) {
      for (let col = colFrom; col <= colTo; col++) {
        if (tileAt(level, col, row) === TILE.SOLID) {
          limit = row * T - top;
          contact = WALL;
          break tiles;
        }
      }
    }
    for (const o of obstacles(world, body as Body, { axis: 'y', dir: dy })) {
      if (overlapsHorizontally(o.box, body) && o.box.y >= top && o.box.y - top < limit) {
        limit = o.box.y - top;
        contact = o.contact;
      }
    }
  } else {
    const bottom = body.y;
    const end = bottom + dy;
    tiles: for (let row = Math.floor(bottom / T) - 1; (row + 1) * T > end; row--) {
      for (let col = colFrom; col <= colTo; col++) {
        const tile = tileAt(level, col, row);
        const platform = tile === TILE.ONEWAY || isLadderTop(level, col, row);
        if (tile === TILE.SOLID || (platform && !passPlatforms)) {
          limit = (row + 1) * T - bottom;
          contact = tile === TILE.SOLID ? WALL : { kind: 'tile', tile: tile === TILE.ONEWAY ? 'platform' : 'ladder-top' };
          break tiles;
        }
      }
    }
    for (const o of obstacles(world, body as Body, { axis: 'y', dir: dy })) {
      const top = o.box.y + o.box.h;
      if (overlapsHorizontally(o.box, body) && top <= bottom && top - bottom > limit) {
        limit = top - bottom;
        contact = o.contact;
      }
    }
  }
  return { moved: limit, contact: limit === dy ? null : contact };
}

/** What a body is standing on right now, or null if nothing is directly under it. */
export function supportUnder(world: World, body: Box, passPlatforms: boolean): Contact | null {
  const s = sweepY(world, body, -1, passPlatforms);
  return s.moved === 0 ? s.contact : null;
}

/**
 * Is a box free of solid tiles and other bodies? For a place a bot would take (a ladder, a landing spot),
 * only a bot standing its ground takes up room ('still'); 'all' counts every bot (room to stand up).
 */
export function isFree(world: World, box: Box, self: Body, motion: 'still' | 'all' = 'still'): boolean {
  const level = world.level;
  for (let row = Math.floor(box.y / T); row <= Math.floor((box.y + box.h - 1) / T); row++) {
    for (let col = Math.floor(box.x / T); col <= Math.floor((box.x + box.w - 1) / T); col++) {
      if (tileAt(level, col, row) === TILE.SOLID) return false;
    }
  }
  return obstacles(world, self, motion).every((o) => !overlaps(o.box, box));
}

/**
 * The stretches of surface at height `y` that something could stand on:
 * tops of solid tiles, platforms, ladder tops, closed doors, crates and bots
 * (except `self`), merged where they touch. Used to find platform edges.
 */
export function surfaceIntervals(world: World, y: number, self: Body): Array<[number, number]> {
  const level: Level = world.level;
  const raw: Array<[number, number]> = [];
  if (y % T === 0) {
    const row = y / T - 1;
    for (let col = 0; col < level.width; col++) {
      const tile = tileAt(level, col, row);
      if (tile === TILE.SOLID || tile === TILE.ONEWAY || isLadderTop(level, col, row)) raw.push([col * T, (col + 1) * T]);
    }
  }
  for (const o of obstacles(world, self, 'all')) {
    if (o.box.y + o.box.h === y) raw.push([o.box.x, o.box.x + o.box.w]);
  }
  raw.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [a, b] of raw) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  return merged;
}
