/**
 * A fake paid run: the money machinery running a whole game's worth of model
 * calls, with made-up usage instead of real calls. No network, no real money.
 *
 * It is milestone 0's acceptance test ("caps stop a fake run") and a demo you
 * can watch:   npm run fake-run -- --run-cap 0.10
 *
 * The phase loop has the same shape the real turn loop will have from
 * milestone 3: reserve the whole phase at its worst case, make the calls in
 * parallel, record each in the ledger, settle its reservation, save, repeat.
 * Only the line marked FAKE CALL changes when real agents arrive.
 */
import { join } from 'node:path';
import type { CallKind, CallShape } from '../budget/estimate';
import { gameCallShapes } from '../budget/estimate';
import { liveLine } from '../budget/format';
import { GlobalSpend } from '../budget/globalSpend';
import type { LedgerTotals } from '../budget/ledger';
import { Ledger } from '../budget/ledger';
import type { PriceTable } from '../budget/prices';
import { costOfUsage, priceOf, worstCaseCallUsd, worstCasePrice } from '../budget/prices';
import type { CapBreach, Caps } from '../budget/spendGuard';
import { SpendGuard, describeBreach } from '../budget/spendGuard';
import type { Usage } from '../budget/usage';
import type { Cast, GameConfig, Seat } from './config';
import { writeJsonAtomic } from './files';
import { createRunFolder, makeRunId } from './runFolder';

export interface FakeRunOptions {
  runsRoot: string;
  cast: Cast;
  prices: PriceTable;
  game: GameConfig;
  caps: Caps;
  /**
   * The lifetime spend record to use. Defaults to a fresh one inside the run
   * folder. Fake runs must never be given the real one (spend/global-spend.json):
   * fake spending would eat into the real lifetime cap.
   */
  spendFile?: string;
  clock?: () => Date;
  /** Receives the live ledger lines. */
  log?: (line: string) => void;
  /** Print the live line after every phase, or once per round (default). */
  logEvery?: 'phase' | 'round';
  label?: string;
}

export interface Position {
  level: number;
  round: number | null;
  phase: string;
}

export interface FakeRunResult {
  runId: string;
  runDir: string;
  spendFile: string;
  /** True when every phase of the game ran. */
  completed: boolean;
  stoppedBy: CapBreach | null;
  stopMessage: string | null;
  phasesRun: number;
  callsMade: number;
  /** The last phase that ran to the end. */
  lastPhase: Position | null;
  totals: LedgerTotals;
  warnings: string[];
}

/**
 * OpenRouter tells us what each call cost. The fake pretends it charged 2%
 * more than our price table, as happens when OpenRouter routes a call to a
 * pricier provider, so the run shows the ledger charging the larger figure.
 */
const FAKE_OPENROUTER_MARKUP = 1.02;

function where(p: Position): string {
  const round = p.round === null ? '' : ` R${String(p.round).padStart(2, '0')}`;
  return `L${p.level}${round} ${p.phase}`;
}

/** The usage a call of this shape would report. Stands in for a real model call. */
function fakeCall(
  seat: Seat,
  shape: CallShape,
  writesCache: boolean,
  prices: PriceTable,
): { usage: Usage; providerCostUsd: number | null } {
  // The provider counts the prompt with its own tokenizer (shapes are in Claude's tokens).
  const ratio = seat.tokenRatio ?? 1;
  const promptTokens = Math.round(shape.promptTokens * ratio);
  const cached = seat.caching === 'explicit' ? Math.min(Math.round(shape.cacheableTokens * ratio), promptTokens) : 0;
  // A provider that caches on its own serves about its measured share of each prompt from the cache.
  const automatic = seat.caching === 'automatic' && seat.measuredCacheShare !== undefined ? Math.round(promptTokens * seat.measuredCacheShare) : 0;
  const usage: Usage = {
    inputTokens: promptTokens - cached - automatic,
    cacheWriteTokens: writesCache ? cached : 0,
    cacheWrite1hTokens: 0,
    cacheReadTokens: (writesCache ? 0 : cached) + automatic,
    outputTokens: shape.expectedOutputTokens,
    reasoningTokens: 0,
  };
  const providerCostUsd =
    seat.provider === 'openrouter' ? costOfUsage(usage, priceOf(prices, seat.model)) * FAKE_OPENROUTER_MARKUP : null;
  return { usage, providerCostUsd };
}

