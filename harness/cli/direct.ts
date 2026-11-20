/**
 * npm run direct -- <run>             the Director tells a recorded game as a story (paid, small)
 * npm run direct -- <run> --dry-run   the estimate only; nothing is spent
 * npm run direct -- <run> --free      the free Director: flags and plain narration, no model
 * npm run direct -- <run> --fresh     pay again even for calls already recorded
 * npm run direct -- <run> --yes       skip the typed yes (only when the yes was already given)
 * npm run direct -- <run> --spoken-only   keep the story; make only its spoken script (paid, small)
 *
 * <run> is a folder in runs/ (its name, or runs/<name>). The story goes to
 * runs/<name>/story.json, which the viewer plays as its Story mode, and its
 * spoken script (analysis/spoken.ts: every bot line it shows, reworded for the
 * ear, meaning kept) to runs/<name>/spoken.json, which npm run voice reads.
 * The Director's replies are recorded in runs/<name>/director/, so directing
 * the same game again costs nothing unless something it reads has changed.
 */
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import type { DirectorCall, DirectorCaller, DirectorModels, RoomNotes } from '../../analysis/director';
import { directStory, EDIT_JSON_SCHEMA, editPrompt, freeStory, parseRoomNotes, ROOM_JSON_SCHEMA, roomPrompt, storyScript } from '../../analysis/director';
import { flagRounds } from '../../analysis/material';
import type { StoryLine } from '../../analysis/spoken';
import { parseSpoken, SPOKEN_BATCH, SPOKEN_JSON_SCHEMA, SPOKEN_SYSTEM, spokenPrompt, storyLines } from '../../analysis/spoken';
import { buildScript } from '../../viewer/src/script';
import { ClaudeClient } from '../../agents/models';
import { usd, usd4 } from '../../budget/format';
import { GlobalSpend, readLifetimeSpend } from '../../budget/globalSpend';
import { Ledger } from '../../budget/ledger';
import { priceOf, worstCaseCallUsd } from '../../budget/prices';
import { SpendGuard } from '../../budget/spendGuard';
import { parseReplay } from '../../viewer/src/data';
import type { Story } from '../../viewer/src/story';
import { quoteText, storyTimeline } from '../../viewer/src/story';
import { loadGameConfig, loadPrices, PATHS, PROJECT_ROOT } from '../config';
import { callKey, directorCaller, loadRecorded, promptTokensSafe } from '../directorCalls';
import { KeyRing } from '../env';
import { writeJsonAtomic } from '../files';
import { say, warn } from '../log';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'dry-run': { type: 'boolean', default: false },
    'spoken-only': { type: 'boolean', default: false },
    free: { type: 'boolean', default: false },
    fresh: { type: 'boolean', default: false },
    yes: { type: 'boolean', default: false },
  },
});

const target = positionals[0];
if (!target) {
  warn('Which game? npm run direct -- <run folder>, for example: npm run direct -- 20261120-022938-game');
  process.exit(1);
}
const runDir = existsSync(resolve(target)) ? resolve(target) : join(PATHS.runs, target);
const replayPath = join(runDir, 'replay.jsonl');
if (!existsSync(replayPath)) {
  warn(`No replay.jsonl in ${relative(PROJECT_ROOT, runDir)}.`);
  process.exit(1);
}
const runName = basename(runDir);
const game = parseReplay(readFileSync(replayPath, 'utf8'));
const script = storyScript(game);
const storyPath = join(runDir, 'story.json');
const directorDir = join(runDir, 'director');
const callsFile = join(directorDir, 'calls.jsonl');
const spokenPath = join(runDir, 'spoken.json');
const spokenOnly = values['spoken-only'];
const existingStory: Story | null = existsSync(storyPath) ? (JSON.parse(readFileSync(storyPath, 'utf8')) as Story) : null;
if (spokenOnly && !existingStory) {
  warn('There is no story to speak yet: direct the game first (npm run direct -- <run>).');
  process.exit(1);
}

/** The spoken script's calls for a story: its bot lines, in batches (analysis/spoken.ts). */
function spokenCalls(story: Story, model: string, maxTokens: number): { calls: DirectorCall[]; batches: StoryLine[][] } {
  const lines = storyLines(game, story, buildScript(game, { thoughts: story.thoughts }));
  const batches: StoryLine[][] = [];
  for (let i = 0; i < lines.length; i += SPOKEN_BATCH) batches.push(lines.slice(i, i + SPOKEN_BATCH));
  const calls = batches.map((b, i): DirectorCall => ({ stage: 'spoken', room: i, model, system: [{ text: SPOKEN_SYSTEM }], user: spokenPrompt(game, b), maxTokens, schema: SPOKEN_JSON_SCHEMA }));
  return { calls, batches };
}

