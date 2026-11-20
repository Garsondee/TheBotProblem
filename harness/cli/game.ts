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
 *
 * Money (spec section 0, "Money rules"): a paid game first prints its
 * estimate, worked out from real prompts (a free mock game of the same rooms
 * is played first to measure them), then waits for you to type yes. --yes
 * skips the question, for when the yes has already been given. Every phase is
 * reserved against the run, per-bot and lifetime caps before it starts, and
 * the game saves and stops at the first phase it can't afford.
 */
import { writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import type { Agent } from '../../agents/agent';
import { LlmAgent } from '../../agents/llmAgent';
import { MockAgent } from '../../agents/mockAgent';
import { ClaudeClient, OpenRouterClient } from '../../agents/models';
import { ScriptedAgent } from '../../agents/scriptedAgent';
import type { CallShape, SeatPlan } from '../../budget/estimate';
import { estimateCast } from '../../budget/estimate';
import { liveLine, usd, usd4 } from '../../budget/format';
import { GlobalSpend, readLifetimeSpend } from '../../budget/globalSpend';
import { Ledger } from '../../budget/ledger';
import { fetchOpenRouterPrices } from '../../budget/openrouterPrices';
import type { PriceTable } from '../../budget/prices';
import { priceOf } from '../../budget/prices';
import { SpendGuard } from '../../budget/spendGuard';
import { cacheHitShare } from '../../budget/usage';
import type { Level } from '../../engine/level';
import type { GameResult, Money } from '../../game/game';
import { runGame } from '../../game/game';
import { MemoryOutput } from '../../game/output';
import { summaryMarkdown } from '../../game/summary';
import type { Seat } from '../config';
import { capsFor, configProblems, loadCast, loadGameConfig, loadPrices, PATHS, PROJECT_ROOT } from '../config';
import { KeyRing } from '../env';
import { writeJsonAtomic } from '../files';
import { FileOutput } from '../gameFiles';
import { loadLevels } from '../levels';
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
  },
});

const game = loadGameConfig();
const cast = loadCast(values.cast ? resolve(values.cast) : PATHS.cast);
const allLevels = loadLevels();
const wanted = values.levels?.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const levels: Level[] = wanted ? allLevels.filter((l) => wanted.some((w) => l.id.toLowerCase().startsWith(w))) : allLevels;
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
const botIds = cast.seats.map((s) => s.botId).sort();
const maxTokens = { turn: game.maxTokens.turn, reflection: game.maxTokens.reflection };

say(`TheBotProblem: ${free ? `a free ${label} game` : 'a paid game'}, seed "${seed}"`);
say(`Rooms: ${levels.map((l) => `${l.id} (${roundsOf(l)} rounds)`).join(', ')}`);

const baseOptions = {
  seed,
  levels,
  ranges: game.hiddenStats,
  maxTokens,
  promptTokenLimit: game.budget.promptTokenHardLimit,
  ...(maxRounds ? { maxRounds } : {}),
};

/** Play the game and save everything to a new run folder. */
async function playAndSave(agents: Agent[], money: Money | null, runCapUsd: number | null): Promise<GameResult> {
  const { runId, runDir } = createRunFolder(PATHS.runs, runIdGuess);
  say(`Run folder: ${relative(PROJECT_ROOT, runDir)}`);
  writeFileSync(join(runDir, 'cast.json'), `${JSON.stringify(cast, null, 2)}\n`);
  const output = new FileOutput(runDir);
  let result: GameResult | null = null;
  try {
    result = await runGame({
      ...baseOptions,
      agents,
      output,
      money,
      log: (line) => say(line),
      onRound: ({ level, round }) => {
        if (money && runCapUsd !== null) say(`  ${liveLine(`${level} R${String(round).padStart(2, '0')}`, money.ledger.totals(), runCapUsd, botIds)}`);
      },
    });
    return result;
  } finally {
    if (money) {
      await writeJsonAtomic(join(runDir, 'ledger.json'), {
        runId,
        kind: 'game',
        caps: money.guard.caps,
        completed: result?.completed ?? false,
        stopReason: result?.stopReason ?? 'the game ended with an error',
        totals: money.ledger.totals(),
        warnings: money.ledger.warnings(),
        entries: money.ledger.all(),
      });
      await money.global?.close(result?.stopReason ?? (result ? 'completed' : 'ended with an error'));
    }
    if (result) {
      const totals = money?.ledger.totals();
      const costLine = totals ? `Spent ${usd4(totals.usd)} (run cap ${usd(runCapUsd ?? 0)}).` : 'Free: no paid calls.';
      writeFileSync(
        join(runDir, 'summary.md'),
        summaryMarkdown(result, { runId, seed, seats: agents.map((a) => ({ bot: a.id, provider: a.provider, model: a.model })).sort((a, b) => a.bot.localeCompare(b.bot)), costLine }),
      );
      say('');
      say(`${result.completed ? 'Game over.' : `Stopped: ${result.stopReason}`} ${costLine}`);
      for (const r of result.rooms) say(`  ${r.id}: ${r.roundsPlayed} rounds; ${r.reason}; through: ${r.through.join(' ') || 'nobody'}`);
      if (totals) {
        for (const [model, bucket] of Object.entries(totals.byModel)) {
          say(`  ${model}: ${usd4(bucket.usd)} over ${bucket.calls} calls; ${Math.round((cacheHitShare(bucket.usage) ?? 0) * 100)}% of prompt tokens from the cache; ${bucket.usage.reasoningTokens} hidden reasoning tokens`);
        }
        for (const w of money?.ledger.warnings() ?? []) warn(`  Warning: ${w}`);
      }
      say(`  Saved: ${relative(PROJECT_ROOT, runDir)} (summary.md, replay.jsonl, responses.jsonl, prompts.jsonl, state/${money ? ', ledger.json' : ''})`);
    }
  }
}

