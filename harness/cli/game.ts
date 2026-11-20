/**
 * npm run game -- --mock                    a free game, every seat played by MockAgent
 * npm run game -- --scripted                a free game played by the levels' own solutions
 * npm run game -- --dry-run                 the cost estimate for a paid game, nothing spent
 * npm run game -- [--yes]                   a paid game with the cast in config/cast.json
 *
 * Options for any game:
 *   --levels P0,L1      only these rooms (by the start of their id), in their usual order
 *   --max-rounds 2      at most this many rounds per room (smoke tests)
 *   --seed some-text    the seed (default: made from the clock, and recorded)
 *   --cast file.json    another cast file
 *   --run-cap 0.50      this run's spending cap in US dollars (default: config/game.json)
 *   --exile-from 1      the room (0 = the first) from which exile votes can be called,
 *                       for this game only (default: config/game.json, "social")
 *   --talk-every 3      talk only every 3rd round in every room (the rest are silent), for this game only
 *   --no-host           no host this game: no introductions, judge, praise or offers (config/game.json "host")
 *   --no-judge          introductions, but nobody judges them
 *   --praise            the host congratulates the richest bot at each room's start
 *   --bounty first_out:3,left_behind:2
 *                       coins the host offers in every puzzle room, paid at its end
 *                       (first_out, richest, left_behind, holding_lever)
 *   --turn-order letter who acts first when it matters: by letter, or by name (config/game.json "social";
 *                       by name, the bots are never told)
 *   --check-run runs/x  no game: the estimate check for a game already played (give it
 *                       that game's seed, rooms and memory options); free
 *
 * Money (spec section 0, "Money rules"): a paid game first prints its
 * estimate, worked out from real prompts (a free mock game of the same rooms
 * is played first to measure them), then waits for you to type yes. --yes
 * skips the question, for when the yes has already been given. Every phase is
 * reserved against the run, per-bot and lifetime caps before it starts, and
 * the game saves and stops at the first phase it can't afford.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import type { Agent } from '../../agents/agent';
import { JUDGE_ID } from '../../agents/agent';
import { LlmAgent } from '../../agents/llmAgent';
import { MockAgent } from '../../agents/mockAgent';
import { MockJudge } from '../../agents/mockJudge';
import { ClaudeClient, OpenRouterClient } from '../../agents/models';
import { ScriptedAgent } from '../../agents/scriptedAgent';
import type { CallShape, SeatPlan } from '../../budget/estimate';
import { estimateCast, estimateSeat } from '../../budget/estimate';
import { liveLine, usd, usd4 } from '../../budget/format';
import { GlobalSpend, readLifetimeSpend } from '../../budget/globalSpend';
import type { LedgerEntry } from '../../budget/ledger';
import { Ledger } from '../../budget/ledger';
import { fetchOpenRouterPrices } from '../../budget/openrouterPrices';
import type { PriceTable } from '../../budget/prices';
import { priceOf } from '../../budget/prices';
import { SpendGuard } from '../../budget/spendGuard';
import { cacheHitShare } from '../../budget/usage';
import type { BountyDef, Level } from '../../engine/level';
import { BountySchema } from '../../engine/level';
import { RunRandom } from '../../engine/random';
import type { GameResult, HostSettings, Money } from '../../game/game';
import type { TurnOrder } from '../../game/order';
import { runGame } from '../../game/game';
import type { MemoryBank } from '../../game/memory';
import { agentIdsFor, dealLetters, emptyBank, identitiesFor, updateBank } from '../../game/memory';
import { bankFromReplay, loadBank, saveBank } from '../memoryFiles';
import { MemoryOutput } from '../../game/output';
import { summaryMarkdown } from '../../game/summary';
import type { Seat } from '../config';
import { capsFor, configProblems, loadCast, loadGameConfig, loadPrices, PATHS, PROJECT_ROOT } from '../config';
import { KeyRing } from '../env';
import { writeJsonAtomic } from '../files';
import { FileOutput } from '../gameFiles';
import { loadExperimentLevels, loadLevels } from '../levels';
import { say, warn } from '../log';
import { createRunFolder, makeRunId } from '../runFolder';

const { values } = parseArgs({
  options: {
    mock: { type: 'boolean', default: false },
    scripted: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    yes: { type: 'boolean', default: false },
    levels: { type: 'string' },
    'max-rounds': { type: 'string' },
    seed: { type: 'string' },
    cast: { type: 'string' },
    'run-cap': { type: 'string' },
    memory: { type: 'string' },
    fresh: { type: 'boolean', default: false },
    'continue-from': { type: 'string' },
    'exile-from': { type: 'string' },
    'check-run': { type: 'string' },
    'talk-every': { type: 'string' },
    'no-host': { type: 'boolean', default: false },
    'no-judge': { type: 'boolean', default: false },
    praise: { type: 'boolean', default: false },
    bounty: { type: 'string' },
    'turn-order': { type: 'string' },
  },
});

const game = loadGameConfig();
const cast = loadCast(values.cast ? resolve(values.cast) : PATHS.cast);
const allLevels = loadLevels();
const wanted = values.levels?.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
// Experiment rooms (config/levels/experiments) play only when a game names them.
const levels: Level[] = wanted ? [...allLevels, ...loadExperimentLevels()].filter((l) => wanted.some((w) => l.id.toLowerCase().startsWith(w))) : allLevels;
if (levels.length === 0) {
  warn(`No rooms match --levels ${values.levels}. Rooms: ${allLevels.map((l) => l.id).join(', ')}`);
  process.exit(1);
}
const maxRounds = values['max-rounds'] ? Math.max(1, Number(values['max-rounds'])) : undefined;
const roundsOf = (l: Level) => Math.min(l.rounds, maxRounds ?? l.rounds);
const free = values.mock || values.scripted;
const label = values.mock ? 'mock' : values.scripted ? 'scripted' : 'game';
const runIdGuess = makeRunId(label);
const seed = values.seed ?? runIdGuess;
const maxTokens = { turn: game.maxTokens.turn, reflection: game.maxTokens.reflection, diary: game.maxTokens.diary, intro: game.host.introMaxTokens, judge: game.host.judgeMaxTokens };

// ---------------------------------------------------------------- who sits where, and what they remember
// Paid games keep each agent's memory (name, notebook, strategy) in a bank, unless --fresh; free games only with --memory.
const useMemory = !values.fresh && (values.memory !== undefined || !free);
const bankName = values.memory ?? 'default';
let bank: MemoryBank = useMemory ? loadBank(bankName) : emptyBank();
if (useMemory && values['continue-from'] && Object.keys(bank.agents).length === 0) {
  const from = values['continue-from'].replace(/^runs[\\/]/, '');
  bank = bankFromReplay(readFileSync(join(PATHS.runs, from, 'replay.jsonl'), 'utf8'), seed);
  say(`Memory bank "${bankName}" starts from the bots of ${from}.`);
}
// With memory, letters are dealt afresh (seeded), so a private rename stays private.
const dealt = dealLetters(agentIdsFor(cast.seats), useMemory ? new RunRandom(seed).stream('roles') : null);
const identities = useMemory ? identitiesFor(bank, dealt) : undefined;
const seatOf = (letter: string): Seat => ({ ...(cast.seats[dealt.find((d) => d.letter === letter)?.seat ?? 0] as Seat), botId: letter });
const botIds = dealt.map((d) => d.letter);

say(`TheBotProblem: ${free ? `a free ${label} game` : 'a paid game'}, seed "${seed}"`);
say(`Rooms: ${levels.map((l) => `${l.id} (${roundsOf(l)} rounds)`).join(', ')}`);
if (useMemory) {
  const known = dealt.filter((d) => bank.agents[d.agent]);
  say(`Memory bank "${bankName}": ${known.length === 0 ? 'every agent starts fresh' : `${known.length} agent${known.length === 1 ? '' : 's'} remember earlier games`}; letters dealt afresh.`);
}

// A short game (a pilot) can unlock exile earlier; the rulebook tells the bots from which room.
const turnOrderFlag = values['turn-order'];
if (turnOrderFlag !== undefined && turnOrderFlag !== 'letter' && turnOrderFlag !== 'name') {
  warn('--turn-order is letter or name.');
  process.exit(1);
}
const turnOrder: TurnOrder = turnOrderFlag === 'letter' || turnOrderFlag === 'name' ? turnOrderFlag : game.social.turnOrder;
const social = {
  ...game.social,
  ...(values['exile-from'] !== undefined ? { exileFromRoom: Math.max(0, Math.floor(Number(values['exile-from']))) } : {}),
  turnOrder,
};
if (values['exile-from'] !== undefined) say(`Exile votes from room ${social.exileFromRoom + 1} of ${levels.length} (this game only).`);
say(social.turnOrder === 'name' ? 'Turn order: by name, A to Z (never told to the bots).' : 'Turn order: by letter.');

// The talk cadence for this game, overriding each room's own (an experiment's setting).
const talkEvery = values['talk-every'] ? Math.max(1, Math.floor(Number(values['talk-every']))) : undefined;
if (talkEvery) say(`Talk only every ${talkEvery} rounds, in every room (this game only).`);

// The host (prompts/host.ts): config/game.json's, changed for this game by the flags.
const extraBounties: BountyDef[] = (values.bounty ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => {
    const [kind, coins] = s.split(':');
    const parsed = BountySchema.safeParse({ for: kind, coins: Number(coins) });
    if (!parsed.success) {
      warn(`--bounty ${s}: give it as kind:coins, with kind one of first_out, richest, left_behind, holding_lever, and 1 to 20 coins.`);
      process.exit(1);
    }
    return parsed.data;
  });
const noHost = values['no-host'];
const host: HostSettings = {
  intros: !noHost && game.host.intros,
  judge: !noHost && !values['no-judge'] && game.host.judge,
  praise: !noHost && (values.praise || game.host.praise),
  bounties: noHost ? [] : [...game.host.bounties, ...extraBounties],
  roomOffers: !noHost,
};
say(
  noHost
    ? 'No host this game.'
    : `The host: ${[host.intros ? `introductions${host.judge ? ` (judged by ${free ? 'the free mock judge' : game.host.judgeModel})` : ' (not judged)'}` : null, host.praise ? 'praise for the richest' : null, host.bounties.length > 0 ? `offers in every puzzle room (${host.bounties.map((b) => `${b.for} ${b.coins}`).join(', ')})` : null]
        .filter(Boolean)
        .join('; ') || 'nothing but the rooms\' own offers'}.`,
);

const baseOptions = {
  seed,
  levels,
  ranges: game.hiddenStats,
  maxTokens,
  promptTokenLimit: game.budget.promptTokenHardLimit,
  social,
  host,
  ...(talkEvery ? { talkEvery } : {}),
  ...(identities ? { identities } : {}),
  ...(maxRounds ? { maxRounds } : {}),
};

/** After a finished game, the bank remembers it: notebooks, strategies, and names (private new ones included). */
async function remember(result: GameResult): Promise<void> {
  if (!useMemory) return;
  if (!result.completed) {
    say(`Memory bank "${bankName}" not updated: the game didn't finish, so the bots never wrote their last notebooks.`);
    return;
  }
  bank = updateBank(bank, dealt, cast.seats.map((s) => s.model), {
    seed,
    names: result.names,
    nextNames: result.nextNames,
    notebooks: result.notebooks,
    strategies: result.strategies,
    personas: result.personas,
    introductions: result.introductions,
  });
  await saveBank(bankName, bank);
  say(`Memory bank "${bankName}" updated: ${Object.keys(result.nextNames).length} bot${Object.keys(result.nextNames).length === 1 ? '' : 's'} chose a new name for next time.`);
}

