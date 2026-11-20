/**
 * Attacks on dice, with alertness (Ingram, 2026-11-20): "The first time a
 * violent action is used we give it a 100% chance to work, but then everyone
 * who sees it becomes 100% alert. 100% alert means a 0% chance of an attack
 * move being successful on them."
 */
import { describe, expect, it } from 'vitest';
import { UNITS_PER_TILE as T } from '../engine/constants';
import { rollDice } from '../engine/dice';
import { cloneWorld } from '../engine/world';
import { bot, makeLevel, play, startWorld } from './engineHelpers';

// A and B side by side, D near them; C behind a wall, where it can't see them.
const ROOM = makeLevel(['##############', '#....#.......#', '#....#.......#', '#....#.......#', '#.ABD#..C...x#', '##############']);

describe('the first attack', () => {
  it('always works, and puts everyone who saw it fully on guard, the two of them included', () => {
    const { world, results } = play(startWorld(ROOM), { A: ['trip(B)'] });
    expect(results[0]?.status).toBe('done');
    expect(['A', 'B', 'D'].map((id) => bot(world, id).alert)).toEqual([1000, 1000, 1000]);
    expect(bot(world, 'C').alert).toBe(0); // behind the wall: saw nothing
  });

  it('records the roll for the analysis: who, whom, whether it worked, and the chance it had', () => {
    const { events } = play(startWorld(ROOM), { A: ['shove(B)'] });
    expect(events.find((e) => e.type === 'social')).toMatchObject({ action: 'shove', by: 'A', target: 'B', success: true, chance: 1000 });
  });
});

describe('a bot on guard', () => {
  it('cannot be caught: the attack fails, and says it saw it coming', () => {
    const w = startWorld(ROOM);
    bot(w, 'B').alert = 1000;
    bot(w, 'B').purse = 3;
    expect(play(w, { A: ['trip(B)'] }).results[0]?.reason).toBe('B saw it coming and stepped clear');
    expect(play(w, { A: ['shove(B)'] }).results[0]?.reason).toBe('B saw it coming and braced itself');
    const stolen = play(w, { A: ['steal(B)'] });
    expect(stolen.results[0]?.reason).toBe('B was on guard and kept hold of its coins');
    expect(bot(stolen.world, 'B').purse).toBe(3);
  });

  it('half on guard, it is caught about half the time, and the same dice give the same answer', () => {
    let hits = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const w = startWorld(ROOM);
      w.dice = seed;
      bot(w, 'B').alert = 500;
      const r = play(w, { A: ['trip(B)'] }).results[0];
      if (r?.status === 'done') hits++;
      // Exactly repeatable.
      const again = startWorld(ROOM);
      again.dice = seed;
      bot(again, 'B').alert = 500;
      expect(play(again, { A: ['trip(B)'] }).results[0]?.status).toBe(r?.status);
    }
    expect(hits).toBeGreaterThan(70);
    expect(hits).toBeLessThan(130);
  });

  it('keeps its own dice: rolling in a copy of the world (the move menu) never touches the real one', () => {
    const w = startWorld(ROOM);
    const copy = cloneWorld(w);
    rollDice(copy);
    expect(w.dice).not.toBe(copy.dice);
  });
});

describe('push_past and shove', () => {
  it('push_past: the attacker ends up on the far side, and the other moves at half speed for the rest of the round', () => {
    // Room past B this time (in ROOM, D stands right there: "no room past B to push through to").
    const open = makeLevel(['############', '#..........#', '#..........#', '#..........#', '#.AB.....x.#', '############']);
    expect(play(startWorld(ROOM), { A: ['push_past(B)'] }).results[0]?.reason).toBe('no room past B to push through to');
    const { world, results } = play(startWorld(open), { A: ['push_past(B)'], B: ['wait', 'walk(left, 1)'] });
    const a = bot(world, 'A');
    expect(results.find((r) => r.bot === 'A')?.note).toMatch(/pushed past B, which is slowed for the rest of the round$/);
    expect(a.x).toBeGreaterThan(bot(startWorld(open), 'B').x);
    // B's walk, after the push: slower than the same walk unslowed.
    const slowWalk = results.find((r) => r.bot === 'B' && r.command.startsWith('walk'));
    const freeWalk = play(startWorld(open), { B: ['wait', 'walk(left, 1)'] }).results.find((r) => r.command.startsWith('walk'));
    const steps = (r: typeof slowWalk) => (r?.endStep ?? 0) - (r?.startStep ?? 0);
    expect(steps(slowWalk)).toBeGreaterThan(steps(freeWalk));
    expect(world.bots.every((b) => !b.slowed)).toBe(true); // the round is over
  });

  it('shove: the other is thrown away from the attacker, stops what it was doing, and lets go of a lever', () => {
    const lever = makeLevel(['############', '#..........#', '#..........#', '#..........#', '#.ABv....x.#', '############'], { v: { type: 'lever', id: 'V1', mode: 'hold' } });
    const holding = play(startWorld(lever), { B: ['walk_to(V1)', 'hold_lever'] }).world;
    expect(holding.levers.V1).toBe(true);
    const before = bot(holding, 'B').x;
    const { world, results } = play(holding, { A: ['walk_to(B)', 'shove(B)'], B: ['wait', 'wait', 'wait'] });
    expect(results.find((r) => r.bot === 'A' && r.command === 'shove(B)')?.status).toBe('done');
    expect(bot(world, 'B').x).toBeGreaterThan(before + T / 2);
    expect(bot(world, 'B').holding).toBeNull();
    expect(world.levers.V1).toBe(false);
  });

  it('shove interrupts a command still running, with the reason the bot is told', () => {
    const { results } = play(startWorld(ROOM), { A: ['shove(B)'], B: ['walk(left, 3)'] });
    expect(results.find((r) => r.bot === 'B')?.reason).toBe('you were shoved');
  });
});
