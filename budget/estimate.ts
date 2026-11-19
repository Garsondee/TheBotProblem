/**
 * Cost projection: what a whole game should cost, before paying for one.
 *
 * Two numbers per seat:
 *   expected    typical reply lengths, with the prompt cache working as planned
 *   worst case  every reply as long as max_tokens allows, and nothing ever read
 *               from the cache. The run cap is what protects you from this.
 *
 * Until milestone 3 builds real prompts, token counts come from the spec's
 * assumptions, kept in config/game.json ("about 6,800 input tokens per call
 * (5,000 cacheable) and 400 output tokens"). From milestone 3 on, the
 * estimator measures real prompts built from mock game state instead.
 */
import type { ModelPrice, PriceCeiling, PriceTable } from './prices';
import { priceOf, worstCaseCallUsd, worstCasePrice } from './prices';
import type { Provider } from './usage';

export type CallKind = 'turn' | 'reflection' | 'diary' | 'finalMessage';

/** One kind of model call, as one bot makes it over a whole game. */
export interface CallShape {
  kind: CallKind;
  callsPerGame: number;
  promptTokens: number;
  /** The stable start of the prompt that can be served from cache. */
  cacheableTokens: number;
  expectedOutputTokens: number;
  maxOutputTokens: number;
}

export interface EstimateAssumptions {
  levels: number;
  roundsPerLevel: number;
  turnCallsPerRound: number;
  turnPromptTokens: number;
  turnCacheableTokens: number;
  turnOutputTokens: number;
  reflectionPromptTokens: number;
  reflectionOutputTokens: number;
  diaryPromptTokens: number;
  diaryOutputTokens: number;
  finalMessagePromptTokens: number;
  finalMessageOutputTokens: number;
  /** How often per game a bot's cached prefix has to be written afresh (start, each reflection, a few expiries). */
  cacheWritesPerGame: number;
}

export interface MaxTokens {
  turn: number;
  reflection: number;
  diary: number;
  finalMessage: number;
}

/**
 * The calls one bot makes in a game (docs/SPEC.md section 6): three per round
 * (declare, talk, commit), a reflection and a diary-room call at each level's
 * end, and one message to Ingram at the end of the game.
 */
export function gameCallShapes(a: EstimateAssumptions, max: MaxTokens): CallShape[] {
  // Every call starts with the same cached prefix (rulebook, persona, goal),
  // so every kind of call can reuse the cache that the turn calls keep warm.
  const cacheable = a.turnCacheableTokens;
  return [
    {
      kind: 'turn',
      callsPerGame: a.levels * a.roundsPerLevel * a.turnCallsPerRound,
      promptTokens: a.turnPromptTokens,
      cacheableTokens: cacheable,
      expectedOutputTokens: a.turnOutputTokens,
      maxOutputTokens: max.turn,
    },
    {
      kind: 'reflection',
      callsPerGame: a.levels,
      promptTokens: a.reflectionPromptTokens,
      cacheableTokens: cacheable,
      expectedOutputTokens: a.reflectionOutputTokens,
      maxOutputTokens: max.reflection,
    },
    {
      kind: 'diary',
      callsPerGame: a.levels,
      promptTokens: a.diaryPromptTokens,
      cacheableTokens: cacheable,
      expectedOutputTokens: a.diaryOutputTokens,
      maxOutputTokens: max.diary,
    },
    {
      kind: 'finalMessage',
      callsPerGame: 1,
      promptTokens: a.finalMessagePromptTokens,
      cacheableTokens: cacheable,
      expectedOutputTokens: a.finalMessageOutputTokens,
      maxOutputTokens: max.finalMessage,
    },
  ];
}

/**
 * How a seat's prompts get cached:
 *   explicit   we mark the cache breakpoints ourselves (Anthropic)
 *   automatic  the provider may cache repeated prefixes on its own (DeepSeek,
 *              Gemini via OpenRouter); not counted on until measured
 *   none       no caching
 */
export type CachingMode = 'explicit' | 'automatic' | 'none';

