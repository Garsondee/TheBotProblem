/**
 * Loading and checking the files in config/.
 *
 * Every file is checked against a schema as it loads, so a typo in a config
 * file stops the program with a message naming the file and the field,
 * instead of becoming a wrong number halfway through a paid run.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { PriceTable } from '../budget/prices';
import { PriceFileSchema, hardLimitProblems } from '../budget/prices';
import type { Caps } from '../budget/spendGuard';
import { readJsonFile } from './files';

/** The project folder, worked out from this file's location, so scripts work from any directory. */
export const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));

export const PATHS = {
  game: join(PROJECT_ROOT, 'config', 'game.json'),
  prices: join(PROJECT_ROOT, 'config', 'prices.json'),
  openrouterPrices: join(PROJECT_ROOT, 'config', 'openrouter-prices.json'),
  cast: join(PROJECT_ROOT, 'config', 'cast.json'),
  configDir: join(PROJECT_ROOT, 'config'),
  runs: join(PROJECT_ROOT, 'runs'),
};

const Usd = z.number().nonnegative();
const Count = z.number().int().positive();

export const GameConfigSchema = z.object({
  $comment: z.string().optional(),
  budget: z.object({
    runCapUsd: Usd,
    perBotCapUsd: Usd,
    globalCapUsd: z.object({ anthropic: Usd, openrouter: Usd }),
    promptTokenHardLimit: Count,
    spendFile: z.string().min(1),
  }),
  hiddenStats: z.object({
    $comment: z.string().optional(),
    runSpeed: z.number().min(0).max(0.5),
    jumpHeight: z.number().min(0).max(0.5),
    jumpDistance: z.number().min(0).max(0.5),
    weight: z.number().min(0).max(0.5),
    strength: z.number().min(0).max(0.5),
    sightRange: z.number().min(0).max(0.5),
  }),
  maxTokens: z.object({ turn: Count, reflection: Count, diary: Count, finalMessage: Count }),
  /** The social systems (spec section 7). */
  social: z
    .object({
      $comment: z.string().optional(),
      /** The room (0 = the practice room) from which the exile vote can be called. Spec: "Exile ray unlocks at level 3". */
      exileFromRoom: z.number().int().min(0).default(3),
      /** Yes ballots an exile needs. Spec: "default 3 of 5". */
      exileVotesNeeded: Count.default(3),
      firstOutBonus: z.number().min(0).default(2),
      outBonus: z.number().min(0).default(1),
      /** The team's success multiplies everyone's score: 1 + this x rooms completed. */
      teamBonusPerRoom: z.number().min(0).default(0.2),
    })
    .default({ exileFromRoom: 3, exileVotesNeeded: 3, firstOutBonus: 2, outBonus: 1, teamBonusPerRoom: 0.2 }),
  /** The Director (analysis/director.ts): a cheap model reads each room, a stronger one edits the story. */
  director: z
    .object({
      $comment: z.string().optional(),
      roomModel: z.string().min(1).default('claude-haiku-5-5'),
      editModel: z.string().min(1).default('claude-sonnet-5-5'),
      roomMaxTokens: Count.default(3000),
      editMaxTokens: Count.default(7000),
      /** The most one directing may spend. Spec 8.1 expects $0.05-0.15 a game. */
      capUsd: Usd.default(0.3),
    })
    .default({ roomModel: 'claude-haiku-5-5', editModel: 'claude-sonnet-5-5', roomMaxTokens: 3000, editMaxTokens: 7000, capUsd: 0.3 }),
  estimate: z.object({
    $comment: z.string().optional(),
    levels: Count,
    roundsPerLevel: Count,
    turnCallsPerRound: Count,
    turnPromptTokens: Count,
    turnCacheableTokens: Count,
    turnOutputTokens: Count,
    reflectionPromptTokens: Count,
    reflectionOutputTokens: Count,
    diaryPromptTokens: Count,
    diaryOutputTokens: Count,
    finalMessagePromptTokens: Count,
    finalMessageOutputTokens: Count,
    cacheWritesPerGame: z.number().int().nonnegative(),
  }),
});
export type GameConfig = z.infer<typeof GameConfigSchema>;

export const SeatSchema = z.object({
  botId: z.string().regex(/^[A-Z]$/, 'bot ids are single capital letters, A to Z'),
  model: z.string().min(1),
  provider: z.enum(['anthropic', 'openrouter', 'mock']),
  caching: z.enum(['explicit', 'automatic', 'none']),
  /** This seat's own per-bot cap, when it needs a different one (a Sonnet seat costs more). */
  capUsd: Usd.optional(),
  /**
   * OpenRouter seats: the most OpenRouter may charge, in US dollars per
   * million tokens. One OpenRouter model is served by many providers at very
   * different prices; paid calls send this as provider.max_price so OpenRouter
   * never routes to a pricier one, and the spend guard reserves calls at it.
   */
  priceCeiling: z.object({ input: Usd, output: Usd }).optional(),
  /**
   * Seats whose provider caches on its own ("automatic"): the share of each
   * prompt measured coming from the cache in real games. Used only for the
   * expected cost; the worst case still assumes no cache at all.
   */
  measuredCacheShare: z.number().min(0).max(1).optional(),
  /** The model's tokens for each token Claude's counter reports on the same prompt (measured; expected cost only). */
  tokenRatio: z.number().positive().max(3).optional(),
  /** A lasting id for the agent in this seat, so its memory follows it from game to game (game/memory.ts). */
  agent: z.string().optional(),
  note: z.string().optional(),
});
export type Seat = z.infer<typeof SeatSchema>;

export const CastSchema = z
  .object({
    $comment: z.string().optional(),
    name: z.string().min(1),
    seats: z.array(SeatSchema).min(1).max(8),
  })
  .refine((cast) => new Set(cast.seats.map((s) => s.botId)).size === cast.seats.length, 'every seat needs its own botId');
export type Cast = z.infer<typeof CastSchema>;

export function loadGameConfig(path = PATHS.game): GameConfig {
  return readJsonFile(path, GameConfigSchema);
}

export function loadCast(path = PATHS.cast): Cast {
  return readJsonFile(path, CastSchema);
}

export interface PriceSource {
  file: string;
  checkedOn: string;
  models: string[];
}

/** Anthropic prices plus the OpenRouter snapshot, if `npm run prices` has made one. */
export function loadPrices(): { table: PriceTable; sources: PriceSource[] } {
  const table: PriceTable = {};
  const sources: PriceSource[] = [];
  for (const file of [PATHS.prices, PATHS.openrouterPrices]) {
    if (!existsSync(file)) continue;
    const loaded = readJsonFile(file, PriceFileSchema);
    Object.assign(table, loaded.models);
    sources.push({ file, checkedOn: loaded.checkedOn, models: Object.keys(loaded.models) });
  }
  return { table, sources };
}

/** A run's spend caps: game.json's, plus any per-seat cap from the cast. */
export function capsFor(game: GameConfig, cast: Cast): Caps {
  const perBotOverrideUsd: Record<string, number> = {};
  for (const seat of cast.seats) {
    if (seat.capUsd !== undefined) perBotOverrideUsd[seat.botId] = seat.capUsd;
  }
  return {
    runUsd: game.budget.runCapUsd,
    perBotUsd: game.budget.perBotCapUsd,
    perBotOverrideUsd,
    globalUsd: { ...game.budget.globalCapUsd },
  };
}

/** Config problems that must stop a paid run before it starts. */
export function configProblems(game: GameConfig, prices: PriceTable): string[] {
  return hardLimitProblems(prices, game.budget.promptTokenHardLimit);
}
