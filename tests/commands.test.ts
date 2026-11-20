import { describe, expect, it } from 'vitest';
import type { Command } from '../engine/commands';
import { formatCommand, parseCommand } from '../engine/commands';

const ok = (text: string): Command => {
  const r = parseCommand(text);
  if (!r.ok) throw new Error(`expected "${text}" to parse, got: ${r.reason}`);
  return r.command;
};
const reason = (text: string): string => {
  const r = parseCommand(text);
  if (r.ok) throw new Error(`expected "${text}" to be refused`);
  return r.reason;
};

describe('parseCommand', () => {
  it("reads the spec's examples", () => {
    expect(ok('walk(right, 2.5)')).toEqual({ kind: 'walk', dir: 'right', tiles: 2.5 });
    expect(ok('jump(right, run_up=2, hold=full)')).toEqual({ kind: 'jump', dir: 'right', runUp: 2, hold: 'full' });
    expect(ok('climb(up)')).toEqual({ kind: 'climb', dir: 'up' });
    expect(ok('wait')).toEqual({ kind: 'wait' });
  });

  it('is forgiving about spacing, capitals, quotes and named arguments', () => {
    expect(ok('  WALK( "left" , 0.25 ) ')).toEqual({ kind: 'walk', dir: 'left', tiles: 0.25 });
    expect(ok('walk(dir=right, tiles=3)')).toEqual({ kind: 'walk', dir: 'right', tiles: 3 });
    expect(ok('jump(up)')).toEqual({ kind: 'jump', dir: 'up', runUp: 0, hold: 'full' });
    expect(ok('jump(left, 3, short)')).toEqual({ kind: 'jump', dir: 'left', runUp: 3, hold: 'short' });
    expect(ok('walk_to(c1)')).toEqual({ kind: 'walk_to', target: 'C1' });
    expect(ok('pull_lever(V1)')).toEqual({ kind: 'pull_lever', target: 'V1' });
    expect(ok('enter_exit;')).toEqual({ kind: 'enter_exit', target: null });
  });

  it('is strict about meaning, and says exactly what is wrong', () => {
    expect(reason('walk(right, 2.3)')).toMatch(/quarter tiles/);
    expect(reason('walk(right, -1)')).toMatch(/positive/);
    expect(reason('walk(right, 99)')).toMatch(/at most 40/);
    expect(reason('walk(up, 2)')).toMatch(/left or right/);
    expect(reason('walk(right)')).toMatch(/needs a distance/);
    expect(reason('jump(right, run_up=5)')).toMatch(/0, 1, 2 or 3/);
    expect(reason('jump(up, run_up=2)')).toMatch(/run-up needs a direction/);
    expect(reason('jump(right, hold=medium)')).toMatch(/short or full/);
    expect(reason('climb(sideways)')).toMatch(/up or down/);
  });

  it('explains unknown commands, and the ones not in the game yet', () => {
    expect(reason('jmp(right)')).toMatch(/unknown command "jmp"/);
    expect(reason('trip(B)')).toMatch(/isn't part of the game yet/);
    expect(reason('walk right 2')).toMatch(/could not read/);
  });

  it('writes commands back in one canonical form', () => {
    for (const text of ['walk(right, 2.5)', 'jump(left, run_up=1, hold=short)', 'walk_to(X)', 'drop', 'pull_lever']) {
      expect(formatCommand(ok(text))).toBe(text);
    }
  });
});
