/**
 * Usage: how many tokens a model call used, in one shape for every provider.
 *
 * Every model call comes back with a "usage" block. Our two providers count
 * the prompt differently, and mixing them up would make the ledger lie about
 * money:
 *
 *   Anthropic   `input_tokens` is only the UNCACHED part of the prompt. Cached
 *               tokens are reported beside it: `cache_creation_input_tokens`
 *               (written to the cache by this call, billed at ~1.25x input)
 *               and `cache_read_input_tokens` (served from the cache, ~0.1x).
 *               Whole prompt = input + cache writes + cache reads.
 *
 *   OpenRouter  OpenAI-style: `prompt_tokens` is the WHOLE prompt, and
 *               `prompt_tokens_details.cached_tokens` says how much of it was
 *               served from cache. Uncached part = prompt - cached.
 *
 * Both normalisers below produce the same `Usage`, whose token buckets never
 * overlap, so pricing a call is one simple sum (see prices.ts).
 */
import type Anthropic from '@anthropic-ai/sdk';

/** Who we pay for a call. `mock` calls are free and never touch the network. */
export type Provider = 'anthropic' | 'openrouter' | 'mock';

export interface Usage {
  /** Prompt tokens billed at the normal input price (not cached). */
  inputTokens: number;
  /** Prompt tokens this call wrote to the 5-minute cache. */
  cacheWriteTokens: number;
  /** Prompt tokens written to the 1-hour cache. We never ask for it, so this should stay 0. */
  cacheWrite1hTokens: number;
  /** Prompt tokens served from the cache. */
  cacheReadTokens: number;
  /** Generated tokens, including any hidden reasoning. */
  outputTokens: number;
  /**
   * The part of outputTokens that was hidden reasoning ("thinking"). Already
   * counted in outputTokens; tracked separately because bots must not think
   * (money rule 5) and some models do it unless told not to.
   */
  reasoningTokens: number;
}

export function emptyUsage(): Usage {
  return {
    inputTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
  };
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    cacheWrite1hTokens: a.cacheWrite1hTokens + b.cacheWrite1hTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
  };
}

/** The whole prompt, however it was billed. This is what the long-context price step looks at. */
export function promptTokens(u: Usage): number {
  return u.inputTokens + u.cacheWriteTokens + u.cacheWrite1hTokens + u.cacheReadTokens;
}

/** Share of the prompt served from cache, 0..1, or null when there was no prompt yet. */
export function cacheHitShare(u: Usage): number | null {
  const total = promptTokens(u);
  return total === 0 ? null : u.cacheReadTokens / total;
}

/**
 * One token count from a provider. Missing, null, negative or non-numeric
 * values become 0, so one odd field can never turn every total into NaN.
 */
function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

/**
 * The parts of Anthropic's usage block that we read. Picked from the SDK's own
 * type, so if Anthropic renames a field, `npm run typecheck` fails instead of
 * the ledger silently reading zeros. Partial, because recorded responses and
 * test fakes may leave fields out.
 */
export type AnthropicUsageBlock = Partial<
  Pick<
    Anthropic.Usage,
    | 'input_tokens'
    | 'output_tokens'
    | 'cache_creation_input_tokens'
    | 'cache_read_input_tokens'
    | 'cache_creation'
    | 'output_tokens_details'
  >
>;

export function fromAnthropicUsage(block: AnthropicUsageBlock): Usage {
  const written = count(block.cache_creation_input_tokens);
  // The cache-write total is split by how long the cache lives. We only ever
  // ask for the 5-minute cache, but if 1-hour writes appear we keep them apart:
  // they cost 2x input instead of 1.25x, and the ledger flags them.
  const oneHour = Math.min(written, count(block.cache_creation?.ephemeral_1h_input_tokens));
  return {
    inputTokens: count(block.input_tokens),
    cacheWriteTokens: written - oneHour,
    cacheWrite1hTokens: oneHour,
    cacheReadTokens: count(block.cache_read_input_tokens),
    outputTokens: count(block.output_tokens),
    reasoningTokens: count(block.output_tokens_details?.thinking_tokens),
  };
}

/**
 * The parts of OpenRouter's usage block that we read. OpenRouter follows
 * OpenAI's format and adds `cost`: what it actually charged, in US dollars.
 * Every field is optional because the providers behind OpenRouter fill in
 * different subsets. (The first paid run re-checks these names against real
 * responses, which are all recorded.)
 */
export interface OpenRouterUsageBlock {
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  cost?: number | null;
  prompt_tokens_details?: { cached_tokens?: number | null; cache_write_tokens?: number | null } | null;
  completion_tokens_details?: { reasoning_tokens?: number | null } | null;
}

export function fromOpenRouterUsage(block: OpenRouterUsageBlock): {
  usage: Usage;
  /** OpenRouter's own figure for what the call cost, when it sent one. */
  providerCostUsd: number | null;
} {
  const prompt = count(block.prompt_tokens);
  // Clamp each part to what is left of the prompt, so a provider that reports
  // more cached tokens than prompt tokens can't produce a negative count.
  const cached = Math.min(prompt, count(block.prompt_tokens_details?.cached_tokens));
  const written = Math.min(prompt - cached, count(block.prompt_tokens_details?.cache_write_tokens));
  const cost = block.cost;
  return {
    usage: {
      inputTokens: prompt - cached - written,
      cacheWriteTokens: written,
      cacheWrite1hTokens: 0,
      cacheReadTokens: cached,
      outputTokens: count(block.completion_tokens),
      reasoningTokens: count(block.completion_tokens_details?.reasoning_tokens),
    },
    providerCostUsd: typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : null,
  };
}