/**
 * Set by a paid game once its estimate is made: after the game, the calls
 * actually made, priced by the same model the estimate used. A room that ends
 * early cuts calls, so the estimate made beforehand (every round played) can't
 * be compared with the bill directly; this check can (milestone 5: "cost
 * within 20% of estimate").
 */
let estimateCheck: ((entries: readonly LedgerEntry[]) => { expectedUsd: number; chargedUsd: number; lines: string[] }) | null = null;

/** Play the game and save everything to a new run folder. */
async function playAndSave(agents: Agent[], judge: Agent | undefined, money: Money | null, runCapUsd: number | null): Promise<GameResult> {
  const { runId, runDir } = createRunFolder(PATHS.runs, runIdGuess);
  say(`Run folder: ${relative(PROJECT_ROOT, runDir)}`);
  writeFileSync(join(runDir, 'cast.json'), `${JSON.stringify(cast, null, 2)}\n`);
  const output = new FileOutput(runDir);
  let result: GameResult | null = null;
  try {
    result = await runGame({
      ...baseOptions,
      agents,
      ...(judge ? { judge } : {}),
      output,
      money,
      log: (line) => say(line),
      onRound: ({ level, round }) => {
        if (money && runCapUsd !== null) say(`  ${liveLine(`${level} R${String(round).padStart(2, '0')}`, money.ledger.totals(), runCapUsd, botIds)}`);
      },
    });
    return result;
  } finally {
    const check = money && estimateCheck ? estimateCheck(money.ledger.all()) : null;
    if (money) {
      await writeJsonAtomic(join(runDir, 'ledger.json'), {
        runId,
        kind: 'game',
        caps: money.guard.caps,
        completed: result?.completed ?? false,
        stopReason: result?.stopReason ?? 'the game ended with an error',
        totals: money.ledger.totals(),
        estimateCheck: check,
        warnings: money.ledger.warnings(),
        entries: money.ledger.all(),
      });
      await money.global?.close(result?.stopReason ?? (result ? 'completed' : 'ended with an error'));
    }
    if (result) {
      const totals = money?.ledger.totals();
      const off = check && check.expectedUsd > 0 ? (check.chargedUsd - check.expectedUsd) / check.expectedUsd : null;
      const costLine = totals
        ? `Spent ${usd4(totals.usd)} (run cap ${usd(runCapUsd ?? 0)}).${off !== null ? ` For the calls actually made the estimate said ${usd4(check?.expectedUsd ?? 0)}: ${off >= 0 ? '+' : ''}${Math.round(off * 100)}%.` : ''}`
        : 'Free: no paid calls.';
      writeFileSync(
        join(runDir, 'summary.md'),
        summaryMarkdown(result, {
          runId,
          seed,
          seats: agents.map((a) => ({ bot: a.id, provider: a.provider, model: a.model })).sort((a, b) => a.bot.localeCompare(b.bot)),
          costLine,
          teamBonusPerRoom: game.social.teamBonusPerRoom,
        }),
      );
      say('');
      say(`${result.completed ? 'Game over.' : `Stopped: ${result.stopReason}`} ${costLine}`);
      for (const r of result.rooms) say(`  ${r.id}: ${r.roundsPlayed} rounds; ${r.reason}; through: ${r.through.join(' ') || 'nobody'}`);
      if (totals) {
        for (const [model, bucket] of Object.entries(totals.byModel)) {
          say(`  ${model}: ${usd4(bucket.usd)} over ${bucket.calls} calls; ${Math.round((cacheHitShare(bucket.usage) ?? 0) * 100)}% of prompt tokens from the cache; ${bucket.usage.reasoningTokens} hidden reasoning tokens`);
        }
        for (const w of money?.ledger.warnings() ?? []) warn(`  Warning: ${w}`);
        for (const l of check?.lines ?? []) say(l);
      }
      say(`  Saved: ${relative(PROJECT_ROOT, runDir)} (summary.md, replay.jsonl, responses.jsonl, prompts.jsonl, state/${money ? ', ledger.json' : ''})`);
    }
  }
}

