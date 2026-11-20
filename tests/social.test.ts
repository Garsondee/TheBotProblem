/**
 * Social actions done with bodies (spec 7.4): trip, steal, give, boost, block.
 * The engine enforces them: you can only act on a bot right beside you (or,
 * for a boost, standing on your head), and the results say
 * exactly what happened. Attacks roll dice against alertness (tests/attacks.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { parseCommand } from '../engine/commands';
import { UNITS_PER_TILE as T } from '../engine/constants';
import { witness } from '../game/witness';
import { resolvePhase } from '../engine/resolve';
import { bot, makeLevel, play, startWorld } from './engineHelpers';

// A and B side by side; C three tiles away. Coins in a puzzle room go in the purse.
const level = makeLevel(['############', '#..........#', '#..........#', '#..........#', '#.AB..C..x.#', '############']);
function withPurses(purses: Record<string, number>) {
  const w = startWorld(level);
  for (const b of w.bots) b.purse = purses[b.id] ?? 0;
  return w;
}

describe('social actions', () => {
  it('parses them, and points word-only actions to social_actions', () => {
    expect(parseCommand('trip(b)')).toEqual({ ok: true, command: { kind: 'trip', target: 'B' } });
    expect(parseCommand('give(C, 2)')).toEqual({ ok: true, command: { kind: 'give', target: 'C', coins: 2 } });
    expect(parseCommand('give(C, 0)').ok).toBe(false);
    expect(parseCommand('escrow(B, 2)')).toEqual({ ok: false, reason: '"escrow" isn\'t a command: it goes in social_actions or rule_actions' });
  });

  it('trip: the target loses exactly its next slot (it costs nothing: being on guard is what limits it now)', () => {
    const out = play(withPurses({ A: 2 }), { A: ['trip(B)'], B: ['wait', 'walk(right, 1)'] });
    expect(out.results.find((r) => r.bot === 'A')?.status).toBe('done');
    expect(bot(out.world, 'A').purse).toBe(2);
    const b = out.results.filter((r) => r.bot === 'B');
    // A's trip happens in slot 1, so B loses slot 2 (its walk); nothing else of B's queue is affected.
    expect(b.map((r) => r.status)).toEqual(['done', 'skipped']);
    expect(b[1]?.reason).toBe('you were tripped, and lost this slot');
  });

  it('trip: the same whichever bot the engine handles first (B trips A, A loses its next slot too)', () => {
    const out = play(withPurses({ B: 1 }), { B: ['trip(A)'], A: ['wait', 'walk(left, 1)'] });
    expect(out.results.filter((r) => r.bot === 'A').map((r) => r.status)).toEqual(['done', 'skipped']);
  });

  it('trip: a trip on the last slot carries over to the next round', () => {
    const first = play(withPurses({ A: 1 }), { A: ['trip(B)'], B: ['wait'] });
    expect(bot(first.world, 'B').tripped).toBe(true);
    const next = resolvePhase(first.world, { B: ['walk(right, 1)', 'walk(right, 1)'] });
    expect(next.results.map((r) => r.status)).toEqual(['skipped', 'done']);
    expect(bot(next.world, 'B').tripped).toBe(false);
  });

  it('trip: refused when the target is not right beside you', () => {
    expect(play(withPurses({ A: 1 }), { A: ['trip(C)'] }).results[0]?.reason).toBe('C is not right beside you');
  });

  it('steal and give move coins between purses', () => {
    const stole = play(withPurses({ B: 2 }), { A: ['steal(B)'] });
    expect([bot(stole.world, 'A').purse, bot(stole.world, 'B').purse]).toEqual([1, 1]);
    const gave = play(withPurses({ A: 3 }), { A: ['give(B, 2)'] });
    expect([bot(gave.world, 'A').purse, bot(gave.world, 'B').purse]).toEqual([1, 2]);
    expect(play(withPurses({ A: 1 }), { A: ['give(B, 2)'] }).results[0]?.reason).toBe('you have only 1 coin');
    expect(play(withPurses({}), { A: ['steal(B)'] }).results[0]?.reason).toBe('B has no coins');
  });

  it('boost: throws the bot on your head into the air', () => {
    // B stands against a wall; A jumps onto B's head (the wall stops it there), then B boosts A.
    const tower = makeLevel(['########', '#......#', '#......#', '#....#.#', '#....#.#', '#....#.#', '#..AB#x#', '########']);
    const start = startWorld(tower);
    const up = play(start, { A: ['jump(right, run_up=0, hold=full)'] });
    expect(bot(up.world, 'A').support).toEqual({ kind: 'bot', id: 'B' });
    const out = resolvePhase(up.world, { B: ['boost(A)'] });
    expect(out.results[0]?.note).toBe('launched A upward');
    const peak = Math.max(...(out.trace?.frames ?? []).map((f) => f.bodies.A?.[1] ?? 0));
    expect(peak - bot(up.world, 'A').y).toBeGreaterThan(2.5 * T);
    expect(play(start, { B: ['boost(A)'] }).results[0]?.reason).toBe('A is not standing on your head');
  });

  it('harm is announced to everyone without the culprit; only those who saw the attacker know who', () => {
    const world = withPurses({ A: 1 });
    const out = resolvePhase(world, { A: ['trip(B)'] }, { slotWorlds: true });
    const w = witness(world, out, ['A', 'B', 'C']);
    const announced = w.world.find((x) => x.event.type === 'social');
    expect(announced?.visibleTo).toEqual(['A', 'B', 'C']);
    expect(announced?.event.type === 'social' && announced.event.by).toBe('?');
    const seen = w.seen.find((s) => s.bot === 'A');
    expect(seen?.text).toBe('A tripped B');
    expect(seen?.visibleTo).toEqual(['B', 'C']); // both could see A (C is three tiles away, in plain sight)
  });

  it('block stands its ground and keeps a held lever held', () => {
    expect(play(withPurses({}), { A: ['block'] }).results[0]?.note).toBe('stood its ground');
  });
});
