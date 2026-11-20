/**
 * Calling the models: one request, one JSON reply, every token accounted for.
 *
 * Two providers, one shape (ModelCall in, ModelReply out), so the rest of the
 * project never cares who it is talking to. Everything that matters for money
 * and honesty is set explicitly, never left to defaults or the environment:
 *   - the key and the API address
 *   - thinking/reasoning switched off (money rule 5; several models think by
 *     default, and hidden thinking costs output tokens)
 *   - a hard output cap (max_tokens) on every call
 *   - the reply's JSON shape, enforced by the provider (structured outputs)
 *   - prompt caching on the stable start of the prompt
 *   - for OpenRouter, the seat's price ceiling (provider.max_price), so a call
 *     can't be routed to a provider dearer than the spend guard planned for
 *
 * The whole provider response comes back in `raw`, so it can be recorded and
 * never has to be paid for twice (money rule 4).
 */
import Anthropic from '@anthropic-ai/sdk';
import type { Usage } from '../budget/usage';
import { fromAnthropicUsage, fromOpenRouterUsage } from '../budget/usage';
import { redactSecrets } from '../harness/redact';

export type Part = { type: 'text'; text: string; cache?: boolean } | { type: 'image'; png: Buffer; cache?: boolean };

export interface ModelCall {
  model: string;
  /** System prompt blocks, stable content first. A block with cache: true ends a cached prefix. */
  system: { text: string; cache?: boolean }[];
  /** The user turn. Parts with cache: true end a cached prefix too (for a stable image). */
  user: Part[];
  maxTokens: number;
  /** JSON schema the reply must follow. */
  schema: Record<string, unknown>;
}

export interface ModelReply {
  /** The reply text: JSON, when the schema was followed. */
  text: string;
  usage: Usage;
  /** What the provider says it charged, when it says (OpenRouter does). */
  providerCostUsd: number | null;
  /** Why the model stopped: end_turn, max_tokens, refusal, stop, length, ... */
  stopReason: string | null;
  /** The provider's whole response, for the record. */
  raw: unknown;
}

/** A provider said no. `status` is the HTTP status (0 for network trouble). */
export class ProviderError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(redactSecrets(message));
  }
}

export interface ModelClient {
  call(c: ModelCall): Promise<ModelReply>;
}

// ---------------------------------------------------------------- Anthropic

export class ClaudeClient implements ModelClient {
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({
      apiKey,
      // Both set on purpose: the SDK would otherwise read ANTHROPIC_BASE_URL and
      // ANTHROPIC_AUTH_TOKEN from the environment, and the Claude desktop app
      // sets a base URL for its own use.
      baseURL: 'https://api.anthropic.com',
      authToken: null,
      maxRetries: 2,
      timeout: 90_000,
    });
  }

  /**
   * How to switch thinking off differs by model, and getting it wrong is
   * either a 400 or a bill: Haiku 5.5 thinks unless told "disabled", while
   * Sonnet 5.5 rejects "disabled" and needs "between_tools".
   */
  private thinkingOff(model: string): Anthropic.MessageCreateParams['thinking'] {
    if (model.startsWith('claude-sonnet-5-5')) return { type: 'between_tools' } as unknown as Anthropic.MessageCreateParams['thinking'];
    return { type: 'disabled' };
  }

  private request(c: ModelCall) {
    return {
      model: c.model,
      system: c.system.map((b) => ({
        type: 'text' as const,
        text: b.text,
        ...(b.cache ? { cache_control: { type: 'ephemeral' as const } } : {}),
      })),
      messages: [
        {
          role: 'user' as const,
          content: c.user.map((p) => {
            const cache = p.cache ? { cache_control: { type: 'ephemeral' as const } } : {};
            return p.type === 'text'
              ? { type: 'text' as const, text: p.text, ...cache }
              : {
                  type: 'image' as const,
                  source: { type: 'base64' as const, media_type: 'image/png' as const, data: p.png.toString('base64') },
                  ...cache,
                };
          }),
        },
      ],
      thinking: this.thinkingOff(c.model),
    };
  }

  async call(c: ModelCall): Promise<ModelReply> {
    try {
      const response = await this.client.messages.create({
        ...this.request(c),
        max_tokens: c.maxTokens,
        output_config: { format: { type: 'json_schema', schema: c.schema } },
      });
      const text = response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
      return { text, usage: fromAnthropicUsage(response.usage), providerCostUsd: null, stopReason: response.stop_reason, raw: response };
    } catch (err) {
      if (err instanceof Anthropic.APIError) throw new ProviderError(err.status ?? 0, err.message);
      throw err;
    }
  }

  /** Exact prompt size, from Anthropic's free token-counting endpoint (runs no model). */
  async countTokens(c: ModelCall): Promise<number> {
    const counted = await this.client.messages.countTokens(this.request(c));
    return counted.input_tokens;
  }
}

// ---------------------------------------------------------------- OpenRouter

export interface RouterOptions {
  /** The most this call may cost per million tokens (the seat's priceCeiling). */
  maxPrice: { input: number; output: number };
  /** Mark the system prompt for caching (Gemini wants cache_control; DeepSeek caches by itself). */
  cacheSystem: boolean;
}

export const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';

export class OpenRouterClient {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async call(c: ModelCall, options: RouterOptions): Promise<ModelReply> {
    const system = options.cacheSystem
      ? c.system.map((b) => ({ type: 'text', text: b.text, ...(b.cache ? { cache_control: { type: 'ephemeral' } } : {}) }))
      : c.system.map((b) => b.text).join('\n\n');
    const body = {
      model: c.model,
      max_tokens: c.maxTokens,
      messages: [
        { role: 'system', content: system },
        {
          role: 'user',
          content: c.user.map((p) =>
            p.type === 'text'
              ? { type: 'text', text: p.text }
              : { type: 'image_url', image_url: { url: `data:image/png;base64,${p.png.toString('base64')}` } },
          ),
        },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'answer', strict: true, schema: c.schema } },
      // Both models in the cast reason by default (DeepSeek V4 Flash at "high"). "none" switches it off.
      reasoning: { effort: 'none' },
      provider: {
        max_price: { prompt: options.maxPrice.input, completion: options.maxPrice.output },
        sort: 'price',
        require_parameters: true, // only providers that honour every parameter above, structured outputs included
      },
    };
    let res: Response;
    try {
      res = await this.fetchImpl(OPENROUTER_CHAT_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(90_000),
      });
    } catch (err) {
      throw new ProviderError(0, `couldn't reach OpenRouter: ${(err as Error).message}`);
    }
    const json = (await res.json().catch(() => null)) as {
      choices?: { message?: { content?: string | null }; finish_reason?: string }[];
      usage?: Record<string, unknown>;
      error?: { message?: string; code?: unknown };
    } | null;
    if (!res.ok || !json || json.error) {
      throw new ProviderError(res.status, `OpenRouter ${res.status}: ${json?.error?.message ?? res.statusText}`);
    }
    const choice = json.choices?.[0];
    const { usage, providerCostUsd } = fromOpenRouterUsage(json.usage ?? {});
    return {
      text: choice?.message?.content ?? '',
      usage,
      providerCostUsd,
      stopReason: choice?.finish_reason ?? null,
      raw: json,
    };
  }
}