// ---------------------------------------------------------------- free games
if (free) {
  const agents: Agent[] = botIds.map((id) => (values.scripted ? new ScriptedAgent(id, levels) : new MockAgent(id, seed)));
  await remember(await playAndSave(agents, host.judge ? new MockJudge() : undefined, null, null));
  process.exit(0);
}

// ---------------------------------------------------------------- a paid game: keys and prices
const problems = configProblems(game, loadPrices().table);
if (problems.length > 0) {
  for (const p of problems) warn(p);
  process.exit(1);
}
const ring = KeyRing.load(PROJECT_ROOT);
const needs = new Set(cast.seats.map((s) => s.provider));
const missing = [needs.has('anthropic') && !ring.has('ANTHROPIC_API_KEY') ? 'ANTHROPIC_API_KEY' : null, needs.has('openrouter') && !ring.has('OPENROUTER_API_KEY') ? 'OPENROUTER_API_KEY' : null].filter(Boolean);
if (missing.length > 0 && !values['dry-run']) {
  warn(`Missing in .env: ${missing.join(', ')}. Run \`npm run keys\`, or play a free game with --mock.`);
  process.exit(1);
}
const claude = ring.has('ANTHROPIC_API_KEY') ? new ClaudeClient(ring.reveal('ANTHROPIC_API_KEY')) : null;
const router = ring.has('OPENROUTER_API_KEY') ? new OpenRouterClient(ring.reveal('OPENROUTER_API_KEY')) : null;

