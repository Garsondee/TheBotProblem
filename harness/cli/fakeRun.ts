/**
 * npm run fake-run [-- --run-cap 0.10] [--bot-cap 0.05] [--global-cap 0.30] [--config <cast file>] [--every phase]
 *
 * Plays a whole game's worth of FAKE model calls through the real money
 * machinery (price table, ledger, spend caps) and saves the results to a new
 * folder in runs/. No network, no real money, and your real lifetime spend
 * record is never touched: each fake run gets a fresh fake one.
 *
 * Try a small cap to watch it stop the run cleanly:
 *   npm run fake-run -- --run-cap 0.10
 */
import { relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { usd } from '../../budget/format';
import { capsFor, loadCast, loadGameConfig, loadPrices, PATHS, PROJECT_ROOT } from '../config';
import { runFakePaidGame } from '../fakeRun';
import { say, warn } from '../log';

const { values } = parseArgs({
  options: {
    'run-cap': { type: 'string' },
    'bot-cap': { type: 'string' },
    'global-cap': { type: 'string' },
    config: { type: 'string' },
    every: { type: 'string' },
  },
});

function dollars(flag: string): number | undefined {
  const raw = values[flag as keyof typeof values];
  if (raw === undefined || typeof raw !== 'string') return undefined;
  const amount = Number(raw);
  if (!Number.isFinite(amount) || amount < 0) {
    warn(`--${flag} needs an amount in dollars, like 0.10`);
    process.exit(1);
  }
  return amount;
}

const game = loadGameConfig();
const cast = loadCast(values.config ? resolve(values.config) : PATHS.cast);
const { table } = loadPrices();
const caps = capsFor(game, cast);
const runCap = dollars('run-cap');
const botCap = dollars('bot-cap');
const globalCap = dollars('global-cap');
if (runCap !== undefined) caps.runUsd = runCap;
if (botCap !== undefined) {
  caps.perBotUsd = botCap;
  caps.perBotOverrideUsd = {};
}
if (globalCap !== undefined) caps.globalUsd = { anthropic: globalCap, openrouter: globalCap };

say('Fake paid run: invented token counts, real prices, real caps. No network, no money.');
say(`Cast "${cast.name}": ${cast.seats.map((s) => `${s.botId} ${s.model}`).join(', ')}`);
say(
  `Caps: run ${usd(caps.runUsd)}, per bot ${usd(caps.perBotUsd)}, lifetime anthropic ` +
    `${usd(caps.globalUsd.anthropic ?? 0)} / openrouter ${usd(caps.globalUsd.openrouter ?? 0)} (on a fresh fake record)`,
);
say();

const result = await runFakePaidGame({
  runsRoot: PATHS.runs,
  cast,
  prices: table,
  game,
  caps,
  log: say,
  logEvery: values.every === 'phase' ? 'phase' : 'round',
});

say();
if (result.completed) {
  say('Done: the whole game ran inside its caps.');
} else {
  say(`Stopped cleanly. ${result.stopMessage ?? ''}`);
}
say(
  `Spent ${usd(result.totals.usd)} (fake) on ${result.callsMade.toLocaleString('en-US')} calls ` +
    `over ${result.phasesRun} phases.`,
);
say(`  ${Object.entries(result.totals.byBot).map(([bot, b]) => `${bot} ${usd(b.usd)}`).join('   ')}`);
for (const w of result.warnings) say(`  Warning: ${w}`);
say(`Saved in ${relative(PROJECT_ROOT, result.runDir)}: ledger.json, state.json, fake-global-spend.json`);
