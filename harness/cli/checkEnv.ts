/**
 * npm run check-env [-- --online]
 *
 * Says which API keys are in .env (never the keys themselves) and what that
 * means for each seat of the default cast.
 *
 * With --online it also checks that the keys work, using endpoints that
 * cost nothing: Anthropic's model list (no model is run) and OpenRouter's
 * key and credit pages. It also shows how much OpenRouter credit is left.
 */
import Anthropic from '@anthropic-ai/sdk';
import { parseArgs } from 'node:util';
import { usd } from '../../budget/format';
import { loadCast, loadPrices, PROJECT_ROOT } from '../config';
import { describeKeys, KeyRing } from '../env';
import { say } from '../log';

const { values } = parseArgs({ options: { online: { type: 'boolean', default: false } } });
const ring = KeyRing.load(PROJECT_ROOT);
const cast = loadCast();

say('Keys');
for (const line of describeKeys(ring.report, cast.seats)) say(`  ${line}`);

if (!values.online) {
  say();
  say('Nothing was sent anywhere. For a free check that the keys work: npm run check-env -- --online');
  process.exit(0);
}

say();
say('Online check (free: no model is run and nothing is spent)');

if (ring.has('ANTHROPIC_API_KEY')) {
  const models = Object.entries(loadPrices().table)
    .filter(([, price]) => price.provider === 'anthropic')
    .map(([model]) => model);
  await checkAnthropic(models);
} else {
  say('  Anthropic: skipped, no key in .env.');
}

if (ring.has('OPENROUTER_API_KEY')) {
  await checkOpenRouter();
} else {
  say('  OpenRouter: skipped, no key in .env.');
}

async function checkAnthropic(models: string[]): Promise<void> {
  const client = new Anthropic({
    apiKey: ring.reveal('ANTHROPIC_API_KEY'),
    // Both set on purpose. Left alone, the SDK reads ANTHROPIC_BASE_URL and
    // ANTHROPIC_AUTH_TOKEN from the environment, and the Claude desktop app
    // sets a base URL for its own use. We want exactly this key, at exactly
    // Anthropic's public API.
    baseURL: 'https://api.anthropic.com',
    authToken: null,
    maxRetries: 1,
    timeout: 20_000,
  });
  for (const model of models) {
    try {
      // Reading a model's description is free; it doesn't run the model.
      const info = await client.models.retrieve(model);
      const details: string[] = [info.lifecycle];
      if (info.max_input_tokens) details.push(`${Math.round(info.max_input_tokens / 1000)}K-token context`);
      if (info.retires_at) details.push(`retires ${info.retires_at.slice(0, 10)}`);
      say(`  Anthropic: ${model} is available to this key (${info.display_name}; ${details.join(', ')}).`);
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) {
        say('  Anthropic: the key was refused (401). Re-enter it with `npm run keys`.');
        return;
      }
      if (err instanceof Anthropic.NotFoundError) {
        say(`  Anthropic: ${model} was not found for this key (404). The model id in config/prices.json may be wrong.`);
        continue;
      }
      say(`  Anthropic: couldn't check ${model}: ${(err as Error).message}`);
    }
  }
}

async function checkOpenRouter(): Promise<void> {
  const headers = { authorization: `Bearer ${ring.reveal('OPENROUTER_API_KEY')}`, accept: 'application/json' };
  try {
    const keyPage = await fetch('https://openrouter.ai/api/v1/key', { headers, signal: AbortSignal.timeout(20_000) });
    if (keyPage.status === 401 || keyPage.status === 403) {
      say(`  OpenRouter: the key was refused (${keyPage.status}). Re-enter it with \`npm run keys\`.`);
      return;
    }
    if (!keyPage.ok) {
      say(`  OpenRouter: answered ${keyPage.status}, so the key couldn't be checked.`);
      return;
    }
    say('  OpenRouter: the key works.');
    const creditPage = await fetch('https://openrouter.ai/api/v1/credits', {
      headers,
      signal: AbortSignal.timeout(20_000),
    });
    const body = creditPage.ok
      ? ((await creditPage.json()) as { data?: { total_credits?: unknown; total_usage?: unknown } })
      : {};
    const total = body.data?.total_credits;
    const used = body.data?.total_usage;
    if (typeof total === 'number' && typeof used === 'number') {
      say(`  OpenRouter: ${usd(total - used)} of credit left (${usd(total)} bought, ${usd(used)} used).`);
    } else {
      say("  OpenRouter: couldn't read the credit balance from its reply.");
    }
  } catch (err) {
    say(`  OpenRouter: couldn't reach it: ${(err as Error).message}`);
  }
}
