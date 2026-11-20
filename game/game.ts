/**
 * The turn loop: a whole game, room after room (spec section 6).
 *
 * Each round:
 *   1. Observe (no model call): line of sight and the move menu, per bot.
 *   2. Declare (call 1): drafts, speech, whispers, orders.
 *   3. Talk (call 2): replies to whatever reached each bot.
 *   4. Commit (call 3): the binding command queue, in secret.
 *   5. Resolve (no model call): every queue in lockstep; each bot learns what
 *      it saw, and its own exact results.
 * At each room's end, every bot rewrites its notebook (a reflection call),
 * which carries into the next room. Names carry over too.
 *
 * Three guarantees, each kept in one place:
 *   - Honest views: every view is built from EventLog.forBot (game/view.ts).
 *   - Determinism: all randomness comes from the seeded streams; replies are
 *     gathered first and then applied in bot order, so the order in which
 *     calls come back never matters; nothing in replay.jsonl reads a clock.
 *   - Money: before each phase, the worst case of every call in it is
 *     reserved, all or nothing (budget/spendGuard.ts). A phase that can't be
 *     afforded doesn't start: the game saves and stops (spec: "At the cap,
 *     finish the current phase, save, and stop").
 */
import { createHash } from 'node:crypto';
import type { Agent, AgentReply, AgentRequest, Prompt } from '../agents/agent';
import { AgentCallError } from '../agents/agent';
import type { GlobalSpend } from '../budget/globalSpend';
import type { Ledger } from '../budget/ledger';
import type { Reservation, SpendGuard } from '../budget/spendGuard';
import { describeBreach } from '../budget/spendGuard';
import type { Level } from '../engine/level';
import { initWorld } from '../engine/physics';
import { RunRandom } from '../engine/random';
import { resolvePhase } from '../engine/resolve';
import type { BotStats, StatRanges } from '../engine/stats';
import { rollStatsForLevels } from '../engine/validate';
import type { World } from '../engine/world';
import { botById } from '../engine/world';
import { identityBlock, rulebook } from '../prompts/rulebook';
import type { EventBody, GameEvent, Phase, When } from './events';
import { EventLog, PHASES } from './events';
import type { GameOutput } from './output';
import type { Parsed, ReflectionReply, TurnReply } from './schema';
import {
  capWords,
  cleanName,
  cleanText,
  EMPTY_TURN,
  ignoredFields,
  LIMITS,
  PHASE_FIELDS,
  parseReflectionReply,
  parseTurnReply,
  REFLECTION_JSON_SCHEMA,
  TURN_JSON_SCHEMA,
} from './schema';
import type { Observation, RoomInfo } from './view';
import { buildReflection, buildView, observe } from './view';
import { witness } from './witness';

export interface Money {
  guard: SpendGuard;
  ledger: Ledger;
  global: GlobalSpend | null;
}

export interface GameOptions {
  seed: string;
  /** The rooms, in play order: the practice room first. */
  levels: readonly Level[];
  agents: readonly Agent[];
  ranges: StatRanges;
  maxTokens: { turn: number; reflection: number };
  output: GameOutput;
  /** The spend guard and ledger, for runs with paid agents. Null when every agent is free. */
  money: Money | null;
  /** Hard ceiling on one prompt's size, in (estimated) tokens: config/game.json's promptTokenHardLimit. */
  promptTokenLimit: number;
  /** Play at most this many rounds of each room (for smoke tests). */
  maxRounds?: number;
  /** Live lines for the console. */
  log?: (line: string) => void;
  /** Called after every round (the harness prints the running cost here). */
  onRound?: (where: { levelIndex: number; level: string; round: number }) => void;
}

export interface NameChange {
  levelIndex: number;
  level: string;
  round: number;
  phase: Phase;
  bot: string;
  name: string;
  previous: string | null;
  note: string;
}

export interface RoomOutcome {
  index: number;
  id: string;
  kind: 'puzzle' | 'practice';
  roundsPlayed: number;
  reason: string;
  through: string[];
  goalMet: boolean | null;
}

export interface GameResult {
  completed: boolean;
  stopReason: string | null;
  stats: Record<string, BotStats>;
  rooms: RoomOutcome[];
  names: Record<string, string | null>;
  nameChanges: NameChange[];
  notebooks: Record<string, string>;
  scores: Record<string, { coins: number; roomsEscaped: number }>;
  calls: number;
  malformed: number;
  events: readonly GameEvent[];
}