/** Make the story's spoken script and save it beside the story. Returns how many lines were reworded. */
async function saveSpoken(story: Story, call: DirectorCaller, model: string, maxTokens: number): Promise<number> {
  const { calls, batches } = spokenCalls(story, model, maxTokens);
  const lines: Record<string, { bot: string; original: string; spoken: string }> = {};
  /** One batch; if nothing usable comes back (a refusal, a reply that doesn't parse), each half once on its own. */
  const speak = async (c: DirectorCall, batch: StoryLine[], halves: boolean): Promise<Map<string, string>> => {
    const got = parseSpoken(await call(c), batch);
    if (got.size > 0 || !halves || batch.length < 2) return got;
    const mid = Math.ceil(batch.length / 2);
    const parts = [batch.slice(0, mid), batch.slice(mid)];
    const results = await Promise.all(parts.map((p) => speak({ ...c, user: spokenPrompt(game, p) }, p, false)));
    return new Map(results.flatMap((r) => [...r]));
  };
  for (const [i, c] of calls.entries()) {
    const batch = batches[i] ?? [];
    const got = await speak(c, batch, true);
    // A line the rewrite missed, or grew too long, keeps the bot's own words.
    for (const l of batch) lines[l.key] = { bot: l.bot, original: l.text, spoken: got.get(l.key) ?? l.text };
  }
  await writeJsonAtomic(spokenPath, { version: 1, model, lines });
  return Object.values(lines).filter((l) => l.spoken !== l.original).length;
}

function outline(story: Story): void {
  const tl = storyTimeline(story, script, game);
  const byId = new Map(game.events.map((e) => [e.id, e]));
  say('');
  say(`"${story.title}": ${story.logline}`);
  say(`About ${(tl.total / 60).toFixed(1)} minutes on screen (the full recording runs ${(script.total / 60).toFixed(0)}). Director: ${story.director}.`);
  let t = 0;
  for (const s of story.segments) {
    const secs = tl.items.filter((it) => story.segments[it.segment] === s).reduce((n, it) => n + it.dur, 0);
    const where = 'at' in s ? `R${s.at.room + 1} r${s.at.round} ${s.at.step}` : `R${s.from.room + 1} r${s.from.round} ${s.from.step} → r${s.to.round} ${s.to.step}`;
    const what =
      s.type === 'chapter' ? `== ${s.title} ==` :
      s.type === 'narrate' ? s.text :
      s.type === 'quote' ? `“${((e) => (e ? quoteText(e) : '?'))(byId.get(s.eventId))}” (#${s.eventId})` :
      s.type === 'show' ? `${s.caption}${s.bots.length ? ` [${s.bots.join(', ')}]` : ''}` :
      s.text || '(fast-forward)';
    say(`  ${`${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}`.padStart(5)} ${s.type.padEnd(7)} ${where.padEnd(28)} ${what.length > 120 ? `${what.slice(0, 117)}...` : what}`);
    t += secs;
  }
}

async function saveStory(story: Story): Promise<void> {
  // A story the models made is kept if a new one replaces it: it cost money, and you may prefer it.
  if (existsSync(storyPath)) {
    const old = JSON.parse(readFileSync(storyPath, 'utf8')) as { director?: string };
    if (old.director && old.director !== 'free') renameSync(storyPath, join(directorDir, `story-${Date.now()}.json`));
  }
  await writeJsonAtomic(storyPath, story);
}

// ---------------------------------------------------------------- the free Director
const ring = KeyRing.load(PROJECT_ROOT);
if (values.free) {
  const story = freeStory(game);
  await saveStory(story);
  outline(story);
  say('');
  say(`Saved ${relative(PROJECT_ROOT, storyPath)} (free Director). Watch it: npm run view, then pick the game.`);
  process.exit(0);
}

// ---------------------------------------------------------------- the estimate
const config = loadGameConfig();
const d = config.director;
const models: DirectorModels = { room: d.roomModel, edit: d.editModel, roomMaxTokens: d.roomMaxTokens, editMaxTokens: d.editMaxTokens };
const prices = loadPrices().table;
const recorded = values.fresh ? new Map() : loadRecorded(callsFile);
const flags = flagRounds(game);

