/**
 * OpenRouter prices, read from OpenRouter's public models API.
 *
 * The spec: "Fetch OpenRouter prices from its models API at run start."
 * The endpoint is free and needs no API key, so checking prices never costs
 * anything and never touches your keys.
 *
 * OpenRouter quotes prices as strings in US dollars PER TOKEN ("0.00000025").
 * We convert them to dollars per MILLION tokens, the unit the rest of the
 * project uses.
 */
import { z } from 'zod';
import type { ModelPrice, PriceTable } from './prices';

export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';

const OpenRouterModelSchema = z.object({
  id: z.string(),
  pricing: z.object({
    prompt: z.string(),
    completion: z.string(),
    input_cache_read: z.string().optional(),
    input_cache_write: z.string().optional(),
  }),
});

/** "0.00000025" dollars per token -> 0.25 dollars per million tokens. */
export function perTokenToPerMillion(perToken: string | undefined): number | undefined {
  if (perToken === undefined) return undefined;
  const n = Number(perToken);
  // OpenRouter uses "-1" for "the price varies". We can't cap what we can't price.
  if (!Number.isFinite(n) || n < 0) return undefined;
  // toPrecision trims binary floating-point noise: 0.0000001 * 1e6 is
  // 0.09999999999999999 in a computer, and we want 0.1.
  return Number((n * 1_000_000).toPrecision(12));
}

export interface OpenRouterPriceResult {
  prices: PriceTable;
  /** One line per wanted model we could not price, saying why. */
  problems: string[];
}

/** Pick out the models we want from the models API's JSON. */
export function parseOpenRouterModels(json: unknown, wanted: readonly string[]): OpenRouterPriceResult {
  // Check only the entries we need. The list has hundreds of models, and one
  // odd entry elsewhere must not stop us pricing ours.
  const list = z.object({ data: z.array(z.unknown()) }).parse(json).data;
  const prices: PriceTable = {};
  const problems: string[] = [];
  for (const id of wanted) {
    const raw = list.find((m) => typeof m === 'object' && m !== null && (m as { id?: unknown }).id === id);
    if (raw === undefined) {
      problems.push(`${id}: not in OpenRouter's model list (renamed or retired?)`);
      continue;
    }
    const entry = OpenRouterModelSchema.safeParse(raw);
    if (!entry.success) {
      problems.push(`${id}: its pricing is not in the expected shape`);
      continue;
    }
    const p = entry.data.pricing;
    const input = perTokenToPerMillion(p.prompt);
    const output = perTokenToPerMillion(p.completion);
    if (input === undefined || output === undefined) {
      problems.push(`${id}: its price is variable or missing, so a spending cap can't be enforced`);
      continue;
    }
    const price: ModelPrice = { provider: 'openrouter', input, output };
    const cacheRead = perTokenToPerMillion(p.input_cache_read);
    const cacheWrite = perTokenToPerMillion(p.input_cache_write);
    if (cacheRead !== undefined) price.cacheRead = cacheRead;
    if (cacheWrite !== undefined) price.cacheWrite5m = cacheWrite;
    prices[id] = price;
  }
  return { prices, problems };
}

/** Fetch current prices for the given OpenRouter models. Free; sends no key. */
export async function fetchOpenRouterPrices(
  wanted: readonly string[],
  fetchImpl: typeof fetch = fetch,
): Promise<OpenRouterPriceResult> {
  const res = await fetchImpl(OPENROUTER_MODELS_URL, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`OpenRouter's models API answered ${res.status} ${res.statusText}`);
  return parseOpenRouterModels(await res.json(), wanted);
}