/**
 * A generous token count for reservations and the hard limit. It must not
 * come out LOW, or the spend guard would reserve too little: these prompts
 * are dense (maps, coordinates), and Anthropic's token counter measured one
 * at 2.26 characters a token on 2026-11-20, so 1.8 leaves a margin.
 */
export const CHARS_PER_TOKEN_SAFE = 1.8;
export function estimateTokens(prompt: Prompt): number {
  const chars = prompt.system.reduce((n, b) => n + b.text.length, 0) + prompt.user.length;
  return Math.ceil(chars / CHARS_PER_TOKEN_SAFE) + 50;
}

const hash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);

/** The world without its (unchanging, large) level: what a state snapshot needs. */
function worldState(world: World): Record<string, unknown> {
  const { level, ...rest } = world;
  return { level: level.id, ...rest };
}

interface Job<T> {
  bot: string;
  request: AgentRequest;
  usedEventIds: number[];
  parse: (text: string) => Parsed<T>;
}

interface Outcome<T> {
  bot: string;
  reply: T | null;
  problems: { attempt: number; error: string }[];
}

export async function runGame(opts: GameOptions): Promise<GameResult> {
  const { output, money } = opts;
  const say = opts.log ?? (() => {});
  const agents = new Map(opts.agents.map((a) => [a.id, a]));
  const botIds = [...agents.keys()].sort();
  const random = new RunRandom(opts.seed);
  const roll = rollStatsForLevels(opts.levels, botIds, random.stream('stats'), opts.ranges);
  const stats = roll.stats;
  const log = new EventLog();
  const names: Record<string, string | null> = Object.fromEntries(botIds.map((id) => [id, null]));
  const notebooks: Record<string, string> = Object.fromEntries(botIds.map((id) => [id, '']));
  const scores = Object.fromEntries(botIds.map((id) => [id, { coins: 0, roomsEscaped: 0 }]));
  const nameChanges: NameChange[] = [];
  const rooms: RoomOutcome[] = [];
  const writtenBlocks = new Set<string>();
  let written = 0;
  let calls = 0;
  let malformed = 0;
  let stopReason: string | null = null;

  const flushEvents = () => {
    for (const e of log.all().slice(written)) output.replay({ rec: 'event', ...e });
    written = log.length;
  };
  const add = (when: When, body: EventBody, visibleTo: readonly string[]) => log.add(when, body, visibleTo);

  output.replay({
    rec: 'game',
    version: 1,
    seed: opts.seed,
    bots: botIds,
    seats: botIds.map((id) => ({ bot: id, provider: agents.get(id)?.provider, model: agents.get(id)?.model })),
    levels: opts.levels.map((l) => l.id),
    // The spectator overlay shows these; no bot ever sees them.
    stats,
    statRolls: { attempts: roll.attempts, rejected: roll.rejected },
  });

  /** One call, with one retry if the reply can't be used (spec section 3, "Robust model calls"). */
  async function callOne<T>(job: Job<T>, first: Reservation | null): Promise<Outcome<T>> {
    const agent = agents.get(job.bot) as Agent;
    const problems: Outcome<T>['problems'] = [];
    let prompt = job.request.prompt;
    for (let attempt = 1; attempt <= 2; attempt++) {
      let reservation = attempt === 1 ? first : null;
      const tokens = estimateTokens(prompt);
      if (tokens > opts.promptTokenLimit) {
        throw new Error(`A prompt for bot ${job.bot} is about ${tokens} tokens, over the hard limit of ${opts.promptTokenLimit}. Refusing to send it.`);
      }
      if (attempt === 2 && money) {
        const r = money.guard.reserve({ botId: job.bot, provider: agent.provider, worstCaseUsd: agent.worstCaseUsd(tokens, job.request.maxTokens) });
        if (!r.ok) {
          stopReason ??= describeBreach(r.breach, `a retry for bot ${job.bot}`);
          problems.push({ attempt, error: 'the spending cap was reached, so the game could not ask again' });
          break;
        }
        reservation = r.reservations[0] ?? null;
      }
      const request: AgentRequest = { ...job.request, attempt, prompt };
      const key = { levelIndex: request.levelIndex, round: request.round, phase: request.phase, bot: job.bot, attempt };
      // Prompts are stored once per distinct cached block, then by reference.
      const system = prompt.system.map((b) => {
        const h = hash(b.text);
        if (!writtenBlocks.has(h)) {
          writtenBlocks.add(h);
          output.prompt({ rec: 'block', hash: h, text: b.text });
        }
        return h;
      });
      output.prompt({ rec: 'prompt', ...key, system, user: prompt.user, userCacheBreak: prompt.userCacheBreak ?? null, usedEventIds: job.usedEventIds, estimatedTokens: tokens });
      calls += 1;
      let reply: AgentReply;
      try {
        reply = await agent.act(request);
      } catch (err) {
        if (reservation) money?.guard.release(reservation); // a refused request isn't billed
        if (!(err instanceof AgentCallError)) throw err;
        output.response({ ...key, provider: agent.provider, model: agent.model, error: err.message, status: err.status });
        problems.push({ attempt, error: 'the call to your model failed' });
        continue;
      }
      let chargedUsd = 0;
      if (money && reservation) {
        const entry = money.ledger.record({
          botId: job.bot,
          phase: String(request.phase),
          level: request.levelIndex,
          round: request.round,
          model: agent.model,
          provider: agent.provider,
          usage: reply.usage,
          providerCostUsd: reply.providerCostUsd,
        });
        money.guard.settle(reservation, entry);
        chargedUsd = entry.chargedUsd;
      }
      output.response({
        ...key,
        provider: agent.provider,
        model: agent.model,
        text: reply.text,
        usage: reply.usage,
        providerCostUsd: reply.providerCostUsd,
        stopReason: reply.stopReason,
        chargedUsd,
        raw: reply.raw,
      });
      let error: string;
      if (reply.stopReason === 'max_tokens' || reply.stopReason === 'length') {
        error = 'it was cut off by the length limit';
      } else {
        const parsed = job.parse(reply.text);
        if (parsed.ok) return { bot: job.bot, reply: parsed.reply, problems };
        error = parsed.error;
      }
      problems.push({ attempt, error });
      prompt = {
        ...job.request.prompt,
        user: `${job.request.prompt.user}\n\nYOUR PREVIOUS REPLY COULD NOT BE USED: ${error}. Reply again with only the JSON object.`,
      };
    }
    return { bot: job.bot, reply: null, problems };
  }

  /** Every bot's call for one phase, at once. Null if the phase couldn't be afforded (the game stops). */
  async function callPhase<T>(jobs: Job<T>[], where: string): Promise<Outcome<T>[] | null> {
    let reservations: (Reservation | null)[] = jobs.map(() => null);
    if (money) {
      const planned = jobs.map((j) => {
        const agent = agents.get(j.bot) as Agent;
        return { botId: j.bot, provider: agent.provider, worstCaseUsd: agent.worstCaseUsd(estimateTokens(j.request.prompt), j.request.maxTokens) };
      });
      const reserved = money.guard.reserveAll(planned);
      if (!reserved.ok) {
        stopReason ??= describeBreach(reserved.breach, `the next phase (${where})`);
        return null;
      }
      reservations = reserved.reservations;
    }
    const outcomes = await Promise.all(jobs.map((j, i) => callOne(j, reservations[i] ?? null)));
    await money?.global?.flush();
    return outcomes;
  }

  const prompt = (bot: string, user: string, userCacheBreak?: number): Prompt => ({
    system: [
      { text: rulebook(), cache: true },
      { text: identityBlock(bot, notebooks[bot] ?? ''), cache: true },
    ],
    user,
    ...(userCacheBreak !== undefined ? { userCacheBreak } : {}),
  });

  /** Log what went wrong with a bot's replies this phase. */
  function logProblems<T>(when: When, o: Outcome<T>): void {
    o.problems.forEach((p, i) => {
      malformed += 1;
      const last = i === o.problems.length - 1;
      add(when, { type: 'malformed', from: o.bot, attempt: p.attempt, error: p.error, fallback: last && o.reply === null }, [o.bot]);
    });
  }

  // ------------------------------------------------------------------ the rooms
  game: for (let li = 0; li < opts.levels.length; li++) {
    const level = opts.levels[li] as Level;
    let world = initWorld(level, stats);
    const renamedHere = new Set<string>();
    const roundsHere = Math.min(level.rounds, opts.maxRounds ?? level.rounds);
    const room = (round: number): RoomInfo => ({
      index: li,
      count: opts.levels.length,
      id: level.id,
      name: level.name,
      kind: level.kind,
      round,
      rounds: roundsHere,
      goal: level.goal?.botsThrough ?? null,
    });
    add(
      { levelIndex: li, level: level.id, round: 0, phase: 'level' },
      { type: 'level_start', name: level.name, kind: level.kind, rounds: roundsHere, goal: level.goal?.botsThrough ?? null },
      botIds,
    );
    output.replay({ rec: 'level', index: li, id: level.id, name: level.name, kind: level.kind, rounds: roundsHere, goal: level.goal, map: level.map, start: worldState(world) });
    flushEvents();
    say(`Room ${li + 1}/${opts.levels.length}: ${level.name} (${level.kind}, up to ${roundsHere} rounds)`);

    let reason = 'its last round was played';
    let played = 0;
    for (let round = 1; round <= roundsHere; round++) {
      const active = botIds.filter((id) => !botById(world, id).exited);
      if (active.length === 0) {
        reason = 'every bot had gone through an exit';
        break;
      }
      const observations = new Map<string, Observation>(active.map((id) => [id, observe(world, id)]));
      const commits = new Map<string, string[]>();

      for (const phase of PHASES) {
        const when: When & { phase: Phase } = { levelIndex: li, level: level.id, round, phase };
        const jobs: Job<TurnReply>[] = active.map((bot) => {
          const view = buildView({
            bot,
            phase,
            room: room(round),
            world,
            observation: observations.get(bot) as Observation,
            events: log.forBot(bot),
            names,
            score: scores[bot] as { coins: number; roomsEscaped: number },
          });
          return {
            bot,
            usedEventIds: view.usedEventIds,
            parse: parseTurnReply,
            request: {
              kind: 'turn',
              phase,
              levelIndex: li,
              level: level.id,
              round,
              bot,
              attempt: 1,
              prompt: prompt(bot, view.text, view.cacheBreak),
              view,
              schema: TURN_JSON_SCHEMA as unknown as Record<string, unknown>,
              maxTokens: opts.maxTokens.turn,
            },
          };
        });
        const outcomes = await callPhase(jobs, `${level.id} round ${round} ${phase}`);
        if (!outcomes) break game;
        for (const o of outcomes) {
          logProblems(when, o);
          // Spec: "On a second failure, the bot does wait and says nothing."
          const reply = o.reply ?? (phase === 'commit' ? { ...EMPTY_TURN, commands: ['wait'] } : EMPTY_TURN);
          applyTurn(when, o.bot, reply, commits, renamedHere);
        }
        flushEvents();
        if (stopReason) break game; // a retry hit the cap: the phase is finished, so save and stop
      }

      // ---- Resolve: all committed queues at once.
      const queues = Object.fromEntries(active.map((id) => [id, commits.get(id) ?? []]));
      const before = world;
      const out = resolvePhase(world, queues, { trace: true, slotWorlds: true });
      world = out.world;
      played = round;
      const seen = witness(before, out, botIds);
      const rw: When = { levelIndex: li, level: level.id, round, phase: 'resolve' };
      for (const { result: r, visibleTo } of seen.results) {
        add(rw, { type: 'result', bot: r.bot, slot: r.slot, command: r.command, status: r.status, reason: r.reason, note: r.note, from: r.from, to: r.to }, visibleTo);
      }
      for (const s of seen.seen) add(rw, { type: 'seen', bot: s.bot, slot: s.slot, text: s.text }, s.visibleTo);
      for (const w of seen.world) add(rw, { type: 'world', slot: w.slot, event: w.event }, w.visibleTo);
      if (level.kind === 'puzzle') {
        for (const e of out.events) if (e.type === 'coin') (scores[e.bot] as { coins: number }).coins += 1;
      }
      output.replay({ rec: 'resolve', levelIndex: li, round, queues, results: out.results, events: out.events, trace: out.trace });
      flushEvents();
      output.snapshot(`room-${String(li).padStart(2, '0')}-round-${String(round).padStart(3, '0')}`, {
        levelIndex: li,
        level: level.id,
        round,
        world: worldState(world),
        names: { ...names },
        notebooks: { ...notebooks },
        scores: structuredClone(scores),
        renamedHere: [...renamedHere].sort(),
        events: log.length,
      });
      const through = world.exitOrder;
      say(`  round ${round}: ${through.length > 0 ? `through: ${through.join(' ')}` : 'nobody through yet'}`);
      opts.onRound?.({ levelIndex: li, level: level.id, round });
      if (level.goal && through.length >= level.goal.botsThrough) {
        reason = `${through.length} bot${through.length === 1 ? '' : 's'} got through, which was enough`;
        break;
      }
      if (botIds.every((id) => botById(world, id).exited)) {
        reason = 'every bot had gone through an exit';
        break;
      }
    }

    // ---- The room ends.
    const through = [...world.exitOrder];
    if (level.kind === 'puzzle') for (const id of through) (scores[id] as { roomsEscaped: number }).roomsEscaped += 1;
    const goalMet = level.goal ? through.length >= level.goal.botsThrough : null;
    rooms.push({ index: li, id: level.id, kind: level.kind, roundsPlayed: played, reason, through, goalMet });
    const coins = Object.fromEntries(botIds.map((id) => [id, botById(world, id).coins.length]));
    add({ levelIndex: li, level: level.id, round: played, phase: 'level' }, { type: 'level_end', reason, through, coins }, botIds);
    output.replay({ rec: 'level_end', index: li, id: level.id, reason, through, goalMet, roundsPlayed: played });
    flushEvents();
    say(`  room over: ${reason}; through: ${through.join(' ') || 'nobody'}`);

    // ---- Reflection: every bot rewrites its notebook (spec section 7.9).
    const when: When = { levelIndex: li, level: level.id, round: played, phase: 'reflect' };
    const jobs: Job<ReflectionReply>[] = botIds.map((bot) => {
      const r = buildReflection({ bot, room: room(played), events: log.forBot(bot), names, reason, through });
      return {
        bot,
        usedEventIds: r.usedEventIds,
        parse: parseReflectionReply,
        request: {
          kind: 'reflection',
          phase: 'reflect',
          levelIndex: li,
          level: level.id,
          round: played,
          bot,
          attempt: 1,
          prompt: prompt(bot, r.text),
          view: null,
          schema: REFLECTION_JSON_SCHEMA as unknown as Record<string, unknown>,
          maxTokens: opts.maxTokens.reflection,
        },
      };
    });
    const outcomes = await callPhase(jobs, `${level.id} reflection`);
    if (!outcomes) break game;
    for (const o of outcomes) {
      logProblems(when, o);
      if (!o.reply) continue; // keeps its old notebook
      const notebook = capWords(o.reply.notebook, LIMITS.notebookWords).text;
      notebooks[o.bot] = notebook;
      add(when, { type: 'notebook', from: o.bot, text: notebook }, [o.bot]);
    }
    flushEvents();
    if (stopReason) break game;
  }

  const completed = stopReason === null && rooms.length === opts.levels.length;
  output.replay({ rec: 'game_end', completed, stopReason, rooms, names, scores, nameChanges });
  return { completed, stopReason, stats, rooms, names, nameChanges, notebooks, scores, calls, malformed, events: log.all() };

  // ------------------------------------------------------------------ applying a reply
  function applyTurn(when: When & { phase: Phase }, bot: string, reply: TurnReply, commits: Map<string, string[]>, renamedHere: Set<string>): void {
    const phase = when.phase;
    const allowed = PHASE_FIELDS[phase];
    const ignored = ignoredFields(reply, phase);
    if (ignored.length > 0) add(when, { type: 'ignored', from: bot, fields: ignored }, []);
    const refuse = (what: string, reason: string) => add(when, { type: 'refused', from: bot, what, reason }, [bot]);
    const others = botIds.filter((id) => id !== bot);

    if (reply.thought.trim() !== '') add(when, { type: 'thought', from: bot, text: capWords(reply.thought, LIMITS.thoughtWords).text }, [bot]);

    if (allowed.includes('rename')) rename(when, bot, reply.rename, renamedHere, refuse);

    if (allowed.includes('say')) {
      let cut = false;
      for (const s of reply.say.slice(0, LIMITS.messages)) {
        const text = capWords(s.text, LIMITS.messageWords);
        cut ||= text.cut;
        if (text.text === '') continue;
        const to = others.includes(s.to.trim().toUpperCase()) ? s.to.trim().toUpperCase() : 'all';
        add(when, { type: 'say', from: bot, to, text: text.text }, botIds);
      }
      if (reply.say.length > LIMITS.messages) refuse('extra messages', `only ${LIMITS.messages} says count per step`);
      if (cut) refuse('long message', `messages are cut at ${LIMITS.messageWords} words`);
    }
    if (allowed.includes('whisper')) {
      for (const w of reply.whisper.slice(0, LIMITS.messages)) {
        const to = w.to.trim().toUpperCase();
        const text = capWords(w.text, LIMITS.messageWords).text;
        if (text === '') continue;
        if (!others.includes(to)) refuse(`whisper to "${cleanText(w.to).slice(0, 12)}"`, 'whispers go to another bot, by its letter');
        else add(when, { type: 'whisper', from: bot, to, text }, [bot, to]);
      }
      if (reply.whisper.length > LIMITS.messages) refuse('extra whispers', `only ${LIMITS.messages} whispers count per step`);
    }
    if (allowed.includes('orders')) {
      for (const o of reply.orders.slice(0, LIMITS.orders)) {
        const to = o.to.trim().toUpperCase();
        const command = cleanText(o.command).slice(0, 120);
        if (command === '') continue;
        if (!others.includes(to)) refuse(`order to "${cleanText(o.to).slice(0, 12)}"`, 'orders go to another bot, by its letter');
        else add(when, { type: 'order', from: bot, to, command }, [bot, to]);
      }
      if (reply.orders.length > LIMITS.orders) refuse('extra orders', `only ${LIMITS.orders} orders count per step`);
    }
    if (allowed.includes('commands')) {
      const commands = reply.commands.map((c) => cleanText(c).slice(0, 120)).filter((c) => c !== '').slice(0, LIMITS.commands);
      if (reply.commands.length > LIMITS.commands) refuse('extra commands', `only the first ${LIMITS.commands} commands count`);
      if (phase === 'declare') add(when, { type: 'draft', from: bot, commands }, botIds);
      if (phase === 'commit') {
        add(when, { type: 'commit', from: bot, commands }, [bot]);
        commits.set(bot, commands);
      }
    }
  }

  function rename(
    when: When & { phase: Phase },
    bot: string,
    wanted: TurnReply['rename'],
    renamedHere: Set<string>,
    refuse: (what: string, reason: string) => void,
  ): void {
    const raw = wanted.name.trim();
    const note = capWords(wanted.note_to_ingram, LIMITS.noteWords).text;
    if (raw === '' && note === '') return;
    if (raw === '') {
      refuse('note to Ingram', 'a note to Ingram is only sent with a new name');
      return;
    }
    const taken = botIds.filter((id) => id !== bot).flatMap((id) => [id, names[id] ?? '']).filter(Boolean);
    const cleaned = cleanName(raw, taken);
    if (cleaned.ok && cleaned.name === names[bot]) return; // the name it already has: nothing to do
    if (renamedHere.has(bot)) {
      refuse(`name "${cleanText(raw).slice(0, LIMITS.nameChars)}"`, 'you have already named yourself in this room');
      return;
    }
    if (note === '') {
      refuse(`name "${cleanText(raw).slice(0, LIMITS.nameChars)}"`, 'a new name needs a note to Ingram saying why you chose it');
      return;
    }
    if (!cleaned.ok) {
      refuse(`name "${cleanText(raw).slice(0, LIMITS.nameChars)}"`, cleaned.reason);
      return;
    }
    const previous = names[bot] ?? null;
    names[bot] = cleaned.name;
    renamedHere.add(bot);
    add(when, { type: 'name', from: bot, name: cleaned.name, previous }, botIds);
    add(when, { type: 'note_to_ingram', from: bot, name: cleaned.name, text: note }, []);
    nameChanges.push({ levelIndex: when.levelIndex, level: when.level, round: when.round, phase: when.phase, bot, name: cleaned.name, previous, note });
    say(`  ${bot} ${previous ? `renamed itself from "${previous}" to` : 'named itself'} "${cleaned.name}". Note to Ingram: "${note}"`);
  }
}