const prices: PriceTable = { ...loadPrices().table };
const routerModels = [...new Set(cast.seats.filter((s) => s.provider === 'openrouter').map((s) => s.model))];
if (routerModels.length > 0) {
  try {
    const live = await fetchOpenRouterPrices(routerModels);
    Object.assign(prices, live.prices);
    for (const p of live.problems) warn(`OpenRouter: ${p}`);
  } catch (err) {
    warn(`Couldn't fetch live OpenRouter prices (${(err as Error).message}); using the saved snapshot.`);
  }
}

// ---------------------------------------------------------------- the estimate, from real prompts
say('');
say('Measuring prompts on a free mock game of the same rooms...');
const probe = new MemoryOutput();
await runGame({ ...baseOptions, agents: botIds.map((id) => new MockAgent(id, seed)), ...(host.judge ? { judge: new MockJudge() } : {}), output: probe, money: null });
const blocks = new Map(probe.prompts.filter((p) => p.rec === 'block').map((p) => [p.hash as string, (p.text as string).length]));
const sent = probe.prompts.filter((p) => p.rec === 'prompt' && p.attempt === 1);
const turnPrompts = sent.filter((p) => ['declare', 'talk', 'commit'].includes(p.phase as string));
const introPrompts = sent.filter((p) => p.phase === 'intro');
const judgePrompts = sent.filter((p) => p.phase === 'judge');
const reflectPrompts = sent.filter((p) => p.phase === 'reflect');
const diaryPrompts = sent.filter((p) => p.phase === 'diary');
const meanChars = (list: Record<string, unknown>[], part: 'user' | 'system') =>
  list.reduce((n, p) => n + (part === 'user' ? (p.user as string).length : (p.system as string[]).reduce((m, h) => m + (blocks.get(h) ?? 0), 0)), 0) / Math.max(1, list.length);
