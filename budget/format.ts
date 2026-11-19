/** How money and ledger totals are shown on screen. */
import type { LedgerTotals } from './ledger';
import { cacheHitShare } from './usage';

/** Dollars with as many decimals as the amount needs: $0.0043, $0.427, $0.10, $1.50. */
export function usd(amount: number): string {
  if (amount === 0) return '$0';
  const abs = Math.abs(amount);
  if (abs < 0.01) return `$${amount.toFixed(4)}`;
  // Three decimals below a dollar, minus a pointless trailing zero ($0.10, not $0.100).
  if (abs < 1) return `$${amount.toFixed(3).replace(/0$/, '')}`;
  return `$${amount.toFixed(2)}`;
}

/** Fixed four decimals, so columns of small amounts line up. */
export function usd4(amount: number): string {
  return `$${amount.toFixed(4)}`;
}

export function percent(share: number | null): string {
  return share === null ? '-' : `${Math.round(share * 100)}%`;
}

/**
 * The live ledger line printed after each phase or round:
 *   L1 R03 commit   spent $0.0213 of $1.50 | A 0.0041  B 0.0041 ... | cache 71%
 */
export function liveLine(where: string, totals: LedgerTotals, runCapUsd: number, botIds: readonly string[]): string {
  const perBot = botIds.map((id) => `${id} ${(totals.byBot[id]?.usd ?? 0).toFixed(4)}`).join('  ');
  const cache = percent(cacheHitShare(totals.usage));
  return `${where.padEnd(17)} spent ${usd4(totals.usd)} of ${usd(runCapUsd)} | ${perBot} | cache ${cache}`;
}