export async function runFakePaidGame(opts: FakeRunOptions): Promise<FakeRunResult> {
  const clock = opts.clock ?? (() => new Date());
  const log = opts.log ?? (() => {});
  const logEvery = opts.logEvery ?? 'round';
  const { runId, runDir } = createRunFolder(opts.runsRoot, makeRunId(opts.label ?? 'fake', clock()));
  const spendFile = opts.spendFile ?? join(runDir, 'fake-global-spend.json');
  const seats = opts.cast.seats;
  const botIds = seats.map((s) => s.botId);
  const a = opts.game.estimate;
  const shapes = Object.fromEntries(gameCallShapes(a, opts.game.maxTokens).map((s) => [s.kind, s])) as Record<
    CallKind,
    CallShape
  >;
  const turnPhases =
    a.turnCallsPerRound === 3
      ? ['declare', 'talk', 'commit']
      : Array.from({ length: a.turnCallsPerRound }, (_, i) => `turn-${i + 1}`);

  const ledger = new Ledger(runId, opts.prices, clock);
  const global = await GlobalSpend.open(spendFile, runId, clock);
  const guard = new SpendGuard(opts.caps, ledger, global);

  // Explicit-cache seats write their cached prefix on their first call, and
  // again after each reflection (a reflection rewrites part of that prefix).
  const needsCacheWrite = new Set(botIds);

  // Kept in one object so the helper functions below can update it.
  const state = {
    phasesRun: 0,
    callsMade: 0,
    lastPhase: null as Position | null,
    stoppedBy: null as CapBreach | null,
    stopMessage: null as string | null,
  };

  const saveState = (completed: boolean) =>
    writeJsonAtomic(join(runDir, 'state.json'), {
      runId,
      kind: 'fake',
      savedAt: clock().toISOString(),
      completed,
      ...state,
    });

  /** Run one phase: every bot makes one call. Returns false if the caps say stop. */
  async function runPhase(position: Position, shape: CallShape): Promise<boolean> {
    // 1. Reserve the whole phase at its worst case, or don't start it at all.
    const reserved = guard.reserveAll(
      seats.map((seat) => ({
        botId: seat.botId,
        provider: seat.provider,
        worstCaseUsd:
          seat.provider === 'mock'
            ? 0
            : worstCaseCallUsd(
                worstCasePrice(priceOf(opts.prices, seat.model), seat.priceCeiling),
                shape.promptTokens,
                shape.maxOutputTokens,
              ),
      })),
    );
    if (!reserved.ok) {
      state.stoppedBy = reserved.breach;
      state.stopMessage = describeBreach(reserved.breach, `the next phase (${where(position)})`);
      return false;
    }

    // 2. All bots' calls at once; record and settle each as it comes back.
    await Promise.all(
      seats.map(async (seat, i) => {
        const call = fakeCall(seat, shape, needsCacheWrite.has(seat.botId), opts.prices); // FAKE CALL
        if (seat.caching === 'explicit') needsCacheWrite.delete(seat.botId);
        const entry = ledger.record({
          botId: seat.botId,
          phase: position.phase,
          level: position.level,
          round: position.round,
          model: seat.model,
          provider: seat.provider,
          usage: call.usage,
          providerCostUsd: call.providerCostUsd,
        });
        const reservation = reserved.reservations[i];
        if (reservation) guard.settle(reservation, entry);
      }),
    );

    // 3. Make sure the lifetime record is on disk before going on.
    await global.flush();
    state.phasesRun += 1;
    state.callsMade += seats.length;
    state.lastPhase = position;
    if (logEvery === 'phase') log(liveLine(where(position), ledger.totals(), opts.caps.runUsd, botIds));
    return true;
  }

  try {
    game: for (let level = 1; level <= a.levels; level++) {
      for (let round = 1; round <= a.roundsPerLevel; round++) {
        for (const phase of turnPhases) {
          if (!(await runPhase({ level, round, phase }, shapes.turn))) break game;
        }
        if (logEvery === 'round') {
          log(liveLine(`L${level} R${String(round).padStart(2, '0')}`, ledger.totals(), opts.caps.runUsd, botIds));
        }
        await saveState(false);
      }
      if (!(await runPhase({ level, round: null, phase: 'reflect' }, shapes.reflection))) break game;
      // The reflection rewrote each bot's notebook, which is part of its cached prefix.
      for (const id of botIds) needsCacheWrite.add(id);
      if (!(await runPhase({ level, round: null, phase: 'diary' }, shapes.diary))) break game;
      if (logEvery === 'round') log(liveLine(`L${level} level end`, ledger.totals(), opts.caps.runUsd, botIds));
    }
    if (state.stoppedBy === null) {
      await runPhase({ level: a.levels, round: null, phase: 'final-message' }, shapes.finalMessage);
    }
  } finally {
    // Whatever happened (finished, stopped by a cap, or crashed), save what we
    // have and give back the lifetime record's lock.
    const completed = state.stoppedBy === null && state.lastPhase?.phase === 'final-message';
    const pricesUsed = Object.fromEntries(
      seats.filter((s) => s.provider !== 'mock').map((s) => [s.model, priceOf(opts.prices, s.model)]),
    );
    await writeJsonAtomic(join(runDir, 'ledger.json'), {
      runId,
      kind: 'fake',
      caps: opts.caps,
      pricesUsed,
      completed,
      stopReason: state.stopMessage,
      totals: ledger.totals(),
      warnings: ledger.warnings(),
      entries: ledger.all(),
    });
    await saveState(completed);
    await global.close(state.stopMessage ?? (completed ? 'completed' : 'ended early'));
  }

  return {
    runId,
    runDir,
    spendFile,
    completed: state.stoppedBy === null && state.lastPhase?.phase === 'final-message',
    stoppedBy: state.stoppedBy,
    stopMessage: state.stopMessage,
    phasesRun: state.phasesRun,
    callsMade: state.callsMade,
    lastPhase: state.lastPhase,
    totals: ledger.totals(),
    warnings: ledger.warnings(),
  };
}
