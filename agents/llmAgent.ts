/**
 * LlmAgent: a seat played by a real model, through agents/models.ts.
 *
 * The spec's ClaudeAgent and OpenRouterAgent are one class here, because
 * models.ts already gives both providers one shape. This class adds what a
 * game needs on top: the seat's price ceiling (OpenRouter), the worst-case
 * price of a call for the spend guard, and patient retries when a provider
 * is busy (spec section 3: "Use timeouts, backoff on rate limits").
 *
 * It never decides whether a call may be made: the game reserves the money
 * first (budget/spendGuard.ts) and records what it cost afterwards.
 */
import type { ClaudeClient, ModelCall, OpenRouterClient } from './models';
import { ProviderError } from './models';
import type { ModelPrice, PriceCeiling } from '../budget/prices';
import { worstCaseCallUsd, worstCasePrice } from '../budget/prices';
import type { Seat } from '../harness/config';
import { sleep } from '../harness/files';
import type { Agent, AgentReply, AgentRequest } from './agent';
import { AgentCallError } from './agent';

export interface LlmClients {
  claude: ClaudeClient | null;
  router: OpenRouterClient | null;
}

/** Retry a busy provider this many times, waiting a little longer each time. */
const TRANSPORT_ATTEMPTS = 3;

export class LlmAgent implements Agent {
  readonly id: string;
  readonly provider: 'anthropic' | 'openrouter';
  readonly model: string;

  constructor(
    private readonly seat: Seat,
    private readonly clients: LlmClients,
    private readonly price: ModelPrice,
    private readonly wait: (ms: number) => Promise<void> = sleep,
  ) {
    if (seat.provider === 'mock') throw new Error(`Seat ${seat.botId} is a mock seat: use MockAgent.`);
    if (seat.provider === 'anthropic' && !clients.claude) throw new Error(`Seat ${seat.botId} needs the Anthropic key.`);
    if (seat.provider === 'openrouter' && (!clients.router || !seat.priceCeiling)) {
      throw new Error(`Seat ${seat.botId} needs the OpenRouter key and a priceCeiling in config/cast.json.`);
    }
    this.id = seat.botId;
    this.provider = seat.provider;
    this.model = seat.model;
  }

  worstCaseUsd(promptTokens: number, maxTokens: number): number {
    return worstCaseCallUsd(worstCasePrice(this.price, this.seat.priceCeiling), promptTokens, maxTokens);
  }

  async act(request: AgentRequest): Promise<AgentReply> {
    const { user: text, userCacheBreak: cut } = request.prompt;
    // The stable start of the view ends a cached prefix, so the round's later calls read it at a tenth of the price.
    const user: ModelCall['user'] =
      cut !== undefined && cut > 0 && cut < text.length
        ? [
            { type: 'text', text: text.slice(0, cut), cache: true },
            { type: 'text', text: text.slice(cut) },
          ]
        : [{ type: 'text', text }];
    const call: ModelCall = { model: this.model, system: request.prompt.system, user, maxTokens: request.maxTokens, schema: request.schema };
    for (let attempt = 1; ; attempt++) {
      try {
        if (this.provider === 'anthropic') return await (this.clients.claude as ClaudeClient).call(call);
        // Gemini (and Claude, if ever seated through OpenRouter) caches only what is marked; DeepSeek caches by itself.
        const cacheSystem = this.model.startsWith('google/') || this.model.startsWith('anthropic/');
        return await (this.clients.router as OpenRouterClient).call(call, { maxPrice: this.seat.priceCeiling as PriceCeiling, cacheSystem });
      } catch (err) {
        if (!(err instanceof ProviderError)) throw err;
        const busy = err.status === 429 || err.status >= 500 || err.status === 0;
        if (busy && attempt < TRANSPORT_ATTEMPTS) {
          await this.wait(3000 * attempt);
          continue;
        }
        throw new AgentCallError(err.message, err.status);
      }
    }
  }
}
