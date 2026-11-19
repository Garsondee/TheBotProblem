/**
 * npm run prices
 *
 * Fetches today's OpenRouter prices for every OpenRouter model named in any
 * config/cast*.json, prints them, and saves a dated snapshot to
 * config/openrouter-prices.json, which offline estimates and fake runs use.
 * Free: OpenRouter's models API needs no key, so none is sent.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fetchOpenRouterPrices, OPENROUTER_MODELS_URL } from '../../budget/openrouterPrices';
import type { ModelPrice } from '../../budget/prices';
import { PriceFileSchema } from '../../budget/prices';
import { loadCast, PATHS } from '../config';
import { readJsonFile, writeJsonAtomic } from '../files';
import { say, warn } from '../log';

const castFiles = readdirSync(PATHS.configDir)
  .filter((name) => /^cast(\..+)?\.json$/.test(name))
  .map((name) => join(PATHS.configDir, name));
const wanted = [
  ...new Set(
    castFiles.flatMap((file) =>
      loadCast(file)
        .seats.filter((seat) => seat.provider === 'openrouter')
        .map((seat) => seat.model),
    ),
  ),
].sort();

if (wanted.length === 0) {
  say('No OpenRouter models in any config/cast*.json, so there is nothing to price.');
  process.exit(0);
}

say(`Fetching prices for ${wanted.length} OpenRouter model(s) from ${OPENROUTER_MODELS_URL} (free, no key sent).`);
const { prices, problems } = await fetchOpenRouterPrices(wanted);
const previous = existsSync(PATHS.openrouterPrices)
  ? readJsonFile(PATHS.openrouterPrices, PriceFileSchema).models
  : {};

const money = (n: number | undefined) => (n === undefined ? '-' : `$${Number(n.toPrecision(4))}`);
const differs = (a: ModelPrice, b: ModelPrice) =>
  a.input !== b.input || a.output !== b.output || a.cacheRead !== b.cacheRead || a.cacheWrite5m !== b.cacheWrite5m;

say('Per million tokens:');
for (const [model, p] of Object.entries(prices)) {
  say(
    `  ${model.padEnd(32)} in ${money(p.input).padEnd(9)} out ${money(p.output).padEnd(9)} ` +
      `cache read ${money(p.cacheRead).padEnd(11)} cache write ${money(p.cacheWrite5m)}`,
  );
  const before = previous[model];
  if (before && differs(before, p)) {
    say(`    Changed since the last snapshot (was in ${money(before.input)}, out ${money(before.output)}).`);
  }
}
for (const problem of problems) warn(`  Problem: ${problem}`);

await writeJsonAtomic(PATHS.openrouterPrices, {
  $comment:
    'Snapshot of OpenRouter prices in US dollars per MILLION tokens, written by `npm run prices` from the free models API. Paid runs fetch fresh prices when they start; this file serves offline estimates and fake runs.',
  checkedOn: new Date().toISOString(),
  sources: [OPENROUTER_MODELS_URL],
  models: prices,
});
say(`Saved to config/openrouter-prices.json.`);
if (problems.length > 0) process.exitCode = 1;
