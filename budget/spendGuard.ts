/**
 * The spend guard: the hard caps that stop a paid run before it overspends.
 *
 * The spec: "Per-run cap (default $1.50), per-bot cap, and a global cap across
 * runs stored on disk. At the cap, finish the current phase, save, and stop."
 *
 * How the caps are made truly hard: RESERVATIONS.
 *
 * Before a phase starts, the harness asks the guard to reserve the WORST-CASE
 * cost of every call in that phase (prices.ts, worstCaseCallUsd). The guard
 * agrees only if every cap would still hold even if all of those calls cost
 * their worst case. Either the whole phase is reserved or none of it is, so:
 *   - a phase that starts can always be finished without breaking a cap
 *     ("finish the current phase"), and
 *   - a phase that can't be afforded never starts ("save, and stop").
 * When a call comes back, its reservation is settled at the real price, which
 * frees the unused part for later phases.
 *
 * A reservation that is never settled (a crash mid-call) stays booked at its
 * worst case. A bug can make the guard stop a run early; it can't make it
 * overspend.
 */
import type { GlobalSpend } from './globalSpend';
import type { Ledger, LedgerEntry } from './ledger';
import type { Provider } from './usage';
import { usd } from './format';

export interface Caps {
  /** The most one run may spend, all providers together. */
  runUsd: number;
  /** The most any one bot may spend in a run... */
  perBotUsd: number;
  /** ...unless its seat in the cast says otherwise (a Sonnet seat needs more). */
  perBotOverrideUsd?: Record<string, number>;
  /**
   * The most all paid runs together may ever spend, per provider. A provider
   * missing here may not be spent on at all: every paid call must be deliberate.
   */
  globalUsd: Partial<Record<Provider, number>>;
}

export interface PlannedCall {
  botId: string | null;
  provider: Provider;
  /** From worstCaseCallUsd: the most this call could possibly cost. */
  worstCaseUsd: number;
}

export interface Reservation extends PlannedCall {
  readonly id: number;
}

export type CapKind = 'run' | 'bot' | 'global';

export interface CapBreach {
  cap: CapKind;
  /** 'run', the bot's id, or the provider's name. */
  scope: string;
  limitUsd: number;
  /** Already spent plus already reserved, before this request. */
  committedUsd: number;
  /** What this request would add, at worst. */
  requestedUsd: number;
}

export type ReserveResult = { ok: true; reservations: Reservation[] } | { ok: false; breach: CapBreach };

/** Lets sums like 0.1 + 0.2 equal 0.3 when compared with a cap. */
const PENNY_DUST = 1e-9;

export class SpendGuard {
  private readonly open = new Map<number, Reservation>();
  private nextId = 1;

  constructor(
    readonly caps: Caps,
    private readonly ledger: Ledger,
    /** The lifetime record. Without one, the global caps only see this run's spending. */
    private readonly global: GlobalSpend | null,
  ) {}

  /** Reserve every call of a phase, or none of them. */
  reserveAll(calls: readonly PlannedCall[]): ReserveResult {
    const breach = this.firstBreach(calls);
    if (breach) return { ok: false, breach };
    const reservations = calls.map((call) => {
      const reservation: Reservation = { ...call, id: this.nextId++ };
      this.open.set(reservation.id, reservation);
      return reservation;
    });
    return { ok: true, reservations };
  }

  /** Reserve a single extra call, such as a retry after a malformed reply. */
  reserve(call: PlannedCall): ReserveResult {
    return this.reserveAll([call]);
  }

  /** A reserved call came back and the ledger recorded it: swap the reservation for the real charge. */
  settle(reservation: Reservation, entry: LedgerEntry): void {
    if (!this.open.delete(reservation.id)) {
      throw new Error(`Reservation ${reservation.id} was already settled or released.`);
    }
    this.global?.add(entry.provider, entry.chargedUsd);
  }

  /** The call was never sent, so nothing was billed: free its reservation. */
  release(reservation: Reservation): void {
    this.open.delete(reservation.id);
  }

  /** Worst-case money still booked for calls that haven't come back yet. */
  reservedUsd(filter: { botId?: string | null; provider?: Provider } = {}): number {
    let sum = 0;
    for (const r of this.open.values()) {
      if (filter.botId !== undefined && r.botId !== filter.botId) continue;
      if (filter.provider !== undefined && r.provider !== filter.provider) continue;
      sum += r.worstCaseUsd;
    }
    return sum;
  }

  botCapUsd(botId: string): number {
    return this.caps.perBotOverrideUsd?.[botId] ?? this.caps.perBotUsd;
  }

  /** Lifetime spend for a provider: the record on disk, or this run alone without one. */
  private lifetimeUsd(provider: Provider): number {
    return this.global ? this.global.lifetimeUsd(provider) : this.ledger.spentUsd({ provider });
  }

  /**
   * The first cap these calls would break, or null if they all fit. The
   * lifetime caps are checked first: they guard your actual wallet.
   */
  private firstBreach(calls: readonly PlannedCall[]): CapBreach | null {
    const sumOf = (list: readonly PlannedCall[]) => list.reduce((sum, c) => sum + c.worstCaseUsd, 0);

    for (const provider of new Set(calls.map((c) => c.provider))) {
      const requested = sumOf(calls.filter((c) => c.provider === provider));
      if (provider === 'mock' || requested === 0) continue;
      const limit = this.caps.globalUsd[provider] ?? 0;
      const committed = this.lifetimeUsd(provider) + this.reservedUsd({ provider });
      if (committed + requested > limit + PENNY_DUST) {
        return { cap: 'global', scope: provider, limitUsd: limit, committedUsd: committed, requestedUsd: requested };
      }
    }

    const runRequested = sumOf(calls);
    const runCommitted = this.ledger.spentUsd() + this.reservedUsd();
    if (runCommitted + runRequested > this.caps.runUsd + PENNY_DUST) {
      return {
        cap: 'run',
        scope: 'run',
        limitUsd: this.caps.runUsd,
        committedUsd: runCommitted,
        requestedUsd: runRequested,
      };
    }

    for (const botId of new Set(calls.map((c) => c.botId))) {
      if (botId === null) continue; // calls for no bot (analysis) only count toward the run and lifetime caps
      const requested = sumOf(calls.filter((c) => c.botId === botId));
      const committed = this.ledger.spentUsd({ botId }) + this.reservedUsd({ botId });
      const limit = this.botCapUsd(botId);
      if (committed + requested > limit + PENNY_DUST) {
        return { cap: 'bot', scope: botId, limitUsd: limit, committedUsd: committed, requestedUsd: requested };
      }
    }
    return null;
  }
}

/** A cap breach in plain words, for the console and the saved run. */
export function describeBreach(b: CapBreach, what = 'the next phase'): string {
  const left = Math.max(0, b.limitUsd - b.committedUsd);
  const tail = `could cost up to ${usd(b.requestedUsd)}, but only ${usd(left)} of the ${usd(b.limitUsd)} cap is left`;
  switch (b.cap) {
    case 'run':
      return `Run cap reached: ${what} ${tail}.`;
    case 'bot':
      return `Bot ${b.scope}'s cap reached: its share of ${what} ${tail}.`;
    case 'global':
      return `Lifetime ${b.scope} cap reached: ${what} ${tail} (all paid runs together).`;
  }
}
