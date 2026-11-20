/**
 * The Director's model calls, under the same money rules as a game's.
 *
 *   - Each call's worst case is reserved before it is sent (budget/spendGuard.ts),
 *     against the Director's own cap and the lifetime caps.
 *   - Every reply is recorded in runs/<id>/director/calls.jsonl with its
 *     usage and the provider's whole response (money rule 4).
 *   - A call whose exact request was recorded before is answered from the
 *     record, free. Re-directing a game after a change to the edit costs only
 *     the edit; directing it again unchanged costs nothing.
 *
 * Tests pass a fake client; nothing here touches the network itself.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DirectorCall, DirectorCaller } from '../analysis/director';
import type { ModelCall, ModelReply } from '../agents/models';
import { ProviderError } from '../agents/models';
import type { Ledger } from '../budget/ledger';
import type { PriceTable } from '../budget/prices';
import { priceOf, worstCaseCallUsd } from '../budget/prices';
import type { SpendGuard } from '../budget/spendGuard';
import { describeBreach } from '../budget/spendGuard';
import { CHARS_PER_TOKEN_SAFE } from '../game/game';
import { sleep } from './files';

export interface RecordedCall {
  rec: 'call';
  key: string;
  stage: DirectorCall['stage'];
  room: number | null;
  model: string;
  at: string;
  text: string;
  stopReason: string | null;
  chargedUsd: number;
  usage: ModelReply['usage'];
  raw: unknown;
}

/** The same request always gets the same key: model, prompt, output cap and reply shape. */
export function callKey(c: DirectorCall): string {
  return createHash('sha256').update(JSON.stringify({ model: c.model, system: c.system, user: c.user, maxTokens: c.maxTokens, schema: c.schema })).digest('hex');
}

export function loadRecorded(file: string): Map<string, RecordedCall> {
  const out = new Map<string, RecordedCall>();
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    const r = JSON.parse(line) as RecordedCall;
    // Refusals stay in the file as a record of what was paid, but are never reused as answers.
    if (r.rec === 'call' && r.stopReason !== 'refusal') out.set(r.key, r);
  }
  return out;
}

/** A worst-case prompt size from its characters (the same safe ratio the game reserves with). */
export function promptTokensSafe(c: Pick<DirectorCall, 'system' | 'user'>): number {
  const chars = c.system.reduce((n, b) => n + b.text.length, 0) + c.user.length;
  return Math.ceil(chars / CHARS_PER_TOKEN_SAFE) + 50;
}

/** What a call is, in words: the reading of room 2, the edit, the spoken script (part 1). */
export function stageName(c: Pick<DirectorCall, 'stage' | 'room'>): string {
  return c.stage === 'room' ? `reading of room ${(c.room ?? 0) + 1}` : c.stage === 'spoken' ? `spoken script (part ${(c.room ?? 0) + 1})` : 'edit';
}

export class DirectorCapError extends Error {}

export interface DirectorCallerOptions {
  client: { call(c: ModelCall): Promise<ModelReply> } | null;
  prices: PriceTable;
  /** Null only for free runs, where every call must come from the record. */
  money: { guard: SpendGuard; ledger: Ledger } | null;
  recorded: Map<string, RecordedCall>;
  /** Where new replies are appended. */
  file: string;
  /** Ignore the record and pay for every call again. */
  fresh?: boolean;
  wait?: (ms: number) => Promise<void>;
  clock?: () => Date;
}

export interface DirectorCallStats {
  reused: number;
  made: number;
  spentUsd: number;
  /** Replies that hit their output cap. */
  cutOff: string[];
}

export function directorCaller(o: DirectorCallerOptions): { call: DirectorCaller; stats: DirectorCallStats } {
  const stats: DirectorCallStats = { reused: 0, made: 0, spentUsd: 0, cutOff: [] };
  const wait = o.wait ?? sleep;
  const clock = o.clock ?? (() => new Date());
  const call: DirectorCaller = async (c) => {
    const key = callKey(c);
    const old = o.fresh ? undefined : o.recorded.get(key);
    if (old) {
      stats.reused += 1;
      return old.text;
    }
    if (!o.client || !o.money) throw new Error(`The ${stageName(c)} isn't recorded, and this is a free run.`);
    const price = priceOf(o.prices, c.model);
    const reserved = o.money.guard.reserve({ botId: null, provider: price.provider, worstCaseUsd: worstCaseCallUsd(price, promptTokensSafe(c), c.maxTokens) });
    if (!reserved.ok) throw new DirectorCapError(describeBreach(reserved.breach, `the ${stageName(c)}`));
    const reservation = reserved.reservations[0];
    if (!reservation) throw new Error('No reservation came back.');
    const request: ModelCall = { model: c.model, system: c.system, user: [{ type: 'text', text: c.user }], maxTokens: c.maxTokens, schema: c.schema };
    let reply: ModelReply | null = null;
    try {
      for (let attempt = 1; ; attempt++) {
        try {
          reply = await o.client.call(request);
          break;
        } catch (err) {
          const busy = err instanceof ProviderError && (err.status === 429 || err.status >= 500 || err.status === 0);
          if (busy && attempt < 3) {
            await wait(3000 * attempt);
            continue;
          }
          throw err;
        }
      }
    } finally {
      if (!reply) o.money.guard.release(reservation);
    }
    const entry = o.money.ledger.record({ botId: null, phase: `director-${c.stage}`, level: c.room, round: null, model: c.model, provider: price.provider, usage: reply.usage, providerCostUsd: reply.providerCostUsd });
    o.money.guard.settle(reservation, entry);
    stats.made += 1;
    stats.spentUsd += entry.chargedUsd;
    const record: RecordedCall = { rec: 'call', key, stage: c.stage, room: c.room, model: c.model, at: clock().toISOString(), text: reply.text, stopReason: reply.stopReason, chargedUsd: entry.chargedUsd, usage: reply.usage, raw: reply.raw };
    mkdirSync(dirname(o.file), { recursive: true });
    appendFileSync(o.file, `${JSON.stringify(record)}\n`);
    // A refusal is written down (it was paid for) but never answered from: asking again may well succeed.
    // The first spoken script of game 2 (2026-11-20) came back refused, empty, for lines of plain game talk.
    if (reply.stopReason === 'refusal') stats.cutOff.push(`The ${stageName(c)} was refused by the model; it will be asked again next time.`);
    else o.recorded.set(key, record);
    // A cut-off reply won't parse, and the Director falls back; say why. (A bigger cap is a new request, so it won't be answered from this record.)
    if (reply.stopReason === 'max_tokens') stats.cutOff.push(`The ${stageName(c)} hit its ${c.maxTokens}-token cap; raise director.${c.stage === 'room' ? 'roomMaxTokens' : c.stage === 'spoken' ? 'spokenMaxTokens' : 'editMaxTokens'} in config/game.json.`);
    return reply.text;
  };
  return { call, stats };
}
