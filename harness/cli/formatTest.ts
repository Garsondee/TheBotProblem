/**
 * npm run format-test [-- --dry-run] [--models haiku,deepseek,gemini] [--repeats 2] [--run-cap 0.30]
 * npm run format-test -- --rescore runs/<folder>
 *
 * Milestone 2's paid test: which way of showing the world do bots understand
 * best? Each model answers the ten questions in prompts/formatTest.ts in each
 * format, `repeats` times. Answers are scored against the engine's answer key,
 * and every "yes" plan is played in the engine to see whether it works.
 *
 * Money: the estimate is printed before anything is spent, and --dry-run stops
 * there. Every call is reserved against the run cap and the lifetime caps
 * before it is made, recorded raw in responses.jsonl, and priced into
 * ledger.json. --rescore re-scores a recorded run without calling anything.
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { ModelCall, ModelReply, Part } from '../../agents/models';
import { ClaudeClient, OpenRouterClient, ProviderError } from '../../agents/models';
import { percent, usd, usd4 } from '../../budget/format';
import { GlobalSpend } from '../../budget/globalSpend';
import { Ledger } from '../../budget/ledger';
import { fetchOpenRouterPrices } from '../../budget/openrouterPrices';
import type { PriceCeiling, PriceTable } from '../../budget/prices';
import { priceOf, worstCaseCallUsd, worstCasePrice } from '../../budget/prices';
import { describeBreach, SpendGuard } from '../../budget/spendGuard';
import { cacheHitShare } from '../../budget/usage';
import type { Reach } from '../../engine/affordances';
import { affordances, aloneWith, hasReached } from '../../engine/affordances';
import { resolvePhase } from '../../engine/resolve';
import { botById } from '../../engine/world';
import type { Answer, FormatName, Question } from '../../prompts/formatTest';
import {
  ANSWER_JSON_SCHEMA,
  AnswerSchema,
  asciiView,
  LABELS,
  numbersView,
  pngView,
  QUESTIONS,
  questionText,
  rules,
  sceneWorld,
} from '../../prompts/formatTest';
import { loadCast, loadGameConfig, loadPrices, PATHS, PROJECT_ROOT } from '../config';
import { KeyRing } from '../env';
import { sleep, writeJsonAtomic } from '../files';
import { say, warn } from '../log';
import { renderPng } from '../png';
import { redactSecrets } from '../redact';
import { createRunFolder, makeRunId } from '../runFolder';

const { values } = parseArgs({
  options: {
    'dry-run': { type: 'boolean', default: false },
    models: { type: 'string', default: 'haiku,deepseek,gemini' },
    formats: { type: 'string', default: 'ascii,numbers,png' },
    repeats: { type: 'string', default: '2' },
    'run-cap': { type: 'string', default: '0.30' },
    rescore: { type: 'string' },
  },
});

const MAX_TOKENS = 400;
const EXPECTED_OUTPUT = 150; // tokens in a typical answer, for the estimate

interface Subject {
  name: string;
  model: string;
  provider: 'anthropic' | 'openrouter';
  formats: FormatName[];
  ceiling?: PriceCeiling;
  cacheSystem: boolean;
}

const cast = loadCast();
const ceilingOf = (model: string) => cast.seats.find((s) => s.model === model)?.priceCeiling;
const ALL_SUBJECTS: Subject[] = [
  { name: 'haiku', model: 'claude-haiku-5-5', provider: 'anthropic', formats: ['ascii', 'numbers', 'png'], cacheSystem: true },
  // DeepSeek V4 Flash reads text only, so it gets no picture.
  { name: 'deepseek', model: 'deepseek/deepseek-v4-flash', provider: 'openrouter', formats: ['ascii', 'numbers'], ceiling: ceilingOf('deepseek/deepseek-v4-flash'), cacheSystem: false },
  { name: 'gemini', model: 'google/gemini-3.1-flash-lite', provider: 'openrouter', formats: ['ascii', 'numbers', 'png'], ceiling: ceilingOf('google/gemini-3.1-flash-lite'), cacheSystem: true },
];
const wanted = values.models.split(',').map((m) => m.trim());
const wantedFormats = values.formats.split(',').map((f) => f.trim());
const subjects = ALL_SUBJECTS.filter((s) => wanted.includes(s.name))
  .map((s) => ({ ...s, formats: s.formats.filter((f) => wantedFormats.includes(f)) }))
  .filter((s) => s.formats.length > 0);
const repeats = Math.max(1, Math.min(5, Number(values.repeats) || 2));

// The scene, the answer key, and the three views.
const world = sceneWorld();
const key = affordances(world, 'A', QUESTIONS.map((q) => q.target), { maxDepth: 6, maxStates: 8000 });
const truth = new Map<string, Reach>(key.reaches.map((r) => [r.id, r]));
const png = renderPng(world, LABELS);
const views: Record<FormatName, string> = {
  ascii: asciiView(world),
  numbers: numbersView(world, new Map(key.reaches.map((r) => [r.id, r.plan]))),
  png: pngView(),
};

function promptFor(subject: Subject, format: FormatName, q: Question, retryNote: string | null): ModelCall {
  const user: Part[] = [];
  if (format === 'png') user.push({ type: 'image', png, cache: subject.provider === 'anthropic' });
  user.push({ type: 'text', text: questionText(q) });
  if (retryNote) user.push({ type: 'text', text: `Your previous reply could not be used: ${retryNote}. Reply with only the JSON object.` });
  return {
    model: subject.model,
    // Stable first: the rules, then the view. The question comes last, after the cache breakpoint.
    system: [{ text: rules() }, { text: views[format], cache: format !== 'png' }],
    user,
    maxTokens: MAX_TOKENS,
    schema: ANSWER_JSON_SCHEMA,
  };
}

// ---------------------------------------------------------------- scoring (free)

interface Outcome {
  subject: string;
  format: FormatName;
  question: string;
  repeat: number;
  answer: Answer | null;
  verdictOk: boolean;
  /** For questions whose truth is "reachable": did the answer's plan work in the engine? */
  planOk: boolean | null;
  detail: string;
}

