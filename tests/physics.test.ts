/**
 * The physics engine, one mechanic at a time, on tiny levels drawn inline.
 * Map legend: # solid, . empty, - one-way platform, = ladder, A-H bots,
 * x exit; other letters are described in each test's key. The bottom row of
 * a picture is y = 0, so a bot standing on it has its feet at y = 1 tile.
 */
import { describe, expect, it } from 'vitest';
import { PHYS, UNITS_PER_TILE as T } from '../engine/constants';
import { resolvePhase } from '../engine/resolve';
import { apexOf, NOMINAL_STATS } from '../engine/stats';
import { bot, makeLevel, peakY, play, startWorld } from './engineHelpers';

const ROOM = [
  '################',
  '#..............#',
  '#..............#',
  '#..............#',
  '#..............#',
  '#.A..........x.#',
  '################',
];

describe('moving and falling', () => {
  it('lands a falling bot exactly on the floor, not a hair above it', () => {
    const level = makeLevel(['#########', '#.A.....#', '#.......#', '#.......#', '#.....x.#', '#########']);
    const { world } = play(startWorld(level), { A: ['wait'] });
    expect(bot(world, 'A').y).toBe(T); // the floor's top, exactly
    expect(bot(world, 'A').grounded).toBe(true);
  });

  it('walks exactly the distance asked, in quarter tiles', () => {
    const start = startWorld(makeLevel(ROOM));
    const { world, results } = play(start, { A: ['walk(right, 2.5)', 'walk(left, 0.25)'] });
    expect(bot(world, 'A').x - bot(start, 'A').x).toBe(2.25 * T);
    expect(results.map((r) => r.status)).toEqual(['done', 'done']);
  });

  it('stops at a wall, says so, and skips the rest of the queue', () => {
    const { results } = play(startWorld(makeLevel(ROOM)), { A: ['walk(left, 5)', 'walk(right, 1)'] });
    expect(results[0]).toMatchObject({ status: 'failed' });
    expect(results[0]?.reason).toMatch(/blocked by a wall/);
    expect(results[1]).toMatchObject({ status: 'skipped' });
  });

  it('cuts off a command that runs too long', () => {
    const out = resolvePhase(startWorld(makeLevel(ROOM)), { A: ['walk(right, 10)'] }, { maxSlotSteps: 30 });
    expect(out.results[0]).toMatchObject({ status: 'cut' });
    expect(out.results[0]?.reason).toMatch(/ran out of time/);
  });
});

describe('jumping', () => {
  it('lifts the feet the rulebook heights: 2.2 tiles full, 1.0 short', () => {
    const start = startWorld(makeLevel(ROOM));
    const full = resolvePhase(start, { A: ['jump(up, run_up=0, hold=full)'] });
    const short = resolvePhase(start, { A: ['jump(up, run_up=0, hold=short)'] });
    expect(peakY(full, 'A') - T).toBe(apexOf(bot(start, 'A').phys.jumpFull, PHYS.gravity));
    expect((peakY(full, 'A') - T) / T).toBeCloseTo(2.2, 2);
    expect((peakY(short, 'A') - T) / T).toBeCloseTo(1.0, 2);
  });

  it('lets a bot with a better hidden jump stat jump higher', () => {
    const strong = startWorld(makeLevel(ROOM), { A: { ...NOMINAL_STATS, jumpHeight: 1080 } });
    const rise = (peakY(resolvePhase(strong, { A: ['jump(up)'] }), 'A') - T) / T;
    expect(rise).toBeGreaterThanOrEqual(2.2 * 1.08);
    expect(rise).toBeLessThan(2.2 * 1.08 + 0.01); // never more than one step's worth over
  });

  // Ground at y = 3 on both sides of a 3-tile pit that is 1 tile deep.
  const PIT = [
    '##################',
    '#................#',
    '#................#',
    '#................#',
    '#.....A.......x..#',
    '#########...######',
    '##################',
    '##################',
  ];

  it('clears a 3-tile gap with a run-up, and falls in without one', () => {
    const level = makeLevel(PIT);
    const runUp = play(startWorld(level), { A: ['walk_to_edge(right)', 'walk(left, 3)', 'jump(right, run_up=3, hold=full)'] });
    expect(bot(runUp.world, 'A').y).toBe(3 * T); // landed on the far side, at ground height
    expect(bot(runUp.world, 'A').x).toBeGreaterThan(12 * T);
    const standing = play(startWorld(level), { A: ['walk_to_edge(right)', 'jump(right, run_up=0, hold=short)'] });
    expect(bot(standing.world, 'A').y).toBe(2 * T); // fell into the pit
  });

  it('still jumps when the run-up runs off the edge (coyote time)', () => {
    const { results, world } = play(startWorld(makeLevel(PIT)), {
      A: ['walk_to_edge(right)', 'walk(left, 2)', 'jump(right, run_up=3, hold=full)'],
    });
    expect(results[2]).toMatchObject({ status: 'done' });
    expect(bot(world, 'A').y).toBe(3 * T);
  });
});