/** Measured on the bots' prompts (2.26 characters a token); outputs from the first readings. */
const CHARS_PER_TOKEN = 2.26;
const EXPECTED_OUT = { room: 1600, edit: 2800 };

interface Planned {
  what: string;
  model: string;
  promptTokens: number;
  worstUsd: number;
  expectedUsd: number;
  recorded: boolean;
}
const planned: Planned[] = [];
const plan = (what: string, c: DirectorCall, expectedOut: number, known: boolean) => {
  const price = priceOf(prices, c.model);
  const chars = c.system.reduce((n, b) => n + b.text.length, 0) + c.user.length;
  const promptTokens = Math.round(chars / CHARS_PER_TOKEN);
  const expectedUsd = (promptTokens * price.input + expectedOut * price.output) / 1e6;
  planned.push({ what, model: c.model, promptTokens, worstUsd: known ? 0 : worstCaseCallUsd(price, promptTokensSafe(c), c.maxTokens), expectedUsd: known ? 0 : expectedUsd, recorded: known });
};
const roomCalls: DirectorCall[] = game.rooms.map((room) => ({ stage: 'room', room: room.index, model: models.room, ...roomPrompt(game, room, flags, script), maxTokens: models.roomMaxTokens, schema: ROOM_JSON_SCHEMA }));
if (!spokenOnly) for (const c of roomCalls) plan(`Reading room ${(c.room ?? 0) + 1}`, c, EXPECTED_OUT.room, recorded.has(callKey(c)));
// The edit reads what the readings write. With every reading recorded, its exact prompt is known;
// otherwise its size is estimated from typical readings (6 moments a room).
const recordedNotes = roomCalls.map((c) => {
  const r = recorded.get(callKey(c));
  return r ? parseRoomNotes(r.text) : undefined;
});
const typical: RoomNotes[] = game.rooms.map((room) => {
  const lines = room.roundsData.flatMap((rd) => rd.events.filter((e) => e.type === 'say' || e.type === 'thought')).map((e) => e.id);
  return {
    summary: 'word '.repeat(90),
    rounds: room.roundsData.map((rd) => ({ round: rd.round, gist: 'word '.repeat(22) })),
    moments: Array.from({ length: 6 }, (_, i) => ({ from_round: 1, from_step: 'declare' as const, to_round: 1, to_step: 'resolve' as const, bots: [], score: 3, reason: 'word '.repeat(16), what_happened: 'word '.repeat(45), key_lines: lines.slice(i * 4, i * 4 + 4) })),
  };
});
const exact = recordedNotes.every((n) => n !== undefined);
const editCall: DirectorCall = {
  stage: 'edit',
  room: null,
  model: models.edit,
  ...editPrompt(game, exact ? recordedNotes.map((n) => n ?? null) : typical, flags, script),
  maxTokens: models.editMaxTokens,
  schema: EDIT_JSON_SCHEMA,
};
if (!spokenOnly) plan(exact ? 'The edit' : 'The edit (guess)', editCall, EXPECTED_OUT.edit, exact && recorded.has(callKey(editCall)));
// The spoken script: exact when the story is kept; otherwise sized from the story there now (the new one
// is about as long), or from a typical one.
{
  const known = spokenOnly || (exact && recorded.has(callKey(editCall)));
  const base = existingStory ? spokenCalls(existingStory, d.spokenModel, d.spokenMaxTokens) : null;
  if (base && base.calls.length > 0) {
    base.calls.forEach((c, i) => {
      const outTokens = Math.round((base.batches[i] ?? []).reduce((n, l) => n + l.text.length, 0) / CHARS_PER_TOKEN);
      plan(`Spoken script ${i + 1}${known ? '' : ' (guess)'}`, c, outTokens, known && recorded.has(callKey(c)));
    });
  } else {
    const typicalUser = 'word '.repeat(SPOKEN_BATCH * 45);
    const c: DirectorCall = { stage: 'spoken', room: 0, model: d.spokenModel, system: [{ text: SPOKEN_SYSTEM }], user: typicalUser, maxTokens: d.spokenMaxTokens, schema: SPOKEN_JSON_SCHEMA };
    plan('Spoken script (guess)', c, SPOKEN_BATCH * 45, false);
  }
}

