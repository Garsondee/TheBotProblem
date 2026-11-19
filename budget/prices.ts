/**
 * The price table: what each model costs, in US dollars per million tokens.
 *
 * Anthropic prices live in config/prices.json, checked by hand against
 * Anthropic's pricing page. OpenRouter prices come from OpenRouter's free
 * models API (see openrouterPrices.ts): they change often, so paid runs fetch
 * them fresh, and a dated snapshot in config/openrouter-prices.json serves
 * offline estimates and fake runs.
 *
 * Two prices matter for the money rules:
 *   costOfUsage       what a finished call actually cost (the ledger)
 *   worstCaseCallUsd  the most a call could cost, worked out BEFORE making it
 *                     (the spend guard reserves this much; see spendGuard.ts)
 */
import { z } from 'zod';
import type { Usage } from './usage';
import { promptTokens } from './usage';

const PerMillion = z.number().nonnegative();

export const ModelPriceSchema = z.object({
  provider: z.enum(['anthropic', 'openrouter']),
  /** Uncached prompt tokens. */
  input: PerMillion,
  /** Generated tokens (hidden reasoning included). */
  output: PerMillion,
  /** Prompt tokens written to the 5-minute cache. */
  cacheWrite5m: PerMillion.optional(),
  /** Prompt tokens written to the 1-hour cache (we never ask for it). */
  cacheWrite1h: PerMillion.optional(),
  /** Prompt tokens served from the cache. */
  cacheRead: PerMillion.optional(),
  /** Prompts shorter than this are never cached: no error, just no discount. Null when unknown. */
  minCacheableTokens: z.number().int().positive().nullable().optional(),
  /** Above this prompt size every rate is multiplied (Haiku 5.5: 5x above 100K tokens). */
  longContext: z.object({ aboveTokens: z.number().int().positive(), multiplier: z.number().min(1) }).optional(),
  notes: z.array(z.string()).optional(),
});
export type ModelPrice = z.infer<typeof ModelPriceSchema>;

/** Model id -> price. */
export type PriceTable = Record<string, ModelPrice>;

/** The shape of config/prices.json and config/openrouter-prices.json. */
export const PriceFileSchema = z.object({
  $comment: z.string().optional(),
  /** When a person or script last checked these prices against the source. */
  checkedOn: z.string(),
  sources: z.array(z.string()).optional(),
  models: z.record(z.string(), ModelPriceSchema),
});
export type PriceFile = z.infer<typeof PriceFileSchema>;

export class UnknownPriceError extends Error {}

export function priceOf(table: PriceTable, model: string): ModelPrice {
  const price = table[model];
  if (!price) {
    throw new UnknownPriceError(
      `No price for model "${model}". Anthropic models go in config/prices.json; ` +
        'for OpenRouter models run `npm run prices`.',
    );
  }
  return price;
}

/** The long-context multiplier for a prompt of this size (1 for normal prompts). */
function sizeMultiplier(price: ModelPrice, promptTokenCount: number): number {
  return price.longContext && promptTokenCount > price.longContext.aboveTokens ? price.longContext.multiplier : 1;
}

/** What a finished call cost, in US dollars, from its usage block. */
export function costOfUsage(usage: Usage, price: ModelPrice): number {
  // Missing cache prices fall back to safe values: a cache read priced as
  // full input is an overestimate, and a 1-hour write is priced at Anthropic's
  // 2x-input rule. OpenRouter calls are also checked against the cost
  // OpenRouter reports itself (the ledger charges the larger figure).
  const write5m = price.cacheWrite5m ?? price.input;
  const write1h = price.cacheWrite1h ?? price.input * 2;
  const read = price.cacheRead ?? price.input;
  const perMillionTotal =
    usage.inputTokens * price.input +
    usage.cacheWriteTokens * write5m +
    usage.cacheWrite1hTokens * write1h +
    usage.cacheReadTokens * read +
    usage.outputTokens * price.output;
  return (perMillionTotal / 1_000_000) * sizeMultiplier(price, promptTokens(usage));
}

/**
 * The most a single call could cost, before we make it.
 *
 * Assumes the worst on every count: nothing is read from the cache, the whole
 * prompt is billed at the dearer of the input and cache-write prices (a call
 * that writes the cache pays more than one that doesn't), and the model uses
 * every one of its max_tokens. Hidden reasoning counts against max_tokens, so
 * even a model that thinks against our wishes can't exceed this.
 */
export function worstCaseCallUsd(price: ModelPrice, promptTokenCount: number, maxOutputTokens: number): number {
  const promptRate = Math.max(price.input, price.cacheWrite5m ?? price.input);
  const perMillionTotal = promptTokenCount * promptRate + maxOutputTokens * price.output;
  return (perMillionTotal / 1_000_000) * sizeMultiplier(price, promptTokenCount);
}

/** The most OpenRouter may charge for a seat, per million tokens (see Seat.priceCeiling). */
export interface PriceCeiling {
  input: number;
  output: number;
}

/**
 * The price to plan a seat's worst case with. One OpenRouter model is served
 * by many providers at different prices, and the listed price is just one of
 * them. With a ceiling, OpenRouter won't route above it, so the ceiling (or
 * the listed price, if that is higher) is the honest worst case.
 */
export function worstCasePrice(price: ModelPrice, ceiling?: PriceCeiling): ModelPrice {
  if (!ceiling) return price;
  return { ...price, input: Math.max(price.input, ceiling.input), output: Math.max(price.output, ceiling.output) };
}

export class PromptTooLargeError extends Error {}

/**
 * The spec: "Haiku 5.5 prices rise 5x for prompts over 100K tokens. Keep every
 * prompt far below that, and assert it in code." This is that assertion. The
 * limit itself lives in config/game.json (budget.promptTokenHardLimit).
 */
export function assertPromptWithinLimit(promptTokenCount: number, limit: number, model: string): void {
  if (promptTokenCount > limit) {
    throw new PromptTooLargeError(
      `The prompt for ${model} is ${promptTokenCount} tokens, over the hard limit of ${limit}. ` +
        'Something is stuffing the prompt (a runaway notebook, a log that never gets trimmed?). Refusing to send it.',
    );
  }
}

/** Problems with a configured hard limit: it must sit below every model's long-context price step. */
export function hardLimitProblems(table: PriceTable, limit: number): string[] {
  return Object.entries(table)
    .filter(([, price]) => price.longContext && limit >= price.longContext.aboveTokens)
    .map(
      ([model, price]) =>
        `promptTokenHardLimit (${limit}) is not below ${model}'s long-context step (${price.longContext?.aboveTokens} tokens), ` +
        'so a prompt could hit the expensive tier.',
    );
}
