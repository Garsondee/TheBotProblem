/**
 * Line of sight: what a bot can see from its eyes.
 *
 * The spec (section 6): "Ray-cast from the bot's eye on the tile grid
 * (Bresenham-style or DDA). Solid tiles block sight; a configurable sight
 * range applies."
 *
 * This walks the ray tile by tile, using the DDA method of Amanatides and
 * Woo, so it never skips a tile the ray passes through. Solid tiles and
 * closed doors block sight; one-way platforms, ladders, crates and bots
 * don't. A ray passing exactly through a corner where two blocking tiles
 * meet diagonally is blocked, because there is no gap there to see through.
 *
 * Sight range is a hidden stat (about 10 tiles, plus or minus 10%), so two
 * bots standing side by side may genuinely not see the same things.
 */
import { UNITS_PER_TILE as T } from './constants';
import { doorBox, overlaps } from './collision';
import { TILE, tileAt } from './level';
import type { Body, Bot, World } from './world';

export interface Point {
  x: number;
  y: number;
}

/** A bot's eye: centred, near the top of its body. */
export function eyeOf(bot: Bot): Point {
  return { x: bot.x + bot.w / 2, y: bot.y + Math.round(bot.h * 0.85) };
}

function blocksSight(world: World, tx: number, ty: number): boolean {
  if (tileAt(world.level, tx, ty) === TILE.SOLID) return true;
  const cell = { x: tx * T, y: ty * T, w: T, h: T };
  return world.level.doors.some((d) => !world.doors[d.id] && overlaps(doorBox(d), cell));
}

/**
 * Is the straight line from `from` to `to` free of blocking tiles? The tile
 * containing `to` doesn't count, so a bot can see the wall it looks at.
 */
export function clearLine(world: World, from: Point, to: Point): boolean {
  let tx = Math.floor(from.x / T);
  let ty = Math.floor(from.y / T);
  const endX = Math.floor(to.x / T);
  const endY = Math.floor(to.y / T);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const stepX = Math.sign(dx);
  const stepY = Math.sign(dy);
  // How far along the line (0 = start, 1 = end) the next vertical and horizontal grid lines are.
  const deltaX = dx === 0 ? Infinity : T / Math.abs(dx);
  const deltaY = dy === 0 ? Infinity : T / Math.abs(dy);
  let nextX = dx === 0 ? Infinity : (stepX > 0 ? (tx + 1) * T - from.x : from.x - tx * T) / Math.abs(dx);
  let nextY = dy === 0 ? Infinity : (stepY > 0 ? (ty + 1) * T - from.y : from.y - ty * T) / Math.abs(dy);

  while (tx !== endX || ty !== endY) {
    if (Math.min(nextX, nextY) > 1) return true; // the line ends inside this tile
    if (nextX < nextY) {
      tx += stepX;
      nextX += deltaX;
    } else if (nextY < nextX) {
      ty += stepY;
      nextY += deltaY;
    } else {
      // Exactly through a corner: blocked only if both tiles beside the corner block.
      if (blocksSight(world, tx + stepX, ty) && blocksSight(world, tx, ty + stepY)) return false;
      tx += stepX;
      ty += stepY;
      nextX += deltaX;
      nextY += deltaY;
    }
    if ((tx !== endX || ty !== endY) && blocksSight(world, tx, ty)) return false;
  }
  return true;
}

/** Within this bot's (hidden) sight range? Compared squared, so no square roots and no rounding. */
export function inRange(bot: Bot, p: Point): boolean {
  const eye = eyeOf(bot);
  const dx = p.x - eye.x;
  const dy = p.y - eye.y;
  return dx * dx + dy * dy <= bot.phys.sightRange * bot.phys.sightRange;
}

export function canSeePoint(world: World, viewer: Bot, p: Point): boolean {
  return inRange(viewer, p) && clearLine(world, eyeOf(viewer), p);
}

/** Can `viewer` see any part of `body`? Checks its middle, top and bottom. */
export function canSeeBody(world: World, viewer: Bot, body: Body): boolean {
  if (viewer === body) return true;
  const cx = body.x + body.w / 2;
  const points = [
    { x: cx, y: body.y + body.h / 2 },
    { x: cx, y: body.y + body.h - 1 },
    { x: cx, y: body.y + 1 },
  ];
  return points.some((p) => canSeePoint(world, viewer, p));
}

/** Which tiles `viewer` can see: one flag per cell, index (ty * width + tx). */
export function visibleTiles(world: World, viewer: Bot): boolean[] {
  const { width, height } = world.level;
  const seen = new Array<boolean>(width * height).fill(false);
  const eye = eyeOf(viewer);
  const r = Math.ceil(viewer.phys.sightRange / T) + 1;
  const ex = Math.floor(eye.x / T);
  const ey = Math.floor(eye.y / T);
  for (let ty = Math.max(0, ey - r); ty <= Math.min(height - 1, ey + r); ty++) {
    for (let tx = Math.max(0, ex - r); tx <= Math.min(width - 1, ex + r); tx++) {
      const centre = { x: tx * T + T / 2, y: ty * T + T / 2 };
      if (canSeePoint(world, viewer, centre)) seen[ty * width + tx] = true;
    }
  }
  return seen;
}
