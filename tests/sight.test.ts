import { describe, expect, it } from 'vitest';
import { UNITS_PER_TILE as T } from '../engine/constants';
import { renderWorld } from '../engine/render';
import { canSeeBody, canSeePoint, clearLine, visibleTiles } from '../engine/sight';
import { NOMINAL_STATS } from '../engine/stats';
import { bot, makeLevel, startWorld } from './engineHelpers';

const centre = (tx: number, ty: number) => ({ x: tx * T + T / 2, y: ty * T + T / 2 });

describe('line of sight', () => {
  const level = makeLevel(
    [
      '################',
      '#..............#',
      '#......#.......#',
      '#......#.......#',
      '#.A....#..B....#',
      '#----......x...#',
      '#..............#',
      '################',
    ],
    { d: { type: 'door', id: 'D1', height: 1, openWhen: ['V1'] }, v: { type: 'lever', id: 'V1', mode: 'toggle' } },
  );

  it('is blocked by solid tiles, but not by one-way platforms', () => {
    const world = startWorld(level);
    const a = bot(world, 'A');
    expect(canSeeBody(world, a, bot(world, 'B'))).toBe(false); // the wall at x = 7 is between them
    expect(canSeePoint(world, a, centre(3, 1))).toBe(true); // through the platform below
  });

  it('sees over the wall from high enough', () => {
    const world = startWorld(level);
    expect(clearLine(world, centre(2, 6), centre(11, 6))).toBe(true);
  });

  it('is blocked through a corner where two walls meet diagonally, but not past a single corner', () => {
    // The line from tile (2,2) to tile (4,4) runs exactly through the grid corner at (3,3).
    // Walls at (2,3) and (3,2) meet at that corner, so there is no gap to see through.
    const pinched = makeLevel(['#########', '#.......#', '#.......#', '#.#.....#', '#..#....#', '#A....x.#', '#########']);
    expect(clearLine(startWorld(pinched), centre(2, 2), centre(4, 4))).toBe(false);
    // With only one of those walls, the line grazes its corner and gets through.
    const grazing = makeLevel(['#########', '#.......#', '#.......#', '#.......#', '#..#....#', '#A....x.#', '#########']);
    expect(clearLine(startWorld(grazing), centre(2, 2), centre(4, 4))).toBe(true);
  });

  it('stops at the hidden sight range', () => {
    const open = makeLevel([
      '##############################',
      '#............................#',
      '#............................#',
      '#.A........................x.#',
      '##############################',
    ]);
    const nearSighted = startWorld(open, { A: { ...NOMINAL_STATS, sightRange: 900 } }); // 9 tiles
    const a = bot(nearSighted, 'A');
    expect(canSeePoint(nearSighted, a, centre(10, 1))).toBe(true);
    expect(canSeePoint(nearSighted, a, centre(13, 1))).toBe(false);
  });

  it('shows the wall a bot faces, and nothing behind it', () => {
    const world = startWorld(level);
    const seen = visibleTiles(world, bot(world, 'A'));
    const at = (tx: number, ty: number) => seen[ty * level.width + tx];
    expect(at(7, 3)).toBe(true); // the wall itself
    expect(at(9, 3)).toBe(false); // behind it
    const masked = renderWorld(world, seen);
    expect(masked.some((row) => row.includes('?'))).toBe(true);
    expect(masked.join('\n')).not.toContain('B'); // B is behind the wall
  });
});