// ---------------------------------------------------------------- free games
if (free) {
  const agents: Agent[] = botIds.map((id) => (values.scripted ? new ScriptedAgent(id, levels) : new MockAgent(id, seed)));
  await playAndSave(agents, null, null);
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
await runGame({ ...baseOptions, agents: botIds.map((id) => new MockAgent(id, seed)), output: probe, money: null });
const blocks = new Map(probe.prompts.filter((p) => p.rec === 'block').map((p) => [p.hash as string, (p.text as string).length]));
const sent = probe.prompts.filter((p) => p.rec === 'prompt' && p.attempt === 1);
const turnPrompts = sent.filter((p) => p.phase !== 'reflect');
const reflectPrompts = sent.filter((p) => p.phase === 'reflect');
const meanChars = (list: Record<string, unknown>[], part: 'user' | 'system') =>
  list.reduce((n, p) => n + (part === 'user' ? (p.user as string).length : (p.system as string[]).reduce((m, h) => m + (blocks.get(h) ?? 0), 0)), 0) / Math.max(1, list.length);
// Real bots say more than mock ones (up to 2 messages of 60 words, each step): leave room for it.
const TALK_ALLOWANCE_CHARS = 4_000;
const NOTEBOOK_ALLOWANCE_CHARS = 2_000; // notebooks grow to at most 600 words after the first room
const prefixChars = meanChars(turnPrompts, 'system') + NOTEBOOK_ALLOWANCE_CHARS;
// The start of each view (what the bot sees, its moves, last round) is cached too: written by the round's first call, read by the other two.
const stableViewChars = turnPrompts.reduce((n, p) => n + ((p.userCacheBreak as number | null) ?? 0), 0) / Math.max(1, turnPrompts.length);
const turnChars = prefixChars + meanChars(turnPrompts, 'user') + TALK_ALLOWANCE_CHARS;
const reflectChars = prefixChars + meanChars(reflectPrompts, 'user') + TALK_ALLOWANCE_CHARS;

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
const turnsPerSeat = totalRounds * 3;
const shapes: CallShape[] = [
  {
    // A round's first call (declare) reads the rulebook and notebook from the cache and writes the round's view:
    // a cache write costs a quarter more than plain input, so that quarter is added.
    kind: 'turn',
    callsPerGame: totalRounds,
    promptTokens: tokensOf(turnChars) + Math.ceil(tokensOf(stableViewChars) / 4),
    cacheableTokens: tokensOf(prefixChars),
    expectedOutputTokens: game.estimate.turnOutputTokens,
    maxOutputTokens: maxTokens.turn,
  },
  {
    // Its other two calls (talk, commit) read the view from the cache as well.
    kind: 'turn',
    callsPerGame: totalRounds * 2,
    promptTokens: tokensOf(turnChars),
    cacheableTokens: tokensOf(prefixChars + stableViewChars),
    expectedOutputTokens: game.estimate.turnOutputTokens,
    maxOutputTokens: maxTokens.turn,
  },
  {
    kind: 'reflection',
    callsPerGame: levels.length,
    promptTokens: tokensOf(reflectChars),
    cacheableTokens: tokensOf(prefixChars),
    expectedOutputTokens: game.estimate.reflectionOutputTokens,
    maxOutputTokens: maxTokens.reflection,
  },
];
const plans: SeatPlan[] = cast.seats.map((s: Seat) => ({ botId: s.botId, model: s.model, provider: s.provider, caching: s.caching, ...(s.priceCeiling ? { priceCeiling: s.priceCeiling } : {}) }));
// Cache writes of the rulebook and notebook: once at the start, and again after each room (a reflection rewrites the notebook).
const estimate = estimateCast(plans, prices, shapes, levels.length + 1);
const runCap = values['run-cap'] ? Number(values['run-cap']) : game.budget.runCapUsd;
const caps = { ...capsFor(game, cast), runUsd: runCap };

say('');
say(`Estimate (nothing spent yet): ${turnsPerSeat} turn calls and ${levels.length} reflection${levels.length === 1 ? '' : 's'} per bot.`);
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
const agents: Agent[] = cast.seats.map((s) =>
  s.provider === 'mock' ? new MockAgent(s.botId, seed) : new LlmAgent(s, { claude, router }, priceOf(prices, s.model)),
);
await playAndSave(agents, { guard, ledger, global }, caps.runUsd);
process.exit(0);
