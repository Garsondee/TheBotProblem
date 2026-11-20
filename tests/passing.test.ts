/**
 * Ways past each other (Ingram, 2026-11-20: "Give bots access to tools like
 * positional swapping if both agree, jumping over each other with controlled
 * jumps, crouching to become half their normal height"). In the real games,
 * about one command in ten failed on another bot in the way.
 */
import { describe, expect, it } from 'vitest';
import { PHYS, UNITS_PER_TILE as T } from '../engine/constants';
import { bot, makeLevel, play, startWorld } from './engineHelpers';

// A long open floor: A and B side by side, C further on.
const OPEN = ['##############', '#............#', '#............#', '#............#', '#..AB.....C.x#', '##############'];

describe('swap', () => {
  it('trades the places of two bots that both command it in the same slot: one hops, the other walks under', () => {
    const start = startWorld(makeLevel(OPEN));
    const a0 = bot(start, 'A').x;
    const b0 = bot(start, 'B').x;
    const { world, results } = play(start, { A: ['swap(B)'], B: ['swap(A)'] });
    expect(results.map((r) => r.status)).toEqual(['done', 'done']);
    expect(results[0]?.note).toMatch(/^swapped places with B/);
    expect(bot(world, 'A').x).toBe(b0);
    expect(bot(world, 'B').x).toBe(a0);
    expect(bot(world, 'A').y).toBe(bot(world, 'B').y); // both back on the floor, nobody on anyone's head
    expect(world.bots.every((b) => b.passThrough === null)).toBe(true);
  });

  it('needs both: alone, or out of step, it fails and nobody moves', () => {
    const start = startWorld(makeLevel(OPEN));
    const alone = play(start, { A: ['swap(B)'], B: ['wait'] });
    expect(alone.results.find((r) => r.bot === 'A')?.reason).toBe("B didn't command swap(A) in this slot");
    expect(bot(alone.world, 'A').x).toBe(bot(start, 'A').x);
    // B agrees one slot too late: still no.
    const late = play(start, { A: ['swap(B)'], B: ['wait', 'swap(A)'] });
    expect(late.results.filter((r) => r.command.startsWith('swap')).map((r) => r.status)).toEqual(['failed', 'failed']);
  });

  it('only works side by side', () => {
    const { results } = play(startWorld(makeLevel(OPEN)), { A: ['swap(C)'], C: ['swap(A)'] });
    expect(results.find((r) => r.bot === 'A')?.reason).toBe("C isn't right beside you on your floor");
    expect(results.find((r) => r.bot === 'C')?.reason).toBe("A isn't right beside you on your floor");
  });
});

describe('hop_over', () => {
  it('jumps a bot beside you and lands just past it', () => {
    const start = startWorld(makeLevel(OPEN));
    const { world, results } = play(start, { A: ['hop_over(B)'] });
    expect(results[0]?.status).toBe('done');
    expect(results[0]?.note).toMatch(/^hopped over B: .*landed on solid ground/);
    const a = bot(world, 'A');
    const b = bot(world, 'B');
    expect(a.x).toBeGreaterThanOrEqual(b.x + b.w);
    expect(a.x - (b.x + b.w)).toBeLessThan(T / 2); // close past it, not far away
    expect(b.x).toBe(bot(start, 'B').x);
  });

  it('says why when it can not: no room to land, no room above, nobody beside you', () => {
    // A wall right behind B.
    const walled = makeLevel(['########', '#......#', '#......#', '#......#', '#x.AB###', '########']);
    expect(play(startWorld(walled), { A: ['hop_over(B)'] }).results[0]?.reason).toBe('no room to land past B');
    // A low ceiling: two tiles of room, not enough to cross a 1.5-tile bot.
    const low = makeLevel(['##########', '##########', '#........#', '#..AB...x#', '##########']);
    expect(play(startWorld(low), { A: ['hop_over(B)'] }).results[0]?.reason).toBe('not enough room above B to hop over it');
    expect(play(startWorld(makeLevel(OPEN)), { A: ['hop_over(C)'] }).results[0]?.reason).toBe("C isn't right beside you on your floor");
  });
});

describe('crouch and stand', () => {
  it('halves the height, creeps, and keeps the bot from jumping until it stands', () => {
    const start = startWorld(makeLevel(OPEN));
    const crouched = play(start, { A: ['crouch'] });
    const a = bot(crouched.world, 'A');
    expect(a.crouched).toBe(true);
    expect(a.h).toBe(Math.round(PHYS.botHeight / 2));
    expect(a.anim).toBe('crouch');
    expect(play(crouched.world, { A: ['jump(up, run_up=0, hold=full)'] }).results[0]?.reason).toBe("you're crouching: stand up first");
    // Crouched, a walk is a creep: the same distance takes longer.
    const walkSteps = (w: typeof start) => {
      const r = play(w, { A: ['walk(left, 1)'] }).results[0];
      return (r?.endStep ?? 0) - (r?.startStep ?? 0);
    };
    expect(walkSteps(crouched.world)).toBeGreaterThan(walkSteps(start));
    const stood = play(crouched.world, { A: ['stand'] });
    expect(bot(stood.world, 'A').h).toBe(PHYS.botHeight);
  });

  it('gets a bot through a gap one tile high, and it can only stand up where there is room', () => {
    // The passage between x=5 and x=9 is one tile high.
    const tunnel = makeLevel(['############', '#..........#', '#..........#', '#....####..#', '#.A.......x#', '############']);
    const blocked = play(startWorld(tunnel), { A: ['walk(right, 5)'] });
    expect(blocked.results[0]?.reason).toMatch(/^blocked by/);
    const { world, results } = play(startWorld(tunnel), { A: ['crouch', 'walk(right, 4)', 'stand'] });
    expect(results.map((r) => r.status)).toEqual(['done', 'done', 'failed']);
    expect(results[2]?.reason).toMatch(/^no room to stand up here/);
    expect(bot(world, 'A').x + bot(world, 'A').w / 2).toBe(6.5 * T);
  });
});
