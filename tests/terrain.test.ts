/**
 * Ladders and one-way platforms in the view (after the M5 games, 2026-11-20):
 * they were only characters in the map, and bots counting columns put a
 * ladder at x=16 or 18 when it stood at 20. Now they are listed with exact
 * coordinates like every other element, and a ladder has an id to walk to.
 */
import { describe, expect, it } from 'vitest';
import { UNITS_PER_TILE as T } from '../engine/constants';
import { laddersOf, platformsOf } from '../engine/level';
import { EventLog } from '../game/events';
import { buildView, observe } from '../game/view';
import type { RoomInfo } from '../game/view';
import { loadLevels } from '../harness/levels';
import { bot, makeLevel, play, startWorld } from './engineHelpers';

// A ladder (column 9, three tiles from the floor) and a one-way platform (columns 4-6, one row up).
const level = makeLevel(['############', '#..........#', '#........=.#', '#........=.#', '#...---..=.#', '#.A.......x#', '############']);
const room: RoomInfo = { index: 0, count: 1, id: 'test', name: 'Test', kind: 'puzzle', round: 1, rounds: 5, goal: 1, talkEvery: 1 };

describe('ladders and platforms', () => {
  it('are found in the map and named left to right', () => {
    expect(laddersOf(level)).toEqual([{ id: 'H1', tx: 9, ty: 2, height: 3 }]);
    expect(platformsOf(level)).toEqual([{ tx0: 4, tx1: 7, ty: 2 }]);
    // The real rooms: The Last Door's ladder is the one the bots couldn't place.
    const lastDoor = loadLevels().find((l) => l.id.startsWith('L6'));
    expect(laddersOf(lastDoor as never)[0]).toMatchObject({ id: 'H1', tx: 20 });
  });

  it('are listed in the view with exact coordinates, and only where they are (never how they work)', () => {
    const world = startWorld(level);
    const view = buildView({ bot: 'A', phase: 'talk', room, world, observation: observe(world, 'A'), events: new EventLog().forBot('A'), names: { A: null }, score: { coins: 0, roomsEscaped: 0 } });
    expect(view.text).toContain('- ladder H1: x=9.00 to 10.00, from y=2.00 up to y=5.00');
    expect(view.text).toContain('- one-way platform: x=4.00 to 7.00, its top at y=3.00');
    expect(view.text).not.toMatch(/stand on it|jump up through/);
  });

  it('lets a bot walk to a ladder by its id, and offers that in the move menu', () => {
    const { world, results } = play(startWorld(level), { A: ['walk_to(H1)'] });
    expect(results[0]?.status).toBe('done');
    const a = bot(world, 'A');
    expect(a.x + a.w / 2).toBe(9 * T + T / 2);
    const menu = observe(startWorld(level), 'A').moves.map((m) => m.command);
    expect(menu).toContain('walk_to(H1)');
  });
});
