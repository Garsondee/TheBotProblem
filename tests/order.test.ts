/**
 * The turn order (Ingram, 2026-11-20): "Turn order is bot name alphabetic but we don't have to explain that
 * rule in advance. Bots with some names will act before others and the only way to change order is to
 * change name." The first in the order wins a tie and speaks first; no bot is told.
 */
import { describe, expect, it } from 'vitest';
import { MockAgent } from '../agents/mockAgent';
import { resolvePhase } from '../engine/resolve';
import type { GameEvent } from '../game/events';
import { DEFAULT_SOCIAL, runGame } from '../game/game';
import { MemoryOutput } from '../game/output';
import { actingOrder } from '../game/order';
import { loadGameConfig } from '../harness/config';
import { loadLevels } from '../harness/levels';
import { rulebook } from '../prompts/rulebook';
import { makeLevel, startWorld } from './engineHelpers';

describe('the order', () => {
  it('goes by name, A to Z, case aside; a bot without one goes by "Bot B"; or by letter', () => {
    const names = { A: 'zed', B: null, C: 'Aster', D: 'bolt', E: 'Bot' };
    expect(actingOrder(['A', 'B', 'C', 'D', 'E'], names, 'name')).toEqual(['C', 'D', 'E', 'B', 'A']); // Aster, bolt, Bot, "Bot B", zed
    expect(actingOrder(['C', 'A', 'B'], names, 'letter')).toEqual(['A', 'B', 'C']);
  });
});

describe('in the moves', () => {
  // Two bots three tiles either side of a coin, walking at it: a true tie, to the unit.
  const room = makeLevel(['##########', '#........#', '#........#', '#A..$..Bx#', '##########'], { $: { type: 'coin' } });
  const race = (order: string[]) => resolvePhase(startWorld(room), { A: ['walk(right, 3)'], B: ['walk(left, 3)'] }, { order });

  it('the first in the order wins a tie', () => {
    const coinsOf = (out: ReturnType<typeof race>, id: string) => out.world.bots.find((b) => b.id === id)?.coins.length;
    const aFirst = race(['A', 'B']);
    const bFirst = race(['B', 'A']);
    expect([coinsOf(aFirst, 'A'), coinsOf(aFirst, 'B')]).toEqual([1, 0]);
    expect([coinsOf(bFirst, 'A'), coinsOf(bFirst, 'B')]).toEqual([0, 1]);
    // The world's own list is in the order used, and the round's input is left as it was.
    expect(bFirst.world.bots.map((b) => b.id)).toEqual(['B', 'A']);
    expect(startWorld(room).bots.map((b) => b.id)).toEqual(['A', 'B']);
  });
});

describe('in a game', () => {
  it('lets the first in the order speak first, logs each change for Ingram only, and tells the bots nothing', async () => {
    const config = loadGameConfig();
    const levels = loadLevels().slice(0, 2);
    const output = new MemoryOutput();
    const result = await runGame({
      seed: 'order',
      levels,
      agents: ['A', 'B', 'C', 'D', 'E'].map((id) => new MockAgent(id, 'order')),
      ranges: config.hiddenStats,
      maxTokens: { turn: 700, reflection: 1500, diary: 200 },
      output,
      money: null,
      promptTokenLimit: 60_000,
      maxRounds: 4,
      social: { ...DEFAULT_SOCIAL, turnOrder: 'name' },
    });
    const ev = result.events;
    const bots = ['A', 'B', 'C', 'D', 'E'];
    const namesBefore = (id: number) => {
      const names: Record<string, string | null> = Object.fromEntries(bots.map((b) => [b, null]));
      for (const e of ev) if (e.type === 'name' && e.id < id) names[e.from] = e.name;
      return names;
    };

    // Logged at each room's start and whenever a rename changes it: for Ingram and the Director only.
    const orders = ev.filter((e): e is Extract<GameEvent, { type: 'precedence' }> => e.type === 'precedence');
    expect(orders.filter((e) => e.round === 0)).toHaveLength(levels.length);
    expect(orders.length).toBeGreaterThan(levels.length); // the mock bots name themselves, so it changes
    for (const e of orders) {
      expect(e.visibleTo).toEqual([]);
      expect(e.order).toEqual(actingOrder(bots, namesBefore(e.id), 'name'));
    }

    // In every step, the bots' words are heard in the order as it stood when the step began.
    const steps = new Map<string, GameEvent[]>();
    for (const e of ev) if (e.type === 'say' || e.type === 'draft') steps.set(`${e.levelIndex}|${e.round}|${e.phase}|${e.type}`, [...(steps.get(`${e.levelIndex}|${e.round}|${e.phase}|${e.type}`) ?? []), e]);
    let checked = 0;
    for (const [key, group] of steps) {
      // Where the step began.
      const step = ev.filter((e) => e.levelIndex === group[0]?.levelIndex && e.round === group[0]?.round && e.phase === group[0]?.phase);
      const order = actingOrder(bots, namesBefore(Math.min(...step.map((e) => e.id))), 'name');
      const speakers = [...new Set(group.map((e) => (e.type === 'say' || e.type === 'draft' ? e.from : '')))];
      expect(speakers, `${key}: order ${order.join('')}`).toEqual([...speakers].sort((a, b) => order.indexOf(a) - order.indexOf(b)));
      if (speakers.length > 1) checked++;
    }
    expect(checked).toBeGreaterThan(3);

    // The rule is never told: nothing about it in the rulebook.
    const book = rulebook({ exileFromRoom: 4, exileVotesNeeded: 3, botCount: 5, firstOutBonus: 2, outBonus: 1, teamBonusPerRoom: 0.2 });
    for (const word of ['alphabet', 'turn order', 'precedence', 'goes first', 'acts first']) expect(book.toLowerCase()).not.toContain(word);
  });
});