// Real bots say more than mock ones, and their notebooks grow: leave room for both. Calibrated on
// the M5 pilot (2026-11-20), where real Haiku prompts averaged about 1,500 tokens more than the mock
// game measured (4,000 + 2,000 characters had overestimated them by about 14%).
const TALK_ALLOWANCE_CHARS = 2_000;
const NOTEBOOK_ALLOWANCE_CHARS = 1_500;
const prefixChars = meanChars(turnPrompts, 'system') + NOTEBOOK_ALLOWANCE_CHARS;
// The start of each view (what the bot sees, its moves, last round) is cached too: written by the round's first call, read by the other two.
const stableViewChars = turnPrompts.reduce((n, p) => n + ((p.userCacheBreak as number | null) ?? 0), 0) / Math.max(1, turnPrompts.length);
// Real introductions run to about 100 words where the mock's are 15. A bot hears the others' in its round-1
// view (three calls per room, spread here over all its turns), and its own last one comes back in its next
// introduction prompt; the judge reads each bot's with up to three earlier ones (always three with memory).
const INTRO_EXTRA_CHARS = 450;
const introViewChars = host.intros ? (INTRO_EXTRA_CHARS * (botIds.length - 1) * 3 * levels.length) / Math.max(1, turnPrompts.length / botIds.length) : 0;
const turnChars = prefixChars + meanChars(turnPrompts, 'user') + TALK_ALLOWANCE_CHARS + introViewChars;
const introChars = prefixChars + meanChars(introPrompts, 'user') + INTRO_EXTRA_CHARS;
const introsPerJudge = botIds.length * (levels.reduce((n, _, k) => n + 1 + (useMemory ? 3 : Math.min(k, 3)), 0) / levels.length);
const judgeChars = meanChars(judgePrompts, 'system') + meanChars(judgePrompts, 'user') + INTRO_EXTRA_CHARS * introsPerJudge;
const reflectChars = prefixChars + meanChars(reflectPrompts, 'user') + TALK_ALLOWANCE_CHARS;
const diaryChars = prefixChars + meanChars(diaryPrompts, 'user') + TALK_ALLOWANCE_CHARS;