function parseAnswer(text: string): { ok: true; answer: Answer } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: 'the reply was not valid JSON' };
  }
  const parsed = AnswerSchema.safeParse(json);
  if (parsed.success) return { ok: true, answer: parsed.data };
  return { ok: false, error: `the JSON did not match the schema (${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')})` };
}

function score(subject: string, format: FormatName, q: Question, repeat: number, answer: Answer | null, why = 'no valid answer'): Outcome {
  const base = { subject, format, question: q.id, repeat, answer };
  const t = truth.get(q.target.id);
  if (!t) throw new Error(`no answer key for ${q.id}`);
  if (!answer) return { ...base, verdictOk: false, planOk: t.reachable ? false : null, detail: why };
  const verdictOk = answer.reachable === t.reachable;
  if (!t.reachable) {
    return { ...base, verdictOk, planOk: null, detail: verdictOk ? 'right: not reachable' : `wrong: claimed a way (${answer.commands.join(', ')})` };
  }
  if (!answer.reachable) return { ...base, verdictOk: false, planOk: false, detail: 'wrong: said not reachable' };
  // Play the bot's own plan, alone, with nominal stats, and see where it ends up.
  const sim = resolvePhase(aloneWith(world, 'A'), { A: answer.commands.slice(0, 6) }, { trace: false });
  const planOk = hasReached(sim.world, botById(sim.world, 'A'), q.target);
  const failed = sim.results.find((r) => r.status !== 'done');
  return {
    ...base,
    verdictOk,
    planOk,
    detail: planOk
      ? 'right, and the plan works'
      : `right, but the plan ${failed ? `fails at "${failed.command}": ${failed.reason}` : 'ends somewhere else'}`,
  };
}

interface Row {
  subject: string;
  format: FormatName;
  answers: number;
  verdicts: number;
  yesAsked: number;
  plansWorked: number;
  malformed: number;
  /** (right verdicts + working plans) / (answers + yes-questions asked): 1.0 is perfect. */
  score: number;
}