export interface SeatPlan {
  botId: string;
  model: string;
  provider: Provider;
  caching: CachingMode;
  /** OpenRouter seats: the most OpenRouter may charge. The worst case is priced at this. */
  priceCeiling?: PriceCeiling;
}

export interface SeatEstimate extends SeatPlan {
  calls: number;
  expectedUsd: number;
  worstCaseUsd: number;
  notes: string[];
}

export function estimateSeat(
  seat: SeatPlan,
  price: ModelPrice,
  shapes: readonly CallShape[],
  cacheWritesPerGame: number,
): SeatEstimate {
  const notes: string[] = [];
  let caches = seat.caching === 'explicit';
  const minimum = price.minCacheableTokens ?? 0;
  if (caches && shapes.some((s) => s.cacheableTokens < minimum)) {
    caches = false;
    notes.push(`the cacheable prefix is shorter than ${seat.model}'s ${minimum}-token minimum, so nothing would be cached`);
  }
  if (seat.caching === 'automatic') {
    notes.push('the provider may cache prompts on its own; not counted on here, so the real cost may be lower');
  }
  if (seat.priceCeiling && (price.input > seat.priceCeiling.input || price.output > seat.priceCeiling.output)) {
    notes.push("OpenRouter's listed price is above this seat's priceCeiling, so calls may find no provider cheap enough");
  }
  const worstPrice = worstCasePrice(price, seat.priceCeiling);

  let calls = 0;
  let expected = 0;
  let worst = 0;
  let writesLeft = caches ? cacheWritesPerGame : 0;
  for (const s of shapes) {
    calls += s.callsPerGame;
    worst += s.callsPerGame * worstCaseCallUsd(worstPrice, s.promptTokens, s.maxOutputTokens);

    const cached = caches ? Math.min(s.cacheableTokens, s.promptTokens) : 0;
    const uncached = s.promptTokens - cached;
    // Cache writes happen on the first calls of the game and after each
    // reflection; booking them all against the turn calls is close enough.
    const writes = Math.min(writesLeft, s.callsPerGame);
    writesLeft -= writes;
    const reads = s.callsPerGame - writes;
    const perMillionTotal =
      s.callsPerGame * (uncached * price.input + s.expectedOutputTokens * price.output) +
      reads * cached * (price.cacheRead ?? price.input) +
      writes * cached * (price.cacheWrite5m ?? price.input);
    // No long-context multiplier here: prompts are asserted to stay far below it.
    expected += perMillionTotal / 1_000_000;
  }
  return { ...seat, calls, expectedUsd: expected, worstCaseUsd: worst, notes };
}

export interface CastEstimate {
  seats: SeatEstimate[];
  expectedUsd: number;
  worstCaseUsd: number;
  byProvider: Partial<Record<Provider, { expectedUsd: number; worstCaseUsd: number }>>;
}

export function estimateCast(
  seats: readonly SeatPlan[],
  prices: PriceTable,
  shapes: readonly CallShape[],
  cacheWritesPerGame: number,
): CastEstimate {
  const estimates = seats.map((seat): SeatEstimate => {
    if (seat.provider === 'mock') {
      const calls = shapes.reduce((n, s) => n + s.callsPerGame, 0);
      return { ...seat, calls, expectedUsd: 0, worstCaseUsd: 0, notes: ['mock seat: free'] };
    }
    return estimateSeat(seat, priceOf(prices, seat.model), shapes, cacheWritesPerGame);
  });
  const byProvider: CastEstimate['byProvider'] = {};
  for (const e of estimates) {
    const sums = (byProvider[e.provider] ??= { expectedUsd: 0, worstCaseUsd: 0 });
    sums.expectedUsd += e.expectedUsd;
    sums.worstCaseUsd += e.worstCaseUsd;
  }
  return {
    seats: estimates,
    expectedUsd: estimates.reduce((sum, e) => sum + e.expectedUsd, 0),
    worstCaseUsd: estimates.reduce((sum, e) => sum + e.worstCaseUsd, 0),
    byProvider,
  };
}
