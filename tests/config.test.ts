import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CastSchema, configProblems, loadCast, loadGameConfig, loadPrices, PATHS } from '../harness/config';

const castFiles = readdirSync(PATHS.configDir)
  .filter((name) => /^cast(\..+)?\.json$/.test(name))
  .map((name) => join(PATHS.configDir, name));

describe('the files in config/', () => {
  it('all load and pass their schemas', () => {
    expect(() => loadGameConfig()).not.toThrow();
    expect(castFiles.length).toBeGreaterThanOrEqual(3);
    for (const file of castFiles) expect(() => loadCast(file), file).not.toThrow();
    expect(Object.keys(loadPrices().table)).toEqual(expect.arrayContaining(['claude-haiku-5-5', 'claude-sonnet-5-5']));
  });

  it('keep the prompt hard limit below every long-context price step', () => {
    expect(configProblems(loadGameConfig(), loadPrices().table)).toEqual([]);
  });

  it('have a price for every model in every cast', () => {
    const { table } = loadPrices();
    for (const file of castFiles) {
      for (const seat of loadCast(file).seats) {
        if (seat.provider !== 'mock') expect(table[seat.model], `${seat.model} in ${file}`).toBeDefined();
      }
    }
  });

  it('give every OpenRouter seat a price ceiling, so its worst case is known', () => {
    for (const file of castFiles) {
      for (const seat of loadCast(file).seats) {
        if (seat.provider === 'openrouter') expect(seat.priceCeiling, `${seat.botId} in ${file}`).toBeDefined();
      }
    }
  });

  it('reject a cast where two seats share a bot id', () => {
    const seat = { botId: 'A', model: 'claude-haiku-5-5', provider: 'anthropic', caching: 'explicit' };
    expect(CastSchema.safeParse({ name: 'x', seats: [seat, seat] }).success).toBe(false);
  });
});
