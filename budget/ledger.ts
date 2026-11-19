/**
 * The usage ledger: one entry per model call, with what it cost.
 *
 * The spec: "After every call, read the usage block (including cache read and
 * write tokens), price it and add it to a running ledger per bot, per phase
 * and per run. Show it live in the console and save it in the replay."
 *
 * The ledger only records facts. Deciding whether we may spend more is the
 * spend guard's job (spendGuard.ts), which reads its totals from here.
 */
import type { PriceTable } from './prices';
import { costOfUsage, priceOf } from './prices';
import type { Provider, Usage } from './usage';
import { addUsage, cacheHitShare, emptyUsage } from './usage';

/** Everything the caller knows about a call that just came back. */
export interface CallRecord {
  /** The bot the call was for, or null for calls that belong to no bot (analysis, voices). */
  botId: string | null;
  /** 'declare', 'talk', 'commit', 'reflect', 'diary', 'analysis', ... */
  phase: string;
  level?: number | null;
  round?: number | null;
  model: string;
  provider: Provider;
  usage: Usage;
  /** What the provider says it charged, when it tells us. OpenRouter does; Anthropic doesn't. */
  providerCostUsd?: number | null;
}

export interface LedgerEntry {
  seq: number;
  at: string;
  botId: string | null;
  phase: string;
  level: number | null;
  round: number | null;
  model: string;
  provider: Provider;
  usage: Usage;
  /** The cost according to our price table. */
  tableUsd: number;
  /** The cost according to the provider, if it reported one. */
  providerUsd: number | null;
  /**
   * The larger of the two. Caps count this figure, so if our table is out of
   * date, or OpenRouter routed the call to a pricier provider, we over-count
   * rather than under-count.
   */
  chargedUsd: number;
}

export interface Bucket {
  usd: number;
  calls: number;
  usage: Usage;
}

export interface LedgerTotals extends Bucket {
  byBot: Record<string, Bucket>;
  byPhase: Record<string, Bucket>;
  byProvider: Record<string, Bucket>;
  byModel: Record<string, Bucket>;
}

/** The key used in `byBot` for calls that belong to no bot. */
export const NO_BOT = '(no bot)';

function emptyBucket(): Bucket {
  return { usd: 0, calls: 0, usage: emptyUsage() };
}

function addTo(buckets: Record<string, Bucket>, key: string, entry: LedgerEntry): void {
  const bucket = (buckets[key] ??= emptyBucket());
  bucket.usd += entry.chargedUsd;
  bucket.calls += 1;
  bucket.usage = addUsage(bucket.usage, entry.usage);
}

export class Ledger {
  private readonly entries: LedgerEntry[] = [];

  constructor(
    readonly runId: string,
    private readonly prices: PriceTable,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /**
   * Price a finished call and add it to the ledger.
   *
   * Throws if the model has no price. That can't happen in a real run, because
   * the spend guard needs the same price to reserve the call before it is
   * made; if it ever does happen, the call's reservation stays booked at its
   * worst case, so the caps stay safe.
   */
  record(call: CallRecord): LedgerEntry {
    const tableUsd = call.provider === 'mock' ? 0 : costOfUsage(call.usage, priceOf(this.prices, call.model));
    const providerUsd = call.providerCostUsd ?? null;
    const entry: LedgerEntry = {
      seq: this.entries.length + 1,
      at: this.clock().toISOString(),
      botId: call.botId,
      phase: call.phase,
      level: call.level ?? null,
      round: call.round ?? null,
      model: call.model,
      provider: call.provider,
      usage: { ...call.usage },
      tableUsd,
      providerUsd,
      chargedUsd: Math.max(tableUsd, providerUsd ?? 0),
    };
    this.entries.push(entry);
    return entry;
  }

  all(): readonly LedgerEntry[] {
    return this.entries;
  }

  /** Total charged so far, optionally for one bot and/or one provider. */
  spentUsd(filter: { botId?: string | null; provider?: Provider } = {}): number {
    let sum = 0;
    for (const e of this.entries) {
      if (filter.botId !== undefined && e.botId !== filter.botId) continue;
      if (filter.provider !== undefined && e.provider !== filter.provider) continue;
      sum += e.chargedUsd;
    }
    return sum;
  }

  totals(): LedgerTotals {
    const totals: LedgerTotals = { ...emptyBucket(), byBot: {}, byPhase: {}, byProvider: {}, byModel: {} };
    for (const e of this.entries) {
      totals.usd += e.chargedUsd;
      totals.calls += 1;
      totals.usage = addUsage(totals.usage, e.usage);
      addTo(totals.byBot, e.botId ?? NO_BOT, e);
      addTo(totals.byPhase, e.phase, e);
      addTo(totals.byProvider, e.provider, e);
      addTo(totals.byModel, e.model, e);
    }
    return totals;
  }

  /** Share of one bot's prompt tokens served from cache (0..1), or null before its first call. */
  cacheHitRate(botId: string): number | null {
    return cacheHitShare(this.totals().byBot[botId]?.usage ?? emptyUsage());
  }

  /**
   * Things a human should know about, in plain words. These are signs that
   * money is leaking somewhere the caps don't catch by themselves.
   */
  warnings(): string[] {
    const out: string[] = [];
    for (const [bot, bucket] of Object.entries(this.totals().byBot)) {
      if (bucket.usage.reasoningTokens > 0) {
        out.push(
          `${bot}: ${bucket.usage.reasoningTokens} hidden reasoning tokens. Bots must not think (money rule 5); ` +
            "check that call's thinking/reasoning settings.",
        );
      }
      if (bucket.usage.cacheWrite1hTokens > 0) {
        out.push(
          `${bot}: ${bucket.usage.cacheWrite1hTokens} tokens went to the 1-hour cache, which costs 2x input. ` +
            'We only ever ask for the 5-minute cache.',
        );
      }
    }
    return out;
  }
}