function summarise(outcomes: Outcome[]): Row[] {
  const rows: Row[] = [];
  for (const s of new Set(outcomes.map((o) => o.subject))) {
    for (const f of new Set(outcomes.filter((o) => o.subject === s).map((o) => o.format))) {
      const os = outcomes.filter((o) => o.subject === s && o.format === f);
      const yes = os.filter((o) => o.planOk !== null);
      const verdicts = os.filter((o) => o.verdictOk).length;
      const plansWorked = yes.filter((o) => o.planOk).length;
      rows.push({
        subject: s,
        format: f,
        answers: os.length,
        verdicts,
        yesAsked: yes.length,
        plansWorked,
        malformed: os.filter((o) => !o.answer).length,
        score: (verdicts + plansWorked) / (os.length + yes.length),
      });
    }
  }
  return rows;
}

function printTable(rows: Row[]): { winner: FormatName; byFormat: Record<string, number> } {
  say(`  ${'Model'.padEnd(9)} ${'Format'.padEnd(8)} ${'Right answers'.padEnd(16)} ${'Plans that work'.padEnd(16)} Score`);
  for (const r of rows) {
    say(
      `  ${r.subject.padEnd(9)} ${r.format.padEnd(8)} ${`${r.verdicts}/${r.answers}`.padEnd(6)} ${percent(r.verdicts / r.answers).padEnd(9)} ` +
        `${`${r.plansWorked}/${r.yesAsked}`.padEnd(6)} ${percent(r.yesAsked ? r.plansWorked / r.yesAsked : null).padEnd(9)} ${percent(r.score)}` +
        (r.malformed ? `  (${r.malformed} unusable)` : ''),
    );
  }
  const byFormat: Record<string, number> = {};
  for (const f of new Set(rows.map((r) => r.format))) {
    const fr = rows.filter((r) => r.format === f);
    byFormat[f] = fr.reduce((sum, r) => sum + r.score, 0) / fr.length;
  }
  const winner = (Object.entries(byFormat).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'numbers') as FormatName;
  say('');
  say(`  Average score per format: ${Object.entries(byFormat).map(([f, s]) => `${f} ${percent(s)}`).join(', ')}`);
  say(`  Winner: ${winner}`);
  return { winner, byFormat };
}

// ---------------------------------------------------------------- rescore (free)

if (values.rescore) {
  const dir = resolve(values.rescore);
  const lines = readFileSync(join(dir, 'responses.jsonl'), 'utf8').split('\n').filter(Boolean);
  const last = new Map<string, { subject: string; format: FormatName; question: string; repeat: number; text: string }>();
  for (const line of lines) {
    const r = JSON.parse(line) as { ok: boolean; subject: string; format: FormatName; question: string; repeat: number; text?: string };
    if (!r.ok || r.text === undefined || r.question === 'price-check') continue;
    const k = `${r.subject}|${r.format}|${r.question}|${r.repeat}`;
    if (!last.has(k) || parseAnswer(r.text).ok) last.set(k, { ...r, text: r.text });
  }
  const outcomes = [...last.values()].map((r) => {
    const q = QUESTIONS.find((x) => x.id === r.question);
    if (!q) throw new Error(`unknown question ${r.question}`);
    const parsed = parseAnswer(r.text);
    return score(r.subject, r.format, q, r.repeat, parsed.ok ? parsed.answer : null, parsed.ok ? undefined : parsed.error);
  });
  say(`Re-scored ${outcomes.length} recorded answers from ${relative(PROJECT_ROOT, dir)} (nothing was called).`);
  printTable(summarise(outcomes));
  process.exit(0);
}

// ---------------------------------------------------------------- the estimate

say('Interface format test (milestone 2)');
say(`  Answer key from the engine: ${key.reaches.filter((r) => r.reachable).length} of ${key.reaches.length} places reachable alone.`);
for (const q of QUESTIONS) {
  const t = truth.get(q.target.id);
  say(`    ${q.id.padEnd(4)} ${q.place.padEnd(46)} ${t?.reachable ? `yes: ${t.plan?.join(', ')}` : 'no'}`);
}

const ring = KeyRing.load(PROJECT_ROOT);
const claude = ring.has('ANTHROPIC_API_KEY') ? new ClaudeClient(ring.reveal('ANTHROPIC_API_KEY')) : null;
const router = ring.has('OPENROUTER_API_KEY') ? new OpenRouterClient(ring.reveal('OPENROUTER_API_KEY')) : null;
for (const s of subjects) {
  if ((s.provider === 'anthropic' && !claude) || (s.provider === 'openrouter' && !router)) {
    warn(`No key for ${s.name}'s provider in .env: run \`npm run keys\`.`);
    process.exit(1);
  }
  if (s.provider === 'openrouter' && !s.ceiling) {
    warn(`${s.model} has no priceCeiling in config/cast.json, so its cost can't be capped.`);
    process.exit(1);
  }
}