// Characters per token, measured on one real prompt with Anthropic's free token counter when we can.
let charsPerToken = 3.0;
const sample = turnPrompts.at(-1);
if (claude && sample) {
  const text = [...(sample.system as string[]).map((h) => probe.prompts.find((p) => p.rec === 'block' && p.hash === h)?.text as string), sample.user as string];
  const tokens = await claude.countTokens({ model: 'claude-haiku-5-5', system: text.slice(0, -1).map((t) => ({ text: t })), user: [{ type: 'text', text: text.at(-1) ?? '' }], maxTokens: 1, schema: {} });
  charsPerToken = text.join('').length / tokens;
  say(`  Token counter: one real prompt is ${tokens} tokens (${charsPerToken.toFixed(2)} characters a token).`);
}
const tokensOf = (chars: number) => Math.ceil(chars / charsPerToken);
const totalRounds = levels.reduce((n, l) => n + roundsOf(l), 0);
// Rounds with talk get three calls (declare, talk, commit); silent rounds (the talk cadence) get one.
const talkRounds = levels.reduce((n, l) => n + Math.ceil(roundsOf(l) / (talkEvery ?? l.talkEvery ?? 1)), 0);
const turnsPerSeat = talkRounds * 2 + totalRounds;
const shapes: CallShape[] = [
  {
    // A round's first call (declare) reads the rulebook and notebook from the cache and writes the round's view:
    // a cache write costs a quarter more than plain input, so that quarter is added.
    kind: 'turn',
    phases: ['declare'],
    callsPerGame: talkRounds,
    promptTokens: tokensOf(turnChars) + Math.ceil(tokensOf(stableViewChars) / 4),
    cacheableTokens: tokensOf(prefixChars),
    expectedOutputTokens: game.estimate.turnOutputTokens,
    maxOutputTokens: maxTokens.turn,
  },
  {
    // Its other two calls (talk, commit) read the view from the cache as well.
    kind: 'turn',
    phases: ['talk', 'commit'],
    callsPerGame: talkRounds + totalRounds,
    promptTokens: tokensOf(turnChars),
    cacheableTokens: tokensOf(prefixChars + stableViewChars),
    expectedOutputTokens: game.estimate.turnOutputTokens,
    maxOutputTokens: maxTokens.turn,
  },
  {
    kind: 'reflection',
    phases: ['reflect'],
    callsPerGame: levels.length,
    promptTokens: tokensOf(reflectChars),
    cacheableTokens: tokensOf(prefixChars),
    freshCache: true,
    expectedOutputTokens: game.estimate.reflectionOutputTokens,
    maxOutputTokens: maxTokens.reflection,
  },
  {
    // The diary room (spec 7.10): one short private entry at each room's end.
    kind: 'diary',
    phases: ['diary'],
    callsPerGame: levels.length,
    promptTokens: tokensOf(diaryChars),
    cacheableTokens: tokensOf(prefixChars),
    freshCache: true,
    expectedOutputTokens: game.estimate.diaryOutputTokens,
    maxOutputTokens: maxTokens.diary,
  },
];
if (host.intros) {
  shapes.push({
    // Each bot's introduction before each room, sent without cache marks: its own reply schema could never
    // read the turns' cache, and writing one costs more than plain input.
    kind: 'intro',
    phases: ['intro'],
    callsPerGame: levels.length,
    promptTokens: tokensOf(introChars),
    cacheableTokens: 0,
    uncached: true,
    expectedOutputTokens: game.estimate.introOutputTokens,
    maxOutputTokens: maxTokens.intro,
  });
}
// The silent judge: one call per room, on its own seat, never cached (its prompt is new every time).
const judgeSeat: Seat | null = host.intros && host.judge ? { botId: JUDGE_ID, provider: 'anthropic', model: game.host.judgeModel, caching: 'none' } : null;
const judgeShapes: CallShape[] = [
  {
    kind: 'judge',
    phases: ['judge'],
    callsPerGame: levels.length,
    promptTokens: tokensOf(judgeChars),
    cacheableTokens: 0,
    uncached: true,
    expectedOutputTokens: game.estimate.judgeOutputTokens,
    maxOutputTokens: maxTokens.judge,
  },
];
const judgePlan: SeatPlan | null = judgeSeat ? { botId: JUDGE_ID, model: judgeSeat.model, provider: 'anthropic', caching: 'none' } : null;
// One plan per letter as dealt this game (with memory on, letters are dealt afresh, so a letter's model changes from game to game).
const plans: SeatPlan[] = botIds.map((letter) => {
  const s = seatOf(letter);
  return {
    botId: letter,
    model: s.model,
    provider: s.provider,
    caching: s.caching,
    ...(s.priceCeiling ? { priceCeiling: s.priceCeiling } : {}),
    ...(s.measuredCacheShare !== undefined ? { measuredCacheShare: s.measuredCacheShare } : {}),
    ...(s.tokenRatio !== undefined ? { tokenRatio: s.tokenRatio } : {}),
  };
});
// Cache writes of the rulebook and notebook: once at the start, and again after each room (a reflection rewrites the notebook).
const seatsEstimate = estimateCast(plans, prices, shapes, levels.length + 1);
const judgeEstimate = judgePlan ? estimateSeat(judgePlan, priceOf(prices, judgePlan.model), judgeShapes, 0) : null;
const estimate = {
  seats: [...seatsEstimate.seats, ...(judgeEstimate ? [judgeEstimate] : [])],
  expectedUsd: seatsEstimate.expectedUsd + (judgeEstimate?.expectedUsd ?? 0),
  worstCaseUsd: seatsEstimate.worstCaseUsd + (judgeEstimate?.worstCaseUsd ?? 0),
};
estimateCheck = (entries) => {
  const lines: string[] = ['  Estimate check: the calls actually made, priced by the estimate (expected / charged):'];
  let expectedUsd = 0;
  let chargedUsd = 0;
  for (const [plan, planShapes, writes] of [...plans.map((p) => [p, shapes, levels.length + 1] as const), ...(judgePlan ? [[judgePlan, judgeShapes, 0] as const] : [])]) {
    const mine = entries.filter((e) => e.botId === plan.botId);
    if (mine.length === 0 || plan.provider === 'mock') continue;
    const actual = planShapes.map((s) => ({ ...s, callsPerGame: mine.filter((e) => s.phases?.includes(e.phase)).length }));
    const expected = estimateSeat(plan, priceOf(prices, plan.model), actual, writes).expectedUsd;
    const charged = mine.reduce((n, e) => n + e.chargedUsd, 0);
    expectedUsd += expected;
    chargedUsd += charged;
    lines.push(`    ${plan.botId} ${plan.model.padEnd(30)} ${String(mine.length).padStart(4)} calls  ${usd4(expected)} / ${usd4(charged)}  (${charged >= expected ? '+' : ''}${Math.round(((charged - expected) / Math.max(expected, 1e-9)) * 100)}%)`);
  }
  lines.push(`    All: ${usd4(expectedUsd)} / ${usd4(chargedUsd)}  (${chargedUsd >= expectedUsd ? '+' : ''}${Math.round(((chargedUsd - expectedUsd) / Math.max(expectedUsd, 1e-9)) * 100)}%)`);
  return { expectedUsd, chargedUsd, lines };
};
const runCap = values['run-cap'] ? Number(values['run-cap']) : game.budget.runCapUsd;
// A seat's own per-bot cap follows its agent to whichever letter it was dealt this game.
const caps = {
  ...capsFor(game, cast),
  runUsd: runCap,
  perBotOverrideUsd: Object.fromEntries(botIds.flatMap((letter) => {
    const s = seatOf(letter);
    return s.capUsd !== undefined ? [[letter, s.capUsd]] : [];
  })),
};