describe('platforms and ladders', () => {
  // A ladder at x = 5 from y = 1 to 4, and a one-way platform at y = 2 (its top at y = 3).
  const TOWER = [
    '##############',
    '#............#',
    '#............#',
    '#....=.......#',
    '#....=.......#',
    '#....=-----..#',
    '#.A..=.....x.#',
    '##############',
  ];

  it('jumps up through a one-way platform, stands on it, and drops back down', () => {
    const up = play(startWorld(makeLevel(TOWER)), { A: ['walk(right, 5)', 'jump(up)'] });
    expect(bot(up.world, 'A').y).toBe(3 * T); // standing on the platform's top
    const down = play(up.world, { A: ['drop'] });
    expect(down.results[0]).toMatchObject({ status: 'done' });
    expect(bot(down.world, 'A').y).toBe(T);
  });

  it('climbs a ladder to the top and back down', () => {
    const level = makeLevel(TOWER);
    const up = play(startWorld(level), { A: ['walk(right, 3)', 'climb(up)'] });
    expect(up.results[1]).toMatchObject({ status: 'done' });
    expect(bot(up.world, 'A').y).toBe(5 * T); // standing on the ladder's top
    const down = play(up.world, { A: ['climb(down)'] });
    expect(bot(down.world, 'A').y).toBe(T);
    const nowhere = play(startWorld(level), { A: ['climb(up)'] });
    expect(nowhere.results[0]?.reason).toBe('there is no ladder here');
  });

  it('stops walk_to_edge with the toes at the edge, and never lets creep walk off', () => {
    const level = makeLevel(['############', '#..........#', '#.A........#', '#####......#', '#####....x.#', '############']);
    const edge = play(startWorld(level), { A: ['walk_to_edge(right)'] });
    expect(bot(edge.world, 'A').x + bot(edge.world, 'A').w).toBe(5 * T);
    const creep = play(startWorld(level), { A: ['creep(right, 10)'] });
    expect(creep.results[0]?.note).toMatch(/stopped at the edge/);
    expect(bot(creep.world, 'A').y).toBe(3 * T);
  });
});