const prices: PriceTable = { ...loadPrices().table };
const routerModels = subjects.filter((s) => s.provider === 'openrouter').map((s) => s.model);
if (routerModels.length > 0) {
  const live = await fetchOpenRouterPrices(routerModels);
  Object.assign(prices, live.prices);
  for (const p of live.problems) warn(`OpenRouter: ${p}`);
}

// Prompt sizes: exact for Claude (Anthropic's token counter is free), estimated for the others.
const promptTokens = new Map<string, number>();
for (const s of subjects) {
  for (const f of s.formats) {
    const call = promptFor(s, f, QUESTIONS[0] as Question, null);
    const chars = call.system.reduce((n, b) => n + b.text.length, 0) + 60;
    const estimate = Math.ceil(chars / 3) + (f === 'png' ? 1600 : 0);
    promptTokens.set(`${s.name}:${f}`, s.provider === 'anthropic' && claude ? await claude.countTokens(call) : estimate);
  }
}

const runCap = Number(values['run-cap']);
let expectedTotal = 0;
let worstTotal = 0;
say('');
say(`  ${repeats} answer(s) per question per format, at most ${MAX_TOKENS} output tokens each.`);
say(`  ${'Model'.padEnd(9)} ${'Formats'.padEnd(20)} ${'Calls'.padStart(5)} ${'Prompt'.padStart(7)} ${'Expected'.padStart(9)} ${'Worst'.padStart(8)}`);
for (const s of subjects) {
  const price = priceOf(prices, s.model);
  const worstPrice = worstCasePrice(price, s.ceiling);
  let expected = 0;
  let worst = 0;
  const n = QUESTIONS.length * repeats;
  for (const f of s.formats) {
    const tokens = promptTokens.get(`${s.name}:${f}`) ?? 3000;
    if (s.provider === 'anthropic') {
      // First call writes the cached prefix; the rest read it.
      const q = 40;
      const prefix = tokens - q;
      expected += (prefix * (price.cacheWrite5m ?? price.input) + (n - 1) * prefix * (price.cacheRead ?? price.input) + n * q * price.input + n * EXPECTED_OUTPUT * price.output) / 1e6;
    } else {
      expected += (n * (tokens * price.input + EXPECTED_OUTPUT * price.output)) / 1e6;
    }
    worst += n * worstCaseCallUsd(worstPrice, Math.ceil(tokens * 1.25) + 200, MAX_TOKENS);
  }
  expectedTotal += expected;
  worstTotal += worst;
  const sizes = s.formats.map((f) => promptTokens.get(`${s.name}:${f}`) ?? 0);
  say(
    `  ${s.name.padEnd(9)} ${s.formats.join(', ').padEnd(20)} ${String(s.formats.length * n).padStart(5)} ${`~${Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length)}`.padStart(7)} ` +
      `${usd4(expected).padStart(9)} ${usd4(worst).padStart(8)}`,
  );
}
say(`  ${'Total'.padEnd(44)} ${usd4(expectedTotal).padStart(9)} ${usd4(worstTotal).padStart(8)}`);
say(`  Run cap ${usd(runCap)}; retries for unusable replies come out of the same cap.`);
if (values['dry-run']) {
  say('');
  say('Dry run: nothing was spent.');
  process.exit(0);
}

// ---------------------------------------------------------------- the paid run

const game = loadGameConfig();
const { runId, runDir } = createRunFolder(PATHS.runs, makeRunId('format-test'));
writeFileSync(join(runDir, 'scene.png'), png);
writeFileSync(join(runDir, 'rules.txt'), rules());
for (const f of ['ascii', 'numbers', 'png'] as const) writeFileSync(join(runDir, `view-${f}.txt`), views[f]);
await writeJsonAtomic(join(runDir, 'answer-key.json'), key);