say('');
say(
  `Estimate (nothing spent yet), if every round of every room is played: ${turnsPerSeat} turn calls, ${host.intros ? `${levels.length} introductions, ` : ''}${levels.length} diary entr${levels.length === 1 ? 'y' : 'ies'} and ${levels.length} reflection${levels.length === 1 ? '' : 's'} per bot` +
    `${judgeSeat ? `, and ${levels.length} calls to the judge (${judgeSeat.model})` : ''}. Rooms that end sooner cost less.`,
);
say(
  `  Prompts: about ${shapes[1]?.promptTokens} tokens a turn (${shapes[0]?.cacheableTokens} of them the cached rulebook and notebook, ` +
    `${(shapes[1]?.cacheableTokens ?? 0) - (shapes[0]?.cacheableTokens ?? 0)} the round's view, cached after its first call), about ${shapes[2]?.promptTokens} a reflection.`,
);
say(`  ${'Bot'.padEnd(4)} ${'Model'.padEnd(30)} ${'Calls'.padStart(5)} ${'Expected'.padStart(10)} ${'Worst case'.padStart(11)}`);
for (const s of estimate.seats) {
  say(`  ${s.botId.padEnd(4)} ${s.model.padEnd(30)} ${String(s.calls).padStart(5)} ${usd4(s.expectedUsd).padStart(10)} ${usd4(s.worstCaseUsd).padStart(11)}`);
  for (const n of s.notes) say(`       ${n}`);
}
say(`  ${'Total'.padEnd(41)} ${usd4(estimate.expectedUsd).padStart(10)} ${usd4(estimate.worstCaseUsd).padStart(11)}`);
const lifetime = readLifetimeSpend(join(PROJECT_ROOT, game.budget.spendFile)) ?? {};
say(
  `  Caps: this run ${usd(caps.runUsd)}, each bot ${usd(caps.perBotUsd)}; lifetime room left: ` +
    Object.entries(caps.globalUsd)
      .map(([p, cap]) => `${p} ${usd(Math.max(0, (cap ?? 0) - (lifetime[p as keyof typeof lifetime] ?? 0)))}`)
      .join(', ') +
    '.',
);
say('  If the next phase could break a cap, the game saves and stops before it.');
// --check-run: the estimate check for a game already played, from its ledger. Give the same
// --seed, --levels, --exile-from and memory options as that game had, so the prompts measured match.
if (values['check-run']) {
  const dir = resolve(values['check-run']);
  const ledger = JSON.parse(readFileSync(join(dir, 'ledger.json'), 'utf8')) as { entries: LedgerEntry[] };
  const check = estimateCheck?.(ledger.entries);
  say('');
  for (const l of check?.lines ?? []) say(l);
  process.exit(0);
}
if (values['dry-run']) {
  say('');
  say('Dry run: nothing was spent.');
  process.exit(0);
}