say('');
say(`Directing "${runName}": ${game.rooms.length} rooms, ${game.bots.length} bots, the full recording about ${Math.round(script.total / 60)} minutes.`);
say('Estimate (nothing spent yet):');
for (const p of planned) {
  say(`  ${p.what.padEnd(18)} ${p.model.padEnd(20)} ~${String(p.promptTokens).padStart(6)} tokens in   ${p.recorded ? 'recorded: free' : `expected ${usd4(p.expectedUsd)}, at most ${usd4(p.worstUsd)}`}`);
}
const expected = planned.reduce((n, p) => n + p.expectedUsd, 0);
const worst = planned.reduce((n, p) => n + p.worstUsd, 0) * (exact ? 1 : 1.3); // a guessed edit prompt can come out longer
const lifetime = readLifetimeSpend(join(PROJECT_ROOT, config.budget.spendFile)) ?? {};
say(`  Total: expected ${usd4(expected)}, at most about ${usd4(worst)}. Cap for this directing: ${usd(d.capUsd)}; lifetime room left on Anthropic: ${usd(Math.max(0, (config.budget.globalCapUsd.anthropic ?? 0) - (lifetime.anthropic ?? 0)))}.`);
if (values['dry-run']) {
  say('');
  say('Dry run: nothing was spent.');
  process.exit(0);
}
if (!ring.has('ANTHROPIC_API_KEY')) {
  warn('Missing in .env: ANTHROPIC_API_KEY. Run `npm run keys`, or use --free for the free Director.');
  process.exit(1);
}

// ---------------------------------------------------------------- the paid directing
const allRecorded = planned.every((p) => p.recorded);
if (allRecorded) say('Every call is recorded: directing it again costs nothing.');
if (!values.yes && !allRecorded) {
  if (!process.stdin.isTTY) {
    warn('Not starting: directing costs money and needs a yes. Run it in a terminal, or pass --yes if the yes was already given.');
    process.exit(1);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`Direct it (expected about ${usd4(expected)}, at most ${usd(d.capUsd)})? Type yes: `)).trim().toLowerCase();
  rl.close();
  if (answer !== 'yes') {
    say('Not started. Nothing was spent.');
    process.exit(0);
  }
}

const ledgerId = `${runName}-director`;
const ledger = new Ledger(ledgerId, prices);
const global = await GlobalSpend.open(join(PROJECT_ROOT, config.budget.spendFile), ledgerId);
const guard = new SpendGuard({ runUsd: d.capUsd, perBotUsd: d.capUsd, globalUsd: { ...config.budget.globalCapUsd } }, ledger, global);
const { call, stats } = directorCaller({ client: new ClaudeClient(ring.reveal('ANTHROPIC_API_KEY')), prices, money: { guard, ledger }, recorded, file: callsFile });
let stopReason: string | null = null;
try {
  say('');
  let story: Story;
  let problems: string[] = [];
  if (spokenOnly && existingStory) {
    story = existingStory;
    say(`Keeping the story; making its spoken script (${d.spokenModel})...`);
  } else {
    say(`Reading ${game.rooms.length} room${game.rooms.length === 1 ? '' : 's'} (${models.room}), then the edit (${models.edit}), then the spoken script (${d.spokenModel})...`);
    const result = await directStory(game, call, models);
    await writeJsonAtomic(join(directorDir, 'notes.json'), { rooms: result.notes, problems: [...result.problems, ...stats.cutOff] });
    await saveStory(result.story);
    story = result.story;
    problems = result.problems;
  }
  const reworded = await saveSpoken(story, call, d.spokenModel, d.spokenMaxTokens);
  outline(story);
  say('');
  for (const p of [...problems, ...stats.cutOff]) warn(`  ${p}`);
  say(`The spoken script: ${reworded} of the story's bot lines reworded for the ear (the screen keeps their own words). npm run voice reads it.`);
  say(`Calls: ${stats.made} made, ${stats.reused} answered from the record. Spent ${usd4(stats.spentUsd)} (expected ${usd4(expected)}).`);
  say(`Saved ${relative(PROJECT_ROOT, storyPath)} and ${relative(PROJECT_ROOT, spokenPath)}. Watch it: npm run view, then pick the game.`);
} catch (err) {
  stopReason = (err as Error).message;
  warn(`Directing stopped: ${stopReason}`);
  process.exitCode = 1;
} finally {
  await writeJsonAtomic(join(directorDir, 'ledger.json'), { runId: ledgerId, kind: 'director', caps: guard.caps, stopReason, totals: ledger.totals(), entries: ledger.all() });
  for (const w of ledger.warnings()) warn(`  Warning: ${w}`);
  await global.close(stopReason);
}