const ledger = new Ledger(runId, prices);
const global = await GlobalSpend.open(join(PROJECT_ROOT, game.budget.spendFile), runId);
const guard = new SpendGuard({ runUsd: runCap, perBotUsd: runCap, globalUsd: { ...game.budget.globalCapUsd } }, ledger, global);
let stopped: string | null = null;
const responsesFile = join(runDir, 'responses.jsonl');
const record = (entry: Record<string, unknown>) => appendFileSync(responsesFile, redactSecrets(JSON.stringify({ at: new Date().toISOString(), ...entry })) + '\n');

/** One paid call: reserved, made, recorded raw, priced, settled. Null if the caps or the provider said no. */
async function paid(s: Subject, format: FormatName, call: ModelCall, meta: Record<string, unknown>, maxPrice?: PriceCeiling): Promise<ModelReply | null> {
  if (stopped) return null;
  const tokens = promptTokens.get(`${s.name}:${format}`) ?? 3000;
  const worst = worstCaseCallUsd(worstCasePrice(priceOf(prices, s.model), maxPrice ?? s.ceiling), Math.ceil(tokens * 1.25) + 200, call.maxTokens);
  const reserved = guard.reserve({ botId: null, provider: s.provider, worstCaseUsd: worst });
  if (!reserved.ok) {
    stopped = describeBreach(reserved.breach, 'the next call');
    return null;
  }
  const reservation = reserved.reservations[0];
  if (!reservation) return null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const reply =
        s.provider === 'anthropic'
          ? await (claude as ClaudeClient).call(call)
          : await (router as OpenRouterClient).call(call, { maxPrice: maxPrice ?? (s.ceiling as PriceCeiling), cacheSystem: s.cacheSystem });
      const entry = ledger.record({
        botId: null,
        phase: `format-test:${format}`,
        model: s.model,
        provider: s.provider,
        usage: reply.usage,
        providerCostUsd: reply.providerCostUsd,
      });
      guard.settle(reservation, entry);
      record({ ...meta, ok: true, stopReason: reply.stopReason, text: reply.text, usage: reply.usage, chargedUsd: entry.chargedUsd, raw: reply.raw });
      return reply;
    } catch (err) {
      const status = err instanceof ProviderError ? err.status : -1;
      record({ ...meta, ok: false, status, error: (err as Error).message });
      if ((status === 429 || status >= 500 || status === 0) && attempt < 3) {
        await sleep(3000 * attempt);
        continue;
      }
      guard.release(reservation); // a request the provider refused isn't billed
      if (!(err instanceof ProviderError)) throw err;
      return null;
    }
  }
  guard.release(reservation);
  return null;
}

/** Ask one question once; one retry if the reply is unusable. */
async function ask(s: Subject, format: FormatName, q: Question, repeat: number): Promise<Outcome> {
  let note: string | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const reply = await paid(s, format, promptFor(s, format, q, note), { subject: s.name, model: s.model, format, question: q.id, repeat, attempt });
    if (!reply) return score(s.name, format, q, repeat, null, stopped ?? 'the provider refused the call');
    if (reply.stopReason === 'max_tokens' || reply.stopReason === 'length') {
      note = 'it was cut off by the length limit';
      continue;
    }
    const parsed = parseAnswer(reply.text);
    if (parsed.ok) return score(s.name, format, q, repeat, parsed.answer);
    note = parsed.error;
  }
  return score(s.name, format, q, repeat, null, `no usable answer after a retry (${note})`);
}

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length && !stopped) await fn(items[next++] as T);
    }),
  );
}

