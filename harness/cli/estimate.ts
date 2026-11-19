/**
 * npm run estimate [-- --config config/cast.json] [--offline]
 *
 * What would one full game cost with this cast? Prints the expected cost and
 * the worst case per seat, compares them with the run cap, the per-bot caps
 * and what's left of your lifetime budget, and spends nothing.
 *
 * OpenRouter prices are fetched live (free, no key) unless --offline, which
 * uses the saved snapshot in config/openrouter-prices.json.
 */
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { estimateCast, gameCallShapes } from '../../budget/estimate';
import { usd } from '../../budget/format';
import { readLifetimeSpend } from '../../budget/globalSpend';
import { fetchOpenRouterPrices } from '../../budget/openrouterPrices';
import { capsFor, configProblems, loadCast, loadGameConfig, loadPrices, PATHS, PROJECT_ROOT } from '../config';
import { describeKeys, KeyRing } from '../env';
import { say, warn } from '../log';

const { values } = parseArgs({
  options: { config: { type: 'string' }, offline: { type: 'boolean', default: false } },
});
const castPath = values.config ? resolve(values.config) : PATHS.cast;
const game = loadGameConfig();
const cast = loadCast(castPath);
const { table, sources } = loadPrices();
const a = game.estimate;

// OpenRouter prices: live if we can reach OpenRouter, otherwise the snapshot.
const openRouterModels = [...new Set(cast.seats.filter((s) => s.provider === 'openrouter').map((s) => s.model))];
const snapshot = sources.find((s) => s.file === PATHS.openrouterPrices);
let openRouterSource = snapshot ? `saved snapshot from ${snapshot.checkedOn.slice(0, 10)}` : 'no prices yet';
if (openRouterModels.length > 0 && !values.offline) {
  try {
    const live = await fetchOpenRouterPrices(openRouterModels);
    Object.assign(table, live.prices);
    openRouterSource = 'live from openrouter.ai, just now';
    for (const problem of live.problems) warn(`OpenRouter: ${problem}`);
  } catch (err) {
    warn(`Couldn't reach OpenRouter (${(err as Error).message}). Using the ${openRouterSource}.`);
  }
}

const shapes = gameCallShapes(a, game.maxTokens);
const estimate = estimateCast(cast.seats, table, shapes, a.cacheWritesPerGame);
const caps = capsFor(game, cast);
const anthropicSource = sources.find((s) => s.file === PATHS.prices);

say(`One full game with cast "${cast.name}" (${relative(PROJECT_ROOT, castPath)})`);
say(
  `  ${a.levels} levels x ${a.roundsPerLevel} rounds, ${a.turnCallsPerRound} turn calls per bot per round, ` +
    'plus reflections, diaries and final messages.',
);
say(
  `  Token counts are the spec's assumptions (${a.turnPromptTokens.toLocaleString('en-US')}-token prompts, ` +
    `${a.turnCacheableTokens.toLocaleString('en-US')} cacheable, ~${a.turnOutputTokens}-token replies) ` +
    'until milestone 3 measures real prompts.',
);
say(
  `  Prices: Anthropic from config/prices.json (checked ${anthropicSource?.checkedOn ?? '?'}); ` +
    `OpenRouter ${openRouterSource}.`,
);
say();
say(`  ${'Bot'.padEnd(4)} ${'Model'.padEnd(31)} ${'Provider'.padEnd(11)} ${'Calls'.padStart(5)} ${'Expected'.padStart(10)} ${'Worst case'.padStart(11)}`);
for (const s of estimate.seats) {
  say(
    `  ${s.botId.padEnd(4)} ${s.model.padEnd(31)} ${s.provider.padEnd(11)} ${String(s.calls).padStart(5)} ` +
      `${usd(s.expectedUsd).padStart(10)} ${usd(s.worstCaseUsd).padStart(11)}`,
  );
}
say(`  ${'Total'.padEnd(53)} ${usd(estimate.expectedUsd).padStart(10)} ${usd(estimate.worstCaseUsd).padStart(11)}`);
for (const [provider, sums] of Object.entries(estimate.byProvider)) {
  say(`    ${provider.padEnd(51)} ${usd(sums.expectedUsd).padStart(10)} ${usd(sums.worstCaseUsd).padStart(11)}`);
}

say();
say('Against the caps (config/game.json)');
if (estimate.worstCaseUsd <= caps.runUsd) {
  say(`  Run cap ${usd(caps.runUsd)}: the expected game fits, and so does the worst case.`);
} else if (estimate.expectedUsd <= caps.runUsd) {
  say(
    `  Run cap ${usd(caps.runUsd)}: the expected game fits. In the worst case (${usd(estimate.worstCaseUsd)}) ` +
      'the cap stops the run early, cleanly, with everything saved.',
  );
} else {
  const share = Math.round((caps.runUsd / estimate.expectedUsd) * 100);
  say(
    `  Run cap ${usd(caps.runUsd)}: too low for this cast. The expected game costs ${usd(estimate.expectedUsd)}, ` +
      `so the cap would stop it about ${share}% of the way through. Raise the run cap for this cast.`,
  );
}
const overBot = estimate.seats.filter((s) => s.expectedUsd > (caps.perBotOverrideUsd?.[s.botId] ?? caps.perBotUsd));
say(
  overBot.length === 0
    ? `  Per-bot cap (${usd(caps.perBotUsd)} unless a seat sets its own): every seat's expected cost fits.`
    : `  Per-bot cap: ${overBot.map((s) => `${s.botId} expects ${usd(s.expectedUsd)}`).join('; ')}, above its cap.`,
);
const lifetime = readLifetimeSpend(join(PROJECT_ROOT, game.budget.spendFile)) ?? {};
for (const [provider, sums] of Object.entries(estimate.byProvider)) {
  if (provider === 'mock' || sums.expectedUsd === 0) continue;
  const cap = caps.globalUsd[provider as 'anthropic' | 'openrouter'] ?? 0;
  const left = Math.max(0, cap - (lifetime[provider as 'anthropic' | 'openrouter'] ?? 0));
  const games = Math.floor(left / sums.expectedUsd);
  say(
    `  Lifetime ${provider} budget: ${usd(left)} left of ${usd(cap)}, enough for about ${games} game(s) like this` +
      (provider === 'anthropic' ? ' (before analysis costs).' : '.'),
  );
}

const notes = estimate.seats.flatMap((s) => s.notes.map((n) => `${s.botId}: ${n}`));
const problems = configProblems(game, table);
const tooBig = shapes.filter((s) => s.promptTokens > game.budget.promptTokenHardLimit);
if (notes.length + problems.length + tooBig.length > 0) {
  say();
  say('Notes');
  for (const n of notes) say(`  ${n}`);
  for (const p of problems) say(`  PROBLEM: ${p}`);
  for (const s of tooBig) say(`  PROBLEM: ${s.kind} prompts (${s.promptTokens} tokens) exceed the hard limit.`);
}

say();
say('Keys');
for (const line of describeKeys(KeyRing.load(PROJECT_ROOT).report, cast.seats)) say(`  ${line}`);
say();
say('Nothing was spent. A paid run only happens when you say so.');
