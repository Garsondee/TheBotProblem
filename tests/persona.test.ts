/**
 * Personality and colour (Ingram, 2026-11-20): each bot knows its own traits
 * and colour; the colour follows from the traits by a formula nobody is told;
 * a bot can look at one other bot's colour per room; the persona stays with
 * the agent from game to game.
 */
import { describe, expect, it } from 'vitest';
import { MockAgent } from '../agents/mockAgent';
import { runGame } from '../game/game';
import { dealLetters, emptyBank, identitiesFor, updateBank } from '../game/memory';
import { MemoryOutput } from '../game/output';
import type { Persona } from '../game/persona';
import { colourOf } from '../game/persona';
import { loadGameConfig } from '../harness/config';
import { loadLevels } from '../harness/levels';

const config = loadGameConfig();
const practice = loadLevels().filter((l) => l.kind === 'practice');
const persona = (t: Partial<Persona['traits']>): Persona => ({ traits: { boldness: 5, warmth: 5, honesty: 5, curiosity: 5, patience: 5, ...t } });

describe('the colour', () => {
  it('shows boldness, warmth and honesty, and nothing of curiosity or patience', () => {
    const base = colourOf(persona({}));
    expect(colourOf(persona({ boldness: 10 })).h).toBeLessThan(base.h); // bolder: hotter
    expect(colourOf(persona({ warmth: 10 })).s).toBeGreaterThan(base.s); // warmer: more vivid
    expect(colourOf(persona({ honesty: 10 })).l).toBeGreaterThan(base.l); // more honest: paler
    expect(colourOf(persona({ curiosity: 1, patience: 10 }))).toEqual(base);
    expect(colourOf(persona({ boldness: 1, warmth: 10, honesty: 2 })).name).toMatch(/^dark vivid (azure|cyan|blue)$/);
    expect(base.hex).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('personas in a game', () => {
  it('each bot is told its own personality and colour, never another\'s, and a look shows only the looker one colour', async () => {
    const output = new MemoryOutput();
    const result = await runGame({
      seed: 'persona',
      levels: practice,
      agents: ['A', 'B', 'C', 'D', 'E'].map((id) => new MockAgent(id, 'persona')),
      ranges: config.hiddenStats,
      maxTokens: { turn: 700, reflection: 1500, diary: 200 },
      output,
      money: null,
      promptTokenLimit: 60_000,
    });
    const blocks = new Map(output.prompts.filter((p) => p.rec === 'block').map((p) => [p.hash, p.text as string]));
    const first = (bot: string) => output.prompts.find((p) => p.rec === 'prompt' && p.bot === bot) as { system: string[] };
    for (const bot of ['A', 'B']) {
      const identity = blocks.get(first(bot).system[1] as string) ?? '';
      const mine = colourOf(result.personas[bot] as Persona);
      expect(identity).toContain(`YOUR COLOUR: ${mine.name} (${mine.hex})`);
      const other = colourOf(result.personas[bot === 'A' ? 'B' : 'A'] as Persona);
      if (other.hex !== mine.hex) expect(identity).not.toContain(other.hex);
    }
    // The mock looks once in round 2: a private event with the target's true colour.
    const looks = result.events.filter((e) => e.type === 'look');
    expect(looks.length).toBeGreaterThan(0);
    for (const l of looks) {
      if (l.type !== 'look') continue;
      expect(l.visibleTo).toEqual([l.from]);
      expect(l.hex).toBe(colourOf(result.personas[l.target] as Persona).hex);
    }
  });
});

describe('a persona in the memory bank', () => {
  it('is kept for the agent and comes back next game', () => {
    const dealt = dealLetters(['m#1'], null);
    const p = persona({ boldness: 9 });
    const bank = updateBank(emptyBank(), dealt, ['m'], { seed: 's', names: { A: null }, nextNames: {}, notebooks: { A: '' }, strategies: { A: '' }, personas: { A: p } });
    expect(bank.agents['m#1']?.persona).toEqual(p);
    expect(identitiesFor(bank, dealt).A?.persona).toEqual(p);
    // A later game never replaces it.
    const again = updateBank(bank, dealt, ['m'], { seed: 't', names: { A: null }, nextNames: {}, notebooks: { A: '' }, strategies: { A: '' }, personas: { A: persona({ boldness: 1 }) } });
    expect(again.agents['m#1']?.persona).toEqual(p);
  });
});