say('');
say(`Running (folder ${relative(PROJECT_ROOT, runDir)})`);
const outcomes: Outcome[] = [];
try {
  // Before trusting price ceilings with money, check OpenRouter reads them as dollars per MILLION
  // tokens: a ceiling of $0.001 must find no provider at all. A refused request costs nothing.
  const deepseek = subjects.find((s) => s.provider === 'openrouter');
  if (deepseek) {
    const probe: ModelCall = {
      model: deepseek.model,
      system: [{ text: 'Reply with {"ok": true}.' }],
      user: [{ type: 'text', text: 'ok?' }],
      maxTokens: 10,
      schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
    };
    const reply = await paid(deepseek, 'ascii', probe, { subject: deepseek.name, question: 'price-check' }, { input: 0.001, output: 0.001 });
    if (reply) {
      warn('  PROBLEM: OpenRouter accepted a $0.001 price ceiling, so it does not read ceilings per million tokens. OpenRouter models skipped.');
      subjects.splice(0, subjects.length, ...subjects.filter((s) => s.provider !== 'openrouter'));
    } else {
      say('  Price ceilings: OpenRouter refused a $0.001-per-million ceiling, so ceilings mean what we think. Good.');
    }
  }

  for (const s of subjects) {
    for (const f of s.formats) {
      if (stopped) break;
      const jobs = Array.from({ length: repeats }, (_, i) => QUESTIONS.map((q) => ({ q, repeat: i + 1 }))).flat();
      const first = jobs.shift();
      // The first call alone writes the cache; the rest can then read it.
      if (first) outcomes.push(await ask(s, f, first.q, first.repeat));
      await pool(jobs, 4, async ({ q, repeat }) => {
        outcomes.push(await ask(s, f, q, repeat));
      });
      const row = summarise(outcomes.filter((o) => o.subject === s.name && o.format === f))[0];
      const spent = ledger.spentUsd();
      if (row) say(`  ${s.name.padEnd(9)} ${f.padEnd(8)} right ${row.verdicts}/${row.answers}, plans ${row.plansWorked}/${row.yesAsked}   (spent so far ${usd4(spent)})`);
    }
  }
} finally {
  await writeJsonAtomic(join(runDir, 'ledger.json'), {
    runId,
    kind: 'format-test',
    stopReason: stopped,
    totals: ledger.totals(),
    warnings: ledger.warnings(),
    entries: ledger.all(),
  });
  await global.close(stopped ?? 'completed');
}

// ---------------------------------------------------------------- results

outcomes.sort((a, b) => (a.subject + a.format + a.question).localeCompare(b.subject + b.format + b.question) || a.repeat - b.repeat);
const rows = summarise(outcomes);
say('');
say('Results');
const { winner, byFormat } = printTable(rows);
const totals = ledger.totals();
say('');
say(`  Spent ${usd4(totals.usd)} (estimate was ${usd4(expectedTotal)}).`);
for (const s of subjects) {
  const u = totals.byModel[s.model]?.usage;
  if (u) say(`  ${s.name}: ${percent(cacheHitShare(u))} of prompt tokens came from the cache; ${u.reasoningTokens} hidden reasoning tokens.`);
}
for (const w of ledger.warnings()) warn(`  Warning: ${w}`);
if (stopped) warn(`  Stopped early: ${stopped}`);

await writeJsonAtomic(join(runDir, 'results.json'), { runId, repeats, winner, byFormat, rows, outcomes, spentUsd: totals.usd, expectedUsd: expectedTotal });
const perQuestion = QUESTIONS.map((q) => {
  const cells = rows.map((r) => {
    const os = outcomes.filter((o) => o.subject === r.subject && o.format === r.format && o.question === q.id);
    return `${os.filter((o) => o.verdictOk).length}/${os.length}`;
  });
  return `| ${q.id} ${q.place} | ${truth.get(q.target.id)?.reachable ? 'yes' : 'no'} | ${cells.join(' | ')} |`;
});
writeFileSync(
  join(runDir, 'report.md'),
  [
    `# Interface format test, ${new Date().toISOString().slice(0, 10)}`,
    '',
    `Winner: **${winner}**. Average score per format: ${Object.entries(byFormat).map(([f, s]) => `${f} ${percent(s)}`).join(', ')}.`,
    `Spent ${usd4(totals.usd)} on ${totals.calls} calls; ${repeats} answer(s) per question per format.`,
    '',
    '| Model | Format | Right answers | Plans that work | Score |',
    '|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.subject} | ${r.format} | ${r.verdicts}/${r.answers} | ${r.plansWorked}/${r.yesAsked} | ${percent(r.score)} |`),
    '',
    'Right answers per question:',
    '',
    `| Question | Truth | ${rows.map((r) => `${r.subject} ${r.format}`).join(' | ')} |`,
    `|---|---|${rows.map(() => '---').join('|')}|`,
    ...perQuestion,
  ].join('\n') + '\n',
);
say(`  Saved in ${relative(PROJECT_ROOT, runDir)}: report.md, results.json, responses.jsonl, ledger.json, scene.png, views.`);
// The image library keeps a worker thread alive, which would hold the program open forever.
process.exit(0);
