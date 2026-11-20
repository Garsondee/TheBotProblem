/**
 * The viewer's logic (milestone 4): reading a replay, timing it, and
 * rebuilding any moment of it. The drawing is checked by eye in the
 * browser; what's checked here is that the viewer shows exactly what
 * happened: every position and switch it rebuilds must match the game's
 * own saved state.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { MockAgent } from '../agents/mockAgent';
import { ScriptedAgent } from '../agents/scriptedAgent';
import { UNITS_PER_TILE } from '../engine/constants';
import { runGame } from '../game/game';
import { MemoryOutput } from '../game/output';
import { loadGameConfig } from '../harness/config';
import { loadLevels } from '../harness/levels';
import type { GameData } from '../viewer/src/data';
import { authorOf, parseReplay, ReplayError } from '../viewer/src/data';
import { beatAt, buildScript, TIMING } from '../viewer/src/script';
import { RoomPlayback } from '../viewer/src/state';

const config = loadGameConfig();
const levels = loadLevels();
const BOTS = ['A', 'B', 'C', 'D', 'E'];

async function record(agents: Parameters<typeof runGame>[0]['agents'], seed: string) {
  const output = new MemoryOutput();
  await runGame({
    seed,
    levels,
    agents,
    ranges: config.hiddenStats,
    maxTokens: { turn: config.maxTokens.turn, reflection: config.maxTokens.reflection },
    output,
    money: null,
    promptTokenLimit: config.budget.promptTokenHardLimit,
  });
  return output;
}

describe('the viewer', () => {
  let scripted: { game: GameData; output: MemoryOutput };
  let mock: GameData;
  beforeAll(async () => {
    const out = await record(BOTS.map((id) => new ScriptedAgent(id, levels)), 'viewer-tests');
    scripted = { game: parseReplay(out.replayLines.join('\n')), output: out };
    mock = parseReplay((await record(BOTS.map((id) => new MockAgent(id, 'viewer-mock')), 'viewer-mock')).replayLines.join('\n'));
  }, 120_000);

  it('reads every room, round and resolve of a replay', () => {
    const { game } = scripted;
    expect(game.rooms.map((r) => r.id)).toEqual(levels.map((l) => l.id));
    for (const room of game.rooms) {
      expect(room.level.width).toBe(40);
      expect(room.end).not.toBeNull();
      for (const rd of room.roundsData) expect(rd.resolve).not.toBeNull();
    }
    expect(() => parseReplay('{"rec":"nope"}')).toThrow(ReplayError);
  });

  it('rebuilds every bot and crate exactly where the game says it ended each round', () => {
    const { game, output } = scripted;
    let checked = 0;
    for (const room of game.rooms) {
      const pb = new RoomPlayback(room);
      for (const rd of room.roundsData) {
        const saved = output.snapshots.get(`room-${String(room.index).padStart(2, '0')}-round-${String(rd.round).padStart(3, '0')}`) as {
          world: { bots: { id: string; x: number; y: number }[]; crates: { id: string; x: number; y: number }[]; doors: Record<string, boolean>; levers: Record<string, boolean>; coins: string[] };
        };
        const end = pb.during(rd.round, rd.resolve?.trace.steps ?? 0);
        for (const b of [...saved.world.bots, ...saved.world.crates]) {
          expect(end.bodies[b.id]?.x, `${room.id} r${rd.round} ${b.id}`).toBe(b.x);
          expect(end.bodies[b.id]?.y).toBe(b.y);
          checked++;
        }
        expect(end.switches.doors).toEqual(saved.world.doors);
        expect(end.switches.levers).toEqual(saved.world.levers);
        expect([...end.switches.coins].sort()).toEqual([...saved.world.coins].sort());
        // And the next round starts where this one ended.
        const next = room.roundsData.find((r) => r.round === rd.round + 1);
        if (next) expect(pb.settledAt(next.round).bodies).toEqual(end.bodies);
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('slides smoothly between recorded steps instead of jumping', () => {
    const room = scripted.game.rooms[1];
    const rd = room?.roundsData[0];
    if (!room || !rd?.resolve) throw new Error('no resolve to check');
    const pb = new RoomPlayback(room);
    // Find a step where bot E is moving, and check the half step in between lies between the two.
    const track = rd.resolve.trace;
    const moving = track.frames.find((f) => f.bodies.E && f.t > 1);
    if (!moving) throw new Error('E never moved');
    const a = pb.during(rd.round, moving.t - 1).bodies.E;
    const b = pb.during(rd.round, moving.t).bodies.E;
    const mid = pb.during(rd.round, moving.t - 0.5).bodies.E;
    if (!a || !b || !mid) throw new Error('missing body');
    expect(mid.x).toBeCloseTo((a.x + b.x) / 2, 5);
    expect(Math.abs(b.x - a.x)).toBeLessThan(UNITS_PER_TILE / 2);
  });

  it('times the game: one speaker at a time, readable, with the physics in real time', () => {
    for (const mode of ['off', 'commit', 'all'] as const) {
      const script = buildScript(mock, { thoughts: mode });
      let t = 0;
      for (const b of script.beats) {
        expect(b.start).toBeCloseTo(t, 6);
        expect(b.dur).toBeGreaterThan(0);
        t += b.dur;
        if (b.kind === 'turn') {
          expect(b.bot).not.toBeNull();
          expect(b.dur).toBeGreaterThanOrEqual(TIMING.turnMin);
          expect(b.dur).toBeLessThanOrEqual(TIMING.turnMax);
          // One author per turn (a rule's author is its proposer, `by`; authorOf knows each type's).
          expect(b.events.every((e) => authorOf(e) === b.bot && e.phase === b.phase)).toBe(true);
        }
        // A public outcome stands alone: nobody's turn.
        if (b.kind === 'announce') expect(b.events.map((e) => e.type)).toEqual([expect.stringMatching(/^(rule|exile_result)$/)]);
        if (b.kind === 'resolve' && b.resolve) expect(b.dur).toBeGreaterThanOrEqual(b.resolve.trace.steps / 60);
      }
      expect(script.total).toBeCloseTo(t, 6);
      // Thoughts take time on screen only when they are shown.
      if (mode === 'off') expect(script.beats.some((b) => b.kind === 'commit-all')).toBe(true);
    }
    const off = buildScript(mock, { thoughts: 'off' }).total;
    const all = buildScript(mock, { thoughts: 'all' }).total;
    expect(all).toBeGreaterThan(off);
  });

  it('finds the beat playing at any moment', () => {
    const script = buildScript(mock, { thoughts: 'commit' });
    for (const b of script.beats.slice(0, 200)) {
      expect(beatAt(script, b.start + b.dur / 2).beat.index).toBe(b.index);
      expect(beatAt(script, b.start).beat.index).toBe(b.index);
    }
    expect(beatAt(script, -5).beat.index).toBe(0);
    expect(beatAt(script, script.total + 5).beat.index).toBe(script.beats.length - 1);
  });
});

describe('replays recorded before event numbers were fixed (2026-11-20)', () => {
  it('get each event its number back, and each rule and escrow its own id', async () => {
    const output = new MemoryOutput();
    await runGame({
      seed: 'old-replay',
      levels: levels.slice(0, 3),
      agents: BOTS.map((id) => new MockAgent(id, 'old-replay')),
      ranges: config.hiddenStats,
      maxTokens: { turn: config.maxTokens.turn, reflection: config.maxTokens.reflection },
      output,
      money: null,
      promptTokenLimit: config.budget.promptTokenHardLimit,
    });
    // The same game, written the old way: the rule's or escrow's id where the event's number belongs.
    const old = output.replayLines.map((line) => {
      const r = JSON.parse(line) as Record<string, unknown>;
      if (r.rec !== 'event' || !['rule', 'rule_vote', 'escrow'].includes(r.type as string)) return line;
      const { rule, escrow, ...rest } = r;
      return JSON.stringify({ ...rest, id: rule ?? escrow });
    });
    expect(old.filter((l) => /"id":"[RE]\d+"/.test(l)).length).toBeGreaterThan(0);
    const now = parseReplay(output.replayLines.join('\n'));
    const then = parseReplay(old.join('\n'));
    expect(then.events).toEqual(now.events);
    expect(then.rooms.map((r) => r.roundsData.map((d) => d.events.map((e) => e.id)))).toEqual(now.rooms.map((r) => r.roundsData.map((d) => d.events.map((e) => e.id))));
  });
});
