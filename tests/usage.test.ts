import { describe, expect, it } from 'vitest';
import {
  addUsage,
  cacheHitShare,
  emptyUsage,
  fromAnthropicUsage,
  fromOpenRouterUsage,
  promptTokens,
} from '../budget/usage';

describe('fromAnthropicUsage', () => {
  it('keeps uncached input, cache writes and cache reads apart, as Anthropic reports them', () => {
    const u = fromAnthropicUsage({
      input_tokens: 1800,
      cache_creation_input_tokens: 5000,
      cache_read_input_tokens: 0,
      output_tokens: 400,
    });
    expect(u).toEqual({
      inputTokens: 1800,
      cacheWriteTokens: 5000,
      cacheWrite1hTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 400,
      reasoningTokens: 0,
    });
    expect(promptTokens(u)).toBe(6800);
  });

  it('keeps 1-hour cache writes separate, because they cost more', () => {
    const u = fromAnthropicUsage({
      input_tokens: 10,
      cache_creation_input_tokens: 5000,
      cache_creation: { ephemeral_5m_input_tokens: 3000, ephemeral_1h_input_tokens: 2000 },
      output_tokens: 5,
    });
    expect(u.cacheWriteTokens).toBe(3000);
    expect(u.cacheWrite1hTokens).toBe(2000);
  });

  it('counts hidden thinking tokens, so a bot that thinks against orders shows up', () => {
    const u = fromAnthropicUsage({ input_tokens: 10, output_tokens: 300, output_tokens_details: { thinking_tokens: 250 } });
    expect(u.reasoningTokens).toBe(250);
    expect(u.outputTokens).toBe(300);
  });

  it('treats missing, null or nonsense counts as zero, never NaN', () => {
    const u = fromAnthropicUsage({ input_tokens: Number.NaN, cache_creation_input_tokens: null, cache_read_input_tokens: -5 });
    expect(u).toEqual(emptyUsage());
  });
});

describe('fromOpenRouterUsage', () => {
  it('subtracts cached tokens from prompt_tokens, which counts the whole prompt', () => {
    const { usage, providerCostUsd } = fromOpenRouterUsage({
      prompt_tokens: 6800,
      completion_tokens: 400,
      cost: 0.0012,
      prompt_tokens_details: { cached_tokens: 5000 },
    });
    expect(usage.inputTokens).toBe(1800);
    expect(usage.cacheReadTokens).toBe(5000);
    expect(promptTokens(usage)).toBe(6800);
    expect(providerCostUsd).toBe(0.0012);
  });

  it('reads reasoning tokens', () => {
    const { usage } = fromOpenRouterUsage({ completion_tokens: 900, completion_tokens_details: { reasoning_tokens: 700 } });
    expect(usage.reasoningTokens).toBe(700);
  });

  it('never goes negative when a provider reports more cached tokens than prompt tokens', () => {
    const { usage } = fromOpenRouterUsage({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 250 } });
    expect(usage.inputTokens).toBe(0);
    expect(usage.cacheReadTokens).toBe(100);
  });

  it('has no provider cost when OpenRouter sends none', () => {
    expect(fromOpenRouterUsage({ prompt_tokens: 1 }).providerCostUsd).toBeNull();
    expect(fromOpenRouterUsage({ prompt_tokens: 1, cost: -1 }).providerCostUsd).toBeNull();
  });
});

describe('usage helpers', () => {
  it('adds field by field and measures the share served from cache', () => {
    const a = { ...emptyUsage(), inputTokens: 100, cacheReadTokens: 300 };
    const sum = addUsage(a, a);
    expect(sum.inputTokens).toBe(200);
    expect(cacheHitShare(sum)).toBe(0.75);
    expect(cacheHitShare(emptyUsage())).toBeNull();
  });
});
