/**
 * The world as ASCII art, one string per row, top row first. Used by the
 * `npm run levels` tool and the tests; milestone 3 builds the bots' own
 * maps (masked by line of sight) on top of it.
 *
 *   #  solid     .  empty      -  one-way platform     H  ladder
 *   |  closed door            /  open door
 *   p  plate     P  plate (pressed)
 *   l  lever     L  lever (on)
 *   c  crate     $  coin       X  exit
 *   A to H       bots, drawn where their feet are
 *   ?            a tile the viewer can't see (when a visibility mask is given)
 */
import { UNITS_PER_TILE as T } from './constants';
import { TILE, tileAt } from './level';
import type { World } from './world';

export function renderWorld(world: World, visible?: readonly boolean[]): string[] {
  const { level } = world;
  const grid: string[][] = [];
  for (let ty = 0; ty < level.height; ty++) {
    const row: string[] = [];
    for (let tx = 0; tx < level.width; tx++) {
      const tile = tileAt(level, tx, ty);
      row.push(tile === TILE.SOLID ? '#' : tile === TILE.ONEWAY ? '-' : tile === TILE.LADDER ? 'H' : '.');
    }
    grid.push(row);
  }
  const put = (tx: number, ty: number, ch: string) => {
    const row = grid[ty];
    if (row && tx >= 0 && tx < row.length) row[tx] = ch;
  };
  for (const p of level.plates) for (let i = 0; i < p.width; i++) put(p.tx + i, p.ty, world.plates[p.id] ? 'P' : 'p');
  for (const l of level.levers) put(l.tx, l.ty, world.levers[l.id] ? 'L' : 'l');
  for (const e of level.exits) {
    put(e.tx, e.ty, 'X');
    put(e.tx, e.ty + 1, 'X');
  }
  for (const c of level.coins) if (world.coins.includes(c.id)) put(c.tx, c.ty, '$');
  for (const d of level.doors) for (let i = 0; i < d.height; i++) put(d.tx, d.ty + i, world.doors[d.id] ? '/' : '|');
  for (const c of world.crates) put(Math.floor((c.x + c.w / 2) / T), Math.floor((c.y + c.h / 2) / T), 'c');
  for (const b of world.bots) {
    if (!b.exited) put(Math.floor((b.x + b.w / 2) / T), Math.floor((b.y + T / 2) / T), b.id);
  }
  if (visible) {
    for (let ty = 0; ty < level.height; ty++) {
      for (let tx = 0; tx < level.width; tx++) if (!visible[ty * level.width + tx]) put(tx, ty, '?');
    }
  }
  return grid.reverse().map((row) => row.join(''));
}