describe('bots and crates', () => {
  it('lets a bot stand on another bot', () => {
    // B stands against a wall; A jumps toward it, the wall stops A above B, and A comes down on B's head.
    const level = makeLevel(['############', '#..........#', '#...#......#', '#...#......#', '#.AB#....x.#', '############']);
    const { world } = play(startWorld(level), { A: ['jump(right, run_up=0, hold=full)'] });
    expect(bot(world, 'A').y).toBe(T + PHYS.botHeight);
    expect(bot(world, 'A').support).toEqual({ kind: 'bot', id: 'B' });
  });

  it('blocks a bot walking into a standing bot, but not one following a moving bot', () => {
    const level = makeLevel(['############', '#..........#', '#..........#', '#.AB.....x.#', '############']);
    const blocked = play(startWorld(level), { A: ['walk(right, 3)'] });
    expect(blocked.results[0]?.reason).toMatch(/blocked by bot B/);
    const follow = play(startWorld(level), { A: ['walk(right, 3)'], B: ['walk(right, 4)'] });
    expect(follow.results.map((r) => r.status)).toEqual(['done', 'done']);
  });

  const CRATE = makeLevel(['##############', '#............#', '#............#', '#.AB.c....x..#', '##############'], {
    c: { type: 'crate', id: 'C1', weight: 1.4 },
  });

  it("won't let one bot push a crate heavier than its strength, and never says how strong the bot is", () => {
    const { results } = play(startWorld(CRATE), { B: ['walk_to(C1)', 'push(right, 2)'] });
    expect(results[1]?.status).toBe('failed');
    expect(results[1]?.reason).toMatch(/crate C1 didn't move: it weighs 1\.40/);
    expect(results[1]?.reason).not.toMatch(/strength/);
  });

  it('lets two bots in a row push it together', () => {
    const { world, results } = play(startWorld(CRATE), {
      B: ['walk_to(C1)', 'wait', 'push(right, 2)'],
      A: ['wait', 'walk_to(B)', 'push(right, 2)'],
    });
    expect(results.filter((r) => r.status !== 'done')).toEqual([]);
    expect(world.crates[0]?.x).toBe(7 * T);
  });
});

describe('switches', () => {
  // A door at x = 7, two tiles tall, with wall above it. The plate is at x = 2.
  const DOORWAY = makeLevel(['##############', '#......#.....#', '#......#.....#', '#............#', '#.pAB..d...x.#', '##############'], {
    p: { type: 'plate', id: 'P1', minBots: 1 },
    d: { type: 'door', id: 'D1', height: 2, openWhen: ['P1'] },
  });

  it('opens a door while its plate is pressed, and closes it when the plate is let go', () => {
    const on = play(startWorld(DOORWAY), { A: ['stand_on_plate'] });
    expect(on.world.plates.P1).toBe(true);
    expect(on.world.doors.D1).toBe(true);
    const off = play(on.world, { A: ['walk(right, 1)'] }); // a whole tile: the bot is 0.75 wide
    expect(off.world.doors.D1).toBe(false);
    expect(off.events.map((e) => e.type)).toEqual(expect.arrayContaining(['plate', 'door']));
  });

  it('never closes a door on a bot standing in the doorway', () => {
    const inDoor = play(startWorld(DOORWAY), { A: ['stand_on_plate'], B: ['walk(right, 3)'] });
    expect(bot(inDoor.world, 'B').x).toBe(7 * T + (T - PHYS.botWidth) / 2); // standing in the doorway
    const plateLetGo = play(inDoor.world, { A: ['walk(right, 1)'] });
    expect(plateLetGo.world.plates.P1).toBe(false);
    expect(plateLetGo.world.doors.D1).toBe(true); // held open by B
    const walkedOut = play(plateLetGo.world, { B: ['walk(right, 2)'] });
    expect(walkedOut.world.doors.D1).toBe(false);
  });

  it('weighs everything on a plate, stacked bots included', () => {
    const PLATE = [
      '############',
      '#..........#',
      '#....#.....#',
      '#....#.....#',
      '#AB.p#..x..#',
      '############',
    ];
    const level = makeLevel(PLATE, { p: { type: 'plate', id: 'P1', minWeight: 1.5 } });
    const alone = play(startWorld(level), { B: ['stand_on_plate'] });
    expect(alone.world.plates.P1).toBe(false); // one bot weighs 1.0
    const stacked = play(alone.world, { A: ['walk(right, 1.5)', 'jump(right, run_up=0, hold=full)'] });
    expect(bot(stacked.world, 'A').support).toEqual({ kind: 'bot', id: 'B' });
    expect(stacked.world.plates.P1).toBe(true); // 1.0 on the plate plus 1.0 on top
  });

  it('flips toggle levers and keeps hold levers on only while held', () => {
    const level = makeLevel(['############', '#..........#', '#..........#', '#.AlB.m..x.#', '############'], {
      l: { type: 'lever', id: 'V1', mode: 'toggle' },
      m: { type: 'lever', id: 'V2', mode: 'hold' },
    });
    const pulled = play(startWorld(level), { A: ['pull_lever'], B: ['walk(right, 2)', 'hold_lever'] });
    expect(pulled.world.levers).toEqual({ V1: true, V2: true });
    // Both changes are events, toggles included (the viewer and the witnesses need them).
    expect(pulled.events.filter((e) => e.type === 'lever').map((e) => e.type === 'lever' && [e.lever, e.on, e.by])).toEqual([
      ['V1', true, 'A'],
      ['V2', true, 'B'],
    ]);
    const letGo = play(pulled.world, { B: ['walk(left, 1)'] });
    expect(letGo.world.levers.V2).toBe(false);
    expect(play(startWorld(level), { A: ['hold_lever'] }).results[0]?.reason).toMatch(/flips: use pull_lever/);
  });

  it('gives a coin to the first bot that touches it', () => {
    const level = makeLevel(['############', '#..........#', '#..........#', '#.A..$...x.#', '############'], { $: { type: 'coin' } });
    const { world, events } = play(startWorld(level), { A: ['walk(right, 5)'] });
    expect(bot(world, 'A').coins).toEqual(['$1']);
    expect(world.coins).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({ type: 'coin', bot: 'A', coin: '$1' }));
  });

  it('lets bots through an exit only while it has places left', () => {
    const level = makeLevel(['############', '#..........#', '#..........#', '#.AB....x..#', '############'], {
      x: { type: 'exit', id: 'X', slots: 1 },
    });
    expect(play(startWorld(level), { A: ['enter_exit'] }).results[0]?.reason).toBe("you're not at an exit");
    const { world, results } = play(startWorld(level), { B: ['walk_to(X)', 'enter_exit'] }, { A: ['walk_to(X)', 'enter_exit'] });
    expect(world.exitOrder).toEqual(['B']);
    expect(results.at(-1)?.reason).toMatch(/exit X is full/);
  });
});

describe('commands that make no sense', () => {
  it('are explained, never punished, and stop the rest of the queue', () => {
    const { results, world } = play(startWorld(makeLevel(ROOM)), { A: ['fly(up)', 'walk(right, 1)'] });
    expect(results[0]).toMatchObject({ status: 'failed' });
    expect(results[0]?.reason).toMatch(/unknown command "fly"/);
    expect(results[1]).toMatchObject({ status: 'skipped' });
    expect(bot(world, 'A').x).toBe(2 * T + (T - PHYS.botWidth) / 2); // never moved
  });
});