// ---------------------------------------------------------------- the paid game
if (!values.yes) {
  if (!process.stdin.isTTY) {
    warn('Not starting: a paid game needs a yes. Run it in a terminal, or pass --yes if the yes was already given.');
    process.exit(1);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`Start the paid game (expected about ${usd4(estimate.expectedUsd)}, at most ${usd(caps.runUsd)})? Type yes: `)).trim().toLowerCase();
  rl.close();
  if (answer !== 'yes') {
    say('Not started. Nothing was spent.');
    process.exit(0);
  }
}
for (const s of cast.seats) priceOf(prices, s.model === 'mock' ? 'claude-haiku-5-5' : s.model); // every paid seat must have a price
const ledger = new Ledger(runIdGuess, prices);
const global = await GlobalSpend.open(join(PROJECT_ROOT, game.budget.spendFile), runIdGuess);
const guard = new SpendGuard(caps, ledger, global);
const agents: Agent[] = botIds.map((letter) => {
  const s = seatOf(letter);
  return s.provider === 'mock' ? new MockAgent(letter, seed) : new LlmAgent(s, { claude, router }, priceOf(prices, s.model));
});
// The judge is a real model in a paid game; without the Anthropic key it can't sit, so nobody judges.
let judge: Agent | undefined;
if (judgeSeat) {
  if (claude) judge = new LlmAgent(judgeSeat, { claude, router }, priceOf(prices, judgeSeat.model));
  else {
    warn('The judge needs the Anthropic key, which is missing: introductions will not be judged this game.');
    host.judge = false;
  }
}
await remember(await playAndSave(agents, judge, { guard, ledger, global }, caps.runUsd));
process.exit(0);
