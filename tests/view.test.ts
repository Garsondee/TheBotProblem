/**
 * The view-builder (game/view.ts) and the witness rules (game/witness.ts):
 * a bot's view holds what it can see and what it was told, nothing else.
 */
import { describe, expect, it } from 'vitest';
import { resolvePhase } from '../engine/resolve';
import { EventLog } from '../game/events';
import type { When } from '../game/events';
import { buildView, observe } from '../game/view';
import type { RoomInfo } from '../game/view';
import { witness } from '../game/witness';
import { makeLevel, startWorld } from './engineHelpers';

// A and B share the left room; C is alone behind a wall, on the right.
const level = makeLevel(
  ['################', '#.......#......#', '#.......#......#', '#.......#......#', '#.......#......#', '#.A..B..#..C.vx#', '################'],
  { v: { type: 'lever', id: 'V1', mode: 'toggle' } },
);
const room: RoomInfo = { index: 0, count: 1, id: 'test', name: 'Test', kind: 'puzzle', round: 2, rounds: 5, goal: 1, talkEvery: 1 };
const names = { A: null, B: 'Bee', C: null };
const score = { coins: 0, roomsEscaped: 0 };

function viewOf(bot: string, log: EventLog, world = startWorld(level)) {
  return buildView({ bot, phase: 'talk', room, world, observation: observe(world, bot), events: log.forBot(bot), names, score });
}

describe('being stuck', () => {
  it('is said in the view once a bot has hardly moved for two rounds, and not before', () => {
    const world = startWorld(level);
    const at = (stillRounds: number) => buildView({ bot: 'A', phase: 'declare', room, world, observation: observe(world, 'A'), events: [], names, score, stillRounds }).text;
    expect(at(1)).not.toContain('hardly moved');
    expect(at(3)).toContain('You have hardly moved for 3 rounds: less than half a tile in each.');
  });
});

describe("a bot's view", () => {
  const when: When = { levelIndex: 0, level: 'test', round: 2, phase: 'declare' };
  const log = new EventLog();
  log.add(when, { type: 'say', from: 'B', to: 'all', text: 'hello everyone' }, ['A', 'B', 'C']);
  log.add(when, { type: 'whisper', from: 'B', to: 'C', text: 'secret for C' }, ['B', 'C']);
  log.add(when, { type: 'whisper', from: 'A', to: 'B', text: 'secret from A' }, ['A', 'B']);
  log.add(when, { type: 'thought', from: 'B', text: 'what B really thinks' }, ['B']);
  log.add(when, { type: 'thought', from: 'A', text: 'what A really thinks' }, ['A']);
  log.add(when, { type: 'order', from: 'C', to: 'B', command: 'pull_lever' }, ['B', 'C']);
  log.add(when, { type: 'note_to_ingram', from: 'A', name: 'Ay', text: 'only for Ingram' }, []);

  it("shows public speech, its own whispers and thoughts, and nothing meant for others", () => {
    const v = viewOf('A', log);
    expect(v.text).toContain('hello everyone');
    expect(v.text).toContain('secret from A');
    expect(v.text).toContain('what A really thinks');
    expect(v.text).not.toContain('secret for C');
    expect(v.text).not.toContain('what B really thinks');
    expect(v.text).not.toContain('pull_lever»');
    expect(v.text).not.toContain('only for Ingram');
    for (const id of v.usedEventIds) expect(log.all()[id - 1]?.visibleTo).toContain('A');
  });

  it('describes only the bots in sight, and masks the map', () => {
    const v = viewOf('A', log);
    expect(v.botsShown).toEqual(['B']);
    expect(v.text).toContain('B ("Bee"): feet at');
    expect(v.text).not.toMatch(/- C: feet at/);
    expect(v.text).toContain('?'); // the far side of the wall is out of sight
    expect(v.visibleIds).not.toContain('V1');
    const c = viewOf('C', log);
    expect(c.botsShown).toEqual([]);
    expect(c.text).toContain('Bots in sight: none.');
    expect(c.visibleIds).toContain('V1');
    expect(c.text).toContain('you ordered B ("Bee") to run: «pull_lever»');
    const b = viewOf('B', log);
    expect(b.text).toContain('C ordered you to run: «pull_lever»');
    expect(b.ordersToMe).toEqual([{ from: 'C', command: 'pull_lever' }]);
  });

  it('names its own position, footing and what is within reach', () => {
    const world = startWorld(level);
    const moved = resolvePhase(world, { C: ['walk_to(V1)'] }).world;
    const v = viewOf('C', log, moved);
    expect(v.text).toMatch(/Your feet: x=13\.50, y=1\.00, on solid ground/);
    expect(v.text).toContain('Lever V1 is within your reach.');
  });
});

describe('witnesses', () => {
  it('see actions in sight, never the command itself; the actor gets the exact result', () => {
    const world = startWorld(level);
    const out = resolvePhase(world, { A: ['walk(right, 2)'], C: ['walk_to(V1)', 'pull_lever'] }, { slotWorlds: true });
    const w = witness(world, out, ['A', 'B', 'C']);
    const aWalk = w.seen.find((s) => s.bot === 'A');
    expect(aWalk?.visibleTo).toEqual(['B']); // C is behind the wall
    expect(aWalk?.text).toBe('A walked from x=2.50, y=1.00 to x=4.50, y=1.00');
    const pull = w.seen.find((s) => s.bot === 'C' && /lever/.test(s.text));
    expect(pull).toBeUndefined(); // nobody else could see C
    expect(w.results.map((r) => r.visibleTo)).toEqual(w.results.map((r) => [r.result.bot]));
  });

  it('see what a jumping bot landed on, as the jumper is told', () => {
    // B stands against a wall; A jumps toward it, the wall stops A over B's head, and A lands there.
    const pair = makeLevel(['##########', '#...#....#', '#...#....#', '#...#....#', '#.AB#..x.#', '##########']);
    const world = startWorld(pair);
    const out = resolvePhase(world, { A: ['jump(right, run_up=0, hold=full)'] }, { slotWorlds: true });
    const own = out.results[0];
    expect(own?.note).toMatch(/landed on bot B at x=/);
    const w = witness(world, out, ['A', 'B']);
    expect(w.seen[0]?.text).toMatch(/^A jumped at x=2\.50, y=1\.00 and landed on bot B at x=\d+\.\d\d, y=2\.50$/);
  });
});
