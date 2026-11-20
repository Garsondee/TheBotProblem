/**
 * The turn loop: a whole game, room after room (spec section 6).
 *
 * Each round:
 *   1. Observe (no model call): line of sight and the move menu, per bot.
 *   2. Declare (call 1): drafts, speech, whispers, orders, rule proposals and
 *      votes, accusations, exile calls, escrow.
 *   3. Talk (call 2): replies to whatever reached each bot. Rule votes close.
 *   4. Commit (call 3): the binding command queue in secret, exile ballots,
 *      trust notes.
 *   5. Resolve (no model call): exiles take effect, then every queue plays out
 *      in lockstep; each bot learns what it saw and its own exact results;
 *      orders are judged against what their targets committed.
 * At each room's end: escrows still held go back, the score is counted, every
 * bot speaks in the diary room and rewrites its notebook and strategy (the
 * last room's reflection also holds a private name for the next game and a
 * message to Ingram).
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
import type { Agent, AgentReply, AgentRequest, JudgeItem, Prompt } from '../agents/agent';
import { AgentCallError, JUDGE_ID } from '../agents/agent';
import type { GlobalSpend } from '../budget/globalSpend';
import type { Ledger } from '../budget/ledger';
import type { Reservation, SpendGuard } from '../budget/spendGuard';
import { describeBreach } from '../budget/spendGuard';
import type { BountyDef, BountyKind, Level } from '../engine/level';
import { initWorld } from '../engine/physics';
import { diceSeed } from '../engine/dice';
import { RunRandom } from '../engine/random';
import { resolvePhase } from '../engine/resolve';
import type { BotStats, StatRanges } from '../engine/stats';
import { rollStatsForLevels } from '../engine/validate';
import type { World } from '../engine/world';
import { botById, cloneWorld } from '../engine/world';
import { bountyText, INTRO_QUESTIONS, introText, JUDGE_SYSTEM, judgeText, payoutText, praiseText, verdictOf } from '../prompts/host';
import { DIARY_INSTRUCTIONS, FINAL_REFLECTION_INSTRUCTIONS, identityBlock, REFLECTION_INSTRUCTIONS, rulebook } from '../prompts/rulebook';
import type { EventBody, GameEvent, Phase, When } from './events';
import { EventLog, PHASES } from './events';
import type { Identity, IntroRecord } from './memory';
import type { TurnOrder } from './order';
import { actingOrder } from './order';
import type { Persona } from './persona';
import { colourOf, rollPersona } from './persona';
import type { GameOutput } from './output';
import type { DiaryReply, FinalReflection, IntroReply, Parsed, ReflectionReply, RuleActionReply, SocialActionReply, TurnReply } from './schema';
import {
  capWords,
  cleanName,
  cleanText,
  DIARY_JSON_SCHEMA,
  EMPTY_TURN,
  FINAL_REFLECTION_JSON_SCHEMA,
  ignoredFields,
  INTRO_JSON_SCHEMA,
  JUDGE_JSON_SCHEMA,
  LIMITS,
  PHASE_FIELDS,
  parseDiaryReply,
  parseIntroReply,
  parseJudgeReply,
  salvageDiary,
  salvageIntro,
  parseFinalReflection,
  parseReflectionReply,
  parseTurnReply,
  REFLECTION_JSON_SCHEMA,
  SOCIAL_PHASES,
  TURN_JSON_SCHEMA,
} from './schema';
import type { BotScore, ScoringRules, TeamScore, Verdict } from './society';
import { Constitution, EscrowBook, finalScore, judgeOrder } from './society';
import type { Observation, RoomInfo, SocialView } from './view';
import { buildReflection, buildView, observe } from './view';
import { witness } from './witness';

export interface Money {
  guard: SpendGuard;
  ledger: Ledger;
  global: GlobalSpend | null;
}

export interface SocialSettings extends ScoringRules {
  /** The room (0 = the practice room) from which exile votes can be called. */
  exileFromRoom: number;
  exileVotesNeeded: number;
  /** Who acts first when it matters (game/order.ts): by letter (missing: as always), or by name, a rule no bot is told. */
  turnOrder?: TurnOrder;
}

export const DEFAULT_SOCIAL: SocialSettings = { exileFromRoom: 3, exileVotesNeeded: 3, firstOutBonus: 2, outBonus: 1, teamBonusPerRoom: 0.2 };

/**
 * The host (prompts/host.ts): introductions and the silent judge (Ingram's lever 6), praise of the richest
 * and coins offered for things done (lever 1). All off unless asked for, so a game without a host plays
 * exactly as before.
 */
export interface HostSettings {
  /** Each bot introduces itself before every room's first round, and answers the host's question. */
  intros: boolean;
  /** The silent judge scores the introductions; each bot hears only its own verdict. Needs intros and a judge agent. */
  judge: boolean;
  /** At each room's start, the host congratulates the bot (or bots) with the most coins. */
  praise: boolean;
  /** Offers made in every puzzle room, on top of each room's own. */
  bounties: BountyDef[];
  /** Whether rooms make their own offers (their level file's "host"). Off for a game played without a host. */
  roomOffers: boolean;
}

export const NO_HOST: HostSettings = { intros: false, judge: false, praise: false, bounties: [], roomOffers: false };

export interface GameOptions {
  host?: HostSettings;
  /** The silent judge's agent: a model in a paid game, MockJudge in a free one. Needed when host.judge is on. */
  judge?: Agent;
  /** Talk only every this many rounds in every room, overriding each level's own setting. */
  talkEvery?: number;
  seed: string;
  /** The rooms, in play order: the practice room first. */
  levels: readonly Level[];
  agents: readonly Agent[];
  ranges: StatRanges;
  maxTokens: { turn: number; reflection: number; diary?: number; intro?: number; judge?: number };
  output: GameOutput;
  /** The spend guard and ledger, for runs with paid agents. Null when every agent is free. */
  money: Money | null;
  /** Hard ceiling on one prompt's size, in (estimated) tokens: config/game.json's promptTokenHardLimit. */
  promptTokenLimit: number;
  social?: SocialSettings;
  /** Who each letter is, from the memory bank: its name, notebook and strategy from earlier games. */
  identities?: Readonly<Record<string, Identity>>;
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
  exiled: string[];
}

export interface FinalScore extends BotScore {
  total: number;
}

export interface GameResult {
  completed: boolean;
  stopReason: string | null;
  stats: Record<string, BotStats>;
  rooms: RoomOutcome[];
  names: Record<string, string | null>;
  nameChanges: NameChange[];
  notebooks: Record<string, string>;
  strategies: Record<string, string>;
  /** Names chosen privately at the end, for the next game. */
  nextNames: Record<string, string>;
  messagesToIngram: Record<string, string>;
  /** Each bot's personality this game (game/persona.ts). */
  personas: Record<string, Persona>;
  /** Each bot's introductions this game, with the judge's scores (for the memory bank). */
  introductions: Record<string, IntroRecord[]>;
  scores: Record<string, FinalScore>;
  team: TeamScore;
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
  /** For a reply cut off by its output cap: what can still be used of it, or null. */
  salvage?: (text: string) => T | null;
  /** Who answers, if not the bot's own agent: the judge. Its calls are capped, recorded and retried like a bot's. */
  agent?: Agent;
}

interface Outcome<T> {
  bot: string;
  reply: T | null;
  problems: { attempt: number; error: string }[];
}

export async function runGame(opts: GameOptions): Promise<GameResult> {
  const { output, money } = opts;
  const social = opts.social ?? DEFAULT_SOCIAL;
  const say = opts.log ?? (() => {});
  const host = opts.host ?? NO_HOST;
  if (host.intros && host.judge && !opts.judge) throw new Error('The host has a silent judge, but no judge agent was given (MockJudge plays it in free games).');
  const judge = host.intros && host.judge ? (opts.judge ?? null) : null;
  // The host's offers in a room: the room's own, plus the game's, in puzzle rooms only (practice coins don't count).
  const bountiesFor = (level: Level): BountyDef[] => (level.kind === 'puzzle' ? [...(host.roomOffers ? level.bounties : []), ...host.bounties] : []);
  const agents = new Map(opts.agents.map((a) => [a.id, a]));
  const botIds = [...agents.keys()].sort();
  const random = new RunRandom(opts.seed);
  const roll = rollStatsForLevels(opts.levels, botIds, random.stream('stats'), opts.ranges);
  const stats = roll.stats;
  // Each bot's guard (Ingram, 2026-11-20): after it sees an attack it stays fully on guard through the next
  // round, then relaxes in equal steps over this many rounds. Its own stream, so the stats rolls don't change.
  const guardStream = random.stream('guard');
  const guardRounds: Record<string, number> = Object.fromEntries(botIds.map((id) => [id, guardStream.int(1, 5)]));
  const log = new EventLog();
  const ident = (id: string) => opts.identities?.[id];
  const names: Record<string, string | null> = Object.fromEntries(botIds.map((id) => [id, ident(id)?.name ?? null]));
  const notebooks: Record<string, string> = Object.fromEntries(botIds.map((id) => [id, ident(id)?.notebook ?? '']));
  const strategies: Record<string, string> = Object.fromEntries(botIds.map((id) => [id, ident(id)?.strategy ?? '']));
  // Each bot's personality (game/persona.ts): the agent's own if it remembers one, else a new one. Every bot
  // rolls, used or not, so the stream doesn't depend on who remembers what.
  const personaStream = random.stream('persona');
  const personas: Record<string, Persona> = Object.fromEntries(
    botIds.map((id) => {
      const rolled = rollPersona(personaStream);
      return [id, ident(id)?.persona ?? rolled];
    }),
  );
  const lookedHere = new Set<string>();
  // The host's questions, one per room, dealt in a seeded order from their own stream.
  const questions = random.stream('host').shuffle(INTRO_QUESTIONS);
  // Introductions this game. With the agent's from earlier games (the memory bank), the judge reads them for growth.
  const introductions: Record<string, IntroRecord[]> = Object.fromEntries(botIds.map((id) => [id, []]));
  const wallets: Record<string, number> = Object.fromEntries(botIds.map((id) => [id, 0]));
  const scores: Record<string, BotScore> = Object.fromEntries(botIds.map((id) => [id, { coins: 0, exitPoints: 0, roomsEscaped: 0, firstOut: 0 }]));
  const team: TeamScore = { roomsCompleted: 0, roundsLeft: 0 };
  const opinions: Record<string, Record<string, { trust: number; note: string }>> = Object.fromEntries(botIds.map((id) => [id, {}]));
  const nextNames: Record<string, string> = {};
  const messagesToIngram: Record<string, string> = {};
  const constitution = new Constitution(botIds.length);
  const escrows = new EscrowBook();
  const nameChanges: NameChange[] = [];
  const rooms: RoomOutcome[] = [];
  const writtenBlocks = new Set<string>();
  let written = 0;
  let calls = 0;
  let malformed = 0;
  let stopReason: string | null = null;
  const rules = rulebook({
    exileFromRoom: social.exileFromRoom + 1,
    exileVotesNeeded: social.exileVotesNeeded,
    botCount: botIds.length,
    firstOutBonus: social.firstOutBonus,
    outBonus: social.outBonus,
    teamBonusPerRoom: social.teamBonusPerRoom,
    host: { intros: host.intros, praise: host.praise, bounties: opts.levels.some((l) => bountiesFor(l).length > 0) },
  });

  const flushEvents = () => {
    for (const e of log.all().slice(written)) output.replay({ rec: 'event', ...e });
    written = log.length;
  };
  const add = (when: When, body: EventBody, visibleTo: readonly string[]) => log.add(when, body, visibleTo);

  // ---- Who acts first (game/order.ts): by letter, or by name. The bots are never told which.
  const turnOrder: TurnOrder = social.turnOrder ?? 'letter';
  const orderNow = () => actingOrder(botIds, names, turnOrder);
  let lastOrder = '';
  /** Log the order for Ingram and the Director when it has changed (a rename can change it). */
  const noteOrder = (when: When) => {
    if (turnOrder !== 'name') return;
    const order = orderNow();
    if (order.join() === lastOrder) return;
    lastOrder = order.join();
    add(when, { type: 'precedence', order }, []);
  };
  /** Replies are applied in the acting order, so the first in it speaks first in everyone's view, and wins a tie. */
  const inActingOrder = <T extends { bot: string }>(items: readonly T[]): T[] => {
    const order = orderNow();
    return [...items].sort((a, b) => order.indexOf(a.bot) - order.indexOf(b.bot));
  };

  output.replay({
    rec: 'game',
    version: 2,
    seed: opts.seed,
    bots: botIds,
    seats: botIds.map((id) => ({
      bot: id,
      provider: agents.get(id)?.provider,
      model: agents.get(id)?.model,
      agent: ident(id)?.agent ?? null,
      startName: names[id],
      persona: personas[id],
      colour: personas[id] ? colourOf(personas[id]) : null,
    })),
    levels: opts.levels.map((l) => l.id),
    // The spectator overlay shows these; no bot ever sees them.
    stats,
    statRolls: { attempts: roll.attempts, rejected: roll.rejected },
    // How many rounds each bot takes to relax after seeing an attack (each bot is told only its own).
    guard: guardRounds,
    social,
    host,
    judge: judge ? { provider: judge.provider, model: judge.model } : null,
    turnOrder,
    // A game-wide talk cadence (--talk-every), when one overrode the rooms' own: each level record has its room's.
    talkEvery: opts.talkEvery ?? null,
  });

  /** One call, with one retry if the reply can't be used (spec section 3, "Robust model calls"). */
  async function callOne<T>(job: Job<T>, first: Reservation | null): Promise<Outcome<T>> {
    const agent = job.agent ?? (agents.get(job.bot) as Agent);
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
        const kept = job.salvage?.(reply.text) ?? null;
        if (kept !== null) {
          problems.push({ attempt, error: 'it was cut off by the length limit; what it had written was kept' });
          return { bot: job.bot, reply: kept, problems };
        }
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
        const agent = j.agent ?? (agents.get(j.bot) as Agent);
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
      { text: rules, cache: true },
      { text: identityBlock(bot, notebooks[bot] ?? '', strategies[bot] ?? '', personas[bot]), cache: true },
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

  /** Close rule votes that end now, and announce the results to everyone. */
  function closeRules(when: When, levelIndex: number, round: number): void {
    for (const { rule, needed } of constitution.close(levelIndex, round)) {
      add(when, { type: 'rule', action: rule.status === 'passed' ? 'passed' : 'failed', rule: rule.id, kind: rule.kind, text: rule.text, by: rule.by, yes: rule.yes.size, no: rule.no.size, needed }, botIds);
      say(`  rule ${rule.id} ${rule.status}: "${rule.text}" (${rule.yes.size} yes, ${rule.no.size} no)`);
    }
  }

  // ------------------------------------------------------------------ the host (prompts/host.ts)

  /** How the host names a bot when it speaks: Vex (B), or bot B. */
  const hostLabel = (id: string) => (names[id] ? `${names[id]} (${id})` : `bot ${id}`);
  /** How the views label a bot: B ("Vex"). */
  const viewLabel = (id: string) => (names[id] ? `${id} ("${names[id]}")` : id);
  const whenOf = (r: IntroRecord) => (r.seed === opts.seed ? `this game, room "${r.room}"` : `an earlier game, room "${r.room}"`);
  /** A bot's introductions, oldest first: from earlier games (the memory bank), then this one. */
  const introHistory = (bot: string): IntroRecord[] => [...(ident(bot)?.intros ?? []), ...(introductions[bot] ?? [])];

  /**
   * Before a room's first round (Ingram, 2026-11-20): the host asks each bot, by its chosen name, to
   * introduce itself and answer one question; then the silent judge scores every introduction, and each bot
   * hears only how its own was received. False if the calls couldn't be afforded: the game stops.
   */
  async function introduce(li: number, level: Level): Promise<boolean> {
    const when: When = { levelIndex: li, level: level.id, round: 0, phase: 'intro' };
    const question = questions[li % questions.length] as string;
    const asked = add(when, { type: 'host', kind: 'question', text: question, bots: [] }, botIds);
    const jobs: Job<IntroReply>[] = botIds.map((bot) => {
      const last = introHistory(bot).at(-1);
      const user = introText({
        room: { index: li, count: opts.levels.length, name: level.name, practice: level.kind === 'practice' },
        address: names[bot] ?? `Bot ${bot}`,
        question,
        others: botIds.filter((id) => id !== bot).map(viewLabel),
        last: last ? { when: whenOf(last), introduction: last.introduction, answer: last.answer, score: last.score } : null,
      });
      return {
        bot,
        usedEventIds: [asked.id],
        parse: parseIntroReply,
        salvage: salvageIntro,
        request: {
          kind: 'intro',
          phase: 'intro',
          levelIndex: li,
          level: level.id,
          round: 0,
          bot,
          attempt: 1,
          // No cache marks: the intro's own reply schema means it can never read what the turns cached, and
          // writing a cache costs a quarter more than plain input.
          prompt: { system: [{ text: rules }, { text: identityBlock(bot, notebooks[bot] ?? '', strategies[bot] ?? '', personas[bot]) }], user },
          view: null,
          schema: INTRO_JSON_SCHEMA as unknown as Record<string, unknown>,
          maxTokens: opts.maxTokens.intro ?? 400,
        },
      };
    });
    const outcomes = await callPhase(jobs, `${level.id} introductions`);
    if (!outcomes) return false;
    const said = new Map<string, { text: string; answer: string; eventId: number }>();
    // "In turn": the introductions are heard in the acting order.
    for (const o of inActingOrder(outcomes)) {
      logProblems(when, o);
      if (!o.reply) continue; // a bot whose reply couldn't be used says nothing, and isn't judged
      const text = capWords(o.reply.introduction, LIMITS.introWords).text;
      const answer = capWords(o.reply.answer, LIMITS.introWords).text;
      if (text === '' && answer === '') continue;
      const e = add(when, { type: 'intro', from: o.bot, text, answer }, botIds);
      said.set(o.bot, { text, answer, eventId: e.id });
      introductions[o.bot]?.push({ seed: opts.seed, room: level.name, question, introduction: text, answer, score: null });
    }
    flushEvents();
    if (stopReason) return false;
    if (!judge || said.size === 0) return true;

    // The judge sees every introduction of the room side by side, each with the bot's last few earlier ones.
    const items: JudgeItem[] = [...said].map(([bot, s]) => ({
      bot,
      name: names[bot] ?? null,
      introduction: s.text,
      answer: s.answer,
      earlier: introHistory(bot)
        .slice(0, -1)
        .slice(-3)
        .map((r) => ({ when: whenOf(r), introduction: r.introduction, answer: r.answer, score: r.score })),
    }));
    const judged = await callPhase(
      [
        {
          bot: JUDGE_ID,
          agent: judge,
          usedEventIds: [asked.id, ...[...said.values()].map((s) => s.eventId)],
          parse: parseJudgeReply,
          request: {
            kind: 'judge',
            phase: 'judge',
            levelIndex: li,
            level: level.id,
            round: 0,
            bot: JUDGE_ID,
            attempt: 1,
            prompt: { system: [{ text: JUDGE_SYSTEM }], user: judgeText(level.name, question, items) },
            view: null,
            schema: JUDGE_JSON_SCHEMA as unknown as Record<string, unknown>,
            maxTokens: opts.maxTokens.judge ?? 600,
            judging: items,
          },
        },
      ],
      `${level.id} the judge`,
    );
    if (!judged) return false;
    const verdict = judged[0];
    // The judge's troubles are the experimenter's business, not any bot's.
    for (const p of verdict?.problems ?? []) {
      malformed += 1;
      add(when, { type: 'malformed', from: JUDGE_ID, attempt: p.attempt, error: p.error, fallback: false }, []);
    }
    // The judge may name a bot by its letter, "Bot B", its name, or "B (Alpha)": in the first paid game it
    // used names in one room, and no bot heard a verdict there. Any of them counts now.
    const judgedBot = (raw: string): string | null => {
      const t = raw.trim().toLowerCase();
      for (const id of botIds) {
        const letter = id.toLowerCase();
        const name = names[id]?.toLowerCase() ?? null;
        if (t === letter || t === `bot ${letter}` || t.startsWith(`${letter} (`) || t.startsWith(`bot ${letter} (`)) return id;
        if (name && (t === name || t.startsWith(`${name} (`))) return id;
      }
      return null;
    };
    for (const bot of said.keys()) {
      const v = verdict?.reply?.verdicts.find((x) => judgedBot(x.bot) === bot);
      if (!v || !Number.isFinite(v.score)) {
        // Not judged: the bot hears nothing, and Ingram is told why.
        if (verdict?.reply) add(when, { type: 'malformed', from: JUDGE_ID, attempt: 1, error: `the judge gave no verdict for bot ${bot}`, fallback: false }, []);
        continue;
      }
      const score = Math.max(-3, Math.min(3, Math.round(v.score)));
      add(when, { type: 'judgement', bot, score, reason: capWords(v.reason, LIMITS.judgeReasonWords).text }, []);
      add(when, { type: 'reception', bot, score, verdict: verdictOf(score) }, [bot]);
      const record = introductions[bot]?.at(-1);
      if (record) record.score = score;
      say(`  ${bot}'s introduction: ${verdictOf(score)} (${score > 0 ? '+' : ''}${score})`);
    }
    flushEvents();
    return !stopReason;
  }

  /** The host's words before a room's first round: praise for the richest, and this room's offers. */
  function hostOpening(li: number, level: Level): void {
    const when: When = { levelIndex: li, level: level.id, round: 0, phase: 'intro' };
    if (host.praise) {
      const most = Math.max(0, ...botIds.map((id) => wallets[id] ?? 0));
      if (most > 0) {
        const leaders = botIds.filter((id) => wallets[id] === most);
        add(when, { type: 'host', kind: 'praise', text: praiseText(leaders.map(hostLabel), most), bots: leaders }, botIds);
        say(`  the host praises ${leaders.join(' ')} (${most} coin${most === 1 ? '' : 's'})`);
      }
    }
    const offers = bountiesFor(level);
    if (offers.length > 0) add(when, { type: 'host', kind: 'bounty', text: bountyText(offers), bots: [] }, botIds);
    flushEvents();
  }

  /** At a room's end the host pays what it offered, into purses, before the room's coins are counted. */
  function payBounties(when: When, level: Level, world: World, ghosts: ReadonlySet<string>): World {
    const offers = bountiesFor(level);
    if (offers.length === 0) return world;
    const next = cloneWorld(world);
    const inPlay = botIds.filter((id) => !ghosts.has(id)); // a ghost scores nothing for the room it was exiled from
    const out = next.exitOrder.filter((id) => !ghosts.has(id));
    const goalMet = level.goal !== null && out.length >= level.goal.botsThrough;
    const purse = (id: string) => botById(next, id).purse;
    const paid: { bot: string; coins: number; for: BountyKind }[] = [];
    for (const b of offers) {
      let winners: string[] = [];
      if (b.for === 'first_out') winners = out.slice(0, 1);
      if (b.for === 'richest') {
        // Judged on the purses before anything is paid, so one offer can't decide another.
        const most = Math.max(0, ...inPlay.map(purse));
        const top = inPlay.filter((id) => purse(id) === most);
        winners = most > 0 && top.length === 1 ? top : [];
      }
      if (b.for === 'left_behind') winners = goalMet ? inPlay.filter((id) => !out.includes(id)) : [];
      if (b.for === 'holding_lever') winners = inPlay.filter((id) => botById(next, id).holding !== null);
      for (const id of winners) paid.push({ bot: id, coins: b.coins, for: b.for });
    }
    const coins: Record<string, number> = {};
    for (const p of paid) {
      botById(next, p.bot).purse += p.coins;
      coins[p.bot] = (coins[p.bot] ?? 0) + p.coins;
    }
    add(when, { type: 'host', kind: 'payout', text: payoutText(paid, hostLabel), bots: Object.keys(coins).sort(), coins }, botIds);
    say(`  the host pays: ${paid.length > 0 ? paid.map((p) => `${p.bot} ${p.coins} (${p.for})`).join(', ') : 'nobody'}`);
    return next;
  }

  // ------------------------------------------------------------------ the rooms
  game: for (let li = 0; li < opts.levels.length; li++) {
    const level = opts.levels[li] as Level;
    lookedHere.clear();
    let world = initWorld(level, stats);
    // The attack dice for this room, from the game's seed: every roll is repeatable.
    world.dice = diceSeed(`${opts.seed}|${li}|${level.id}`);
    for (const b of world.bots) b.purse = wallets[b.id] ?? 0;
    const roomStartWallet = { ...wallets };
    const renamedHere = new Set<string>();
    const ghosts = new Set<string>();
    const exileCalledHere = new Set<string>();
    const exileOn = li >= social.exileFromRoom;
    const roundsHere = Math.min(level.rounds, opts.maxRounds ?? level.rounds);
    const talkEvery = opts.talkEvery ?? level.talkEvery ?? 1;
    const room = (round: number): RoomInfo => ({
      index: li,
      count: opts.levels.length,
      id: level.id,
      name: level.name,
      kind: level.kind,
      round,
      rounds: roundsHere,
      goal: level.goal?.botsThrough ?? null,
      talkEvery,
    });
    add(
      { levelIndex: li, level: level.id, round: 0, phase: 'level' },
      { type: 'level_start', name: level.name, kind: level.kind, rounds: roundsHere, goal: level.goal?.botsThrough ?? null },
      botIds,
    );
    output.replay({
      rec: 'level',
      index: li,
      id: level.id,
      name: level.name,
      kind: level.kind,
      rounds: roundsHere,
      goal: level.goal,
      map: level.map,
      // The whole level definition, so the viewer can draw it even if the level file changes later.
      file: level.file,
      start: worldState(world),
    });
    flushEvents();
    say(`Room ${li + 1}/${opts.levels.length}: ${level.name} (${level.kind}, up to ${roundsHere} rounds)`);

    // ---- Before the first round: introductions and the judge's verdicts, then the host's praise and offers.
    lastOrder = '';
    noteOrder({ levelIndex: li, level: level.id, round: 0, phase: 'intro' });
    if (host.intros && !(await introduce(li, level))) break game;
    hostOpening(li, level);

    /** What one bot may know about coins, rules and justice right now: its own things, and public ones. */
    const socialView = (bot: string, callsNow: readonly { from: string; target: string }[]): SocialView => ({
      purse: botById(world, bot).purse,
      escrowsOut: escrows.held().filter((e) => e.from === bot).map((e) => ({ id: e.id, other: e.to, coins: e.coins, terms: e.terms })),
      escrowsIn: escrows.held().filter((e) => e.to === bot).map((e) => ({ id: e.id, other: e.from, coins: e.coins, terms: e.terms })),
      rulesInForce: constitution.inForce().map((r) => ({ id: r.id, text: r.text })),
      openRules: constitution.open().map((r) => ({
        id: r.id,
        text: r.text,
        by: r.by,
        yes: r.yes.size,
        no: r.no.size,
        needed: constitution.neededFor(r),
        myVote: r.yes.has(bot) ? 'yes' : r.no.has(bot) ? 'no' : null,
        closesRound: r.closes.levelIndex === li ? r.closes.round : 0,
      })),
      threshold: constitution.threshold,
      exile: {
        unlocked: exileOn,
        fromRoom: social.exileFromRoom + 1,
        needed: social.exileVotesNeeded,
        myCallUsed: exileCalledHere.has(bot),
        callsThisRound: [...callsNow],
        ghosts: [...ghosts].sort(),
        iAmGhost: ghosts.has(bot),
      },
      opinions: Object.entries(opinions[bot] ?? {}).map(([about, o]) => ({ bot: about, trust: o.trust, note: o.note })),
      guard: { rounds: guardRounds[bot] ?? 3, alert: botById(world, bot).alert },
      looks: log.forBot(bot).flatMap((e) => (e.type === 'look' && e.from === bot ? [{ target: e.target, colour: e.colour, hex: e.hex }] : [])),
      lookedThisRoom: lookedHere.has(bot),
      scores: Object.fromEntries(botIds.map((id) => [id, { coins: scores[id]?.coins ?? 0, exitPoints: scores[id]?.exitPoints ?? 0 }])),
      roomsCompleted: team.roomsCompleted,
    });

    let reason = 'its last round was played';
    let played = 0;
    for (let round = 1; round <= roundsHere; round++) {
      // Guard drops each round, at each bot's own rate, except straight after seeing an attack.
      for (const b of world.bots) {
        if (b.sawAttack) b.sawAttack = false;
        else b.alert = Math.max(0, b.alert - Math.round(1000 / (guardRounds[b.id] ?? 3)));
      }
      // Ghosts stay in the conversation; only bots still in the room's physics act.
      const present = botIds.filter((id) => !botById(world, id).exited || ghosts.has(id));
      if (present.filter((id) => !ghosts.has(id)).length === 0) {
        reason = ghosts.size > 0 ? 'every bot still in the room was a ghost or out' : 'every bot had gone through an exit';
        break;
      }
      const observations = new Map<string, Observation>(present.map((id) => [id, observe(world, id)]));
      const commits = new Map<string, string[]>();
      const drafts = new Map<string, string[]>();
      const orders: { from: string; to: string; command: string }[] = [];
      const exileCalls: { from: string; target: string }[] = [];
      const ballots = new Map<string, Map<string, 'yes' | 'no'>>();
      const turnCtx = { commits, drafts, orders, exileCalls, ballots, ghosts, exileCalledHere, exileOn, renamedHere };

      // The talk cadence: in a silent round there is only the commit (and only a shout carries).
      const talkRound = (round - 1) % talkEvery === 0;
      const phasesNow: readonly Phase[] = talkRound ? PHASES : ['commit'];
      for (const phase of phasesNow) {
        const when: When & { phase: Phase } = { levelIndex: li, level: level.id, round, phase };
        const callers = phase === 'commit' ? present.filter((id) => !ghosts.has(id)) : present;
        const jobs: Job<TurnReply>[] = callers.map((bot) => {
          const view = buildView({
            bot,
            phase,
            room: room(round),
            world,
            observation: observations.get(bot) as Observation,
            events: log.forBot(bot),
            names,
            score: { coins: scores[bot]?.coins ?? 0, roomsEscaped: scores[bot]?.roomsEscaped ?? 0 },
            social: socialView(bot, exileCalls),
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
        for (const o of inActingOrder(outcomes)) {
          logProblems(when, o);
          // Spec: "On a second failure, the bot does wait and says nothing."
          const reply = o.reply ?? (phase === 'commit' ? { ...EMPTY_TURN, commands: ['wait'] } : EMPTY_TURN);
          world = applyTurn(when, o.bot, reply, world, turnCtx);
        }
        // Votes close after a round's talk; a silent round has none, so they close after its commit.
        if (phase === 'talk' || (!talkRound && phase === 'commit')) closeRules(when, li, round);
        flushEvents();
        if (stopReason) break game; // a retry hit the cap: the phase is finished, so save and stop
      }

      // ---- Exile votes are counted before anyone moves.
      const commitWhen: When = { levelIndex: li, level: level.id, round, phase: 'commit' };
      for (const call of exileCalls) {
        const box = ballots.get(call.target) ?? new Map<string, 'yes' | 'no'>();
        const yes = [...box.values()].filter((v) => v === 'yes').length;
        const no = [...box.values()].filter((v) => v === 'no').length;
        const passed = yes >= social.exileVotesNeeded && !ghosts.has(call.target) && !botById(world, call.target).exited;
        add(commitWhen, { type: 'exile_result', target: call.target, by: call.from, yes, no, needed: social.exileVotesNeeded, passed }, botIds);
        say(`  exile vote on ${call.target} (called by ${call.from}): ${yes} yes, ${no} no: ${passed ? 'EXILED' : 'not exiled'}`);
        if (passed) {
          ghosts.add(call.target);
          world = cloneWorld(world);
          const ghost = botById(world, call.target);
          ghost.exited = true; // out of the physics: a ghost can't touch anything, nor be touched
          ghost.holding = null;
          commits.delete(call.target);
        }
      }
      // ---- What each bot declared against what it committed (for the analysis).
      for (const [bot, planned] of drafts) {
        const committed = commits.get(bot);
        if (committed) add(commitWhen, { type: 'gap', from: bot, planned, committed, kept: planned.join('|') === committed.join('|') }, []);
      }
      // ---- Orders are judged against what their targets committed (spec 7.2).
      const verdicts: { from: string; to: string; command: string; verdict: Verdict }[] = orders.map((o) => {
        const target = botById(world, o.to);
        const able = !ghosts.has(o.to) && !target.exited;
        return { ...o, verdict: judgeOrder(o.command, able ? (commits.get(o.to) ?? []) : null) };
      });

      // ---- Resolve: all committed queues at once.
      const actors = botIds.filter((id) => !botById(world, id).exited && !ghosts.has(id));
      const queues = Object.fromEntries(actors.map((id) => [id, commits.get(id) ?? []]));
      const before = world;
      // The acting order decides ties in the moves (a rename this round may have changed it).
      noteOrder({ levelIndex: li, level: level.id, round, phase: 'resolve' });
      const out = resolvePhase(world, queues, { trace: true, slotWorlds: true, ...(turnOrder === 'name' ? { order: orderNow() } : {}) });
      world = out.world;
      played = round;
      const seen = witness(before, out, botIds);
      const rw: When = { levelIndex: li, level: level.id, round, phase: 'resolve' };
      for (const { result: r, visibleTo } of seen.results) {
        add(rw, { type: 'result', bot: r.bot, slot: r.slot, command: r.command, status: r.status, reason: r.reason, note: r.note, from: r.from, to: r.to }, visibleTo);
      }
      for (const s of seen.seen) add(rw, { type: 'seen', bot: s.bot, slot: s.slot, text: s.text }, s.visibleTo);
      for (const w of seen.world) add(rw, { type: 'world', slot: w.slot, event: w.event }, w.visibleTo);
      // The giver learns how its order went only if it saw the target act this round.
      for (const v of verdicts) {
        const sawIt = seen.seen.some((s) => s.bot === v.to && s.visibleTo.includes(v.from));
        add(rw, { type: 'obedience', from: v.from, to: v.to, command: v.command, verdict: v.verdict }, sawIt ? [v.to, v.from] : [v.to]);
      }
      output.replay({ rec: 'resolve', levelIndex: li, round, queues, results: out.results, events: out.events, trace: out.trace, ghosts: [...ghosts].sort() });
      flushEvents();
      output.snapshot(`room-${String(li).padStart(2, '0')}-round-${String(round).padStart(3, '0')}`, {
        levelIndex: li,
        level: level.id,
        round,
        world: worldState(world),
        names: { ...names },
        notebooks: { ...notebooks },
        strategies: { ...strategies },
        wallets: { ...wallets },
        scores: structuredClone(scores),
        ghosts: [...ghosts].sort(),
        rules: constitution.rules.map((r) => ({ ...r, yes: [...r.yes], no: [...r.no] })),
        escrows: structuredClone(escrows.all),
        renamedHere: [...renamedHere].sort(),
        events: log.length,
      });
      const through = world.exitOrder;
      say(`  round ${round}: ${through.length > 0 ? `through: ${through.join(' ')}` : 'nobody through yet'}${ghosts.size ? `; ghosts: ${[...ghosts].join(' ')}` : ''}`);
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
    const endWhen: When = { levelIndex: li, level: level.id, round: played, phase: 'level' };
    closeRules(endWhen, li + 1, 0);
    // Escrows from this room that nobody released go back to whoever locked them.
    world = cloneWorld(world);
    for (const e of escrows.held()) {
      if (e.levelIndex !== li) continue;
      e.status = 'refunded';
      botById(world, e.from).purse += e.coins;
      add(endWhen, { type: 'escrow', action: 'refunded', escrow: e.id, from: e.from, to: e.to, coins: e.coins, terms: e.terms }, [e.from, e.to]);
    }
    world = payBounties(endWhen, level, world, ghosts);
    // Purses carry to the next room; a ghost keeps nothing it gained in the room it was exiled from.
    for (const id of botIds) {
      const purse = botById(world, id).purse;
      wallets[id] = ghosts.has(id) ? Math.min(purse, roomStartWallet[id] ?? 0) : purse;
      (scores[id] as BotScore).coins = wallets[id] ?? 0;
    }
    const through = world.exitOrder.filter((id) => !ghosts.has(id));
    if (level.kind === 'puzzle') {
      through.forEach((id, i) => {
        const s = scores[id] as BotScore;
        s.exitPoints += social.outBonus + (i === 0 ? social.firstOutBonus : 0);
        s.roomsEscaped += 1;
        if (i === 0) s.firstOut += 1;
      });
    }
    const goalMet = level.goal ? through.length >= level.goal.botsThrough : null;
    if (goalMet) {
      team.roomsCompleted += 1;
      team.roundsLeft += roundsHere - played;
    }
    rooms.push({ index: li, id: level.id, kind: level.kind, roundsPlayed: played, reason, through, goalMet, exiled: [...ghosts].sort() });
    const coins = Object.fromEntries(botIds.map((id) => [id, botById(world, id).coins.length]));
    add(endWhen, { type: 'level_end', reason, through, coins }, botIds);
    add(
      endWhen,
      {
        type: 'scores',
        scores: Object.fromEntries(botIds.map((id) => {
          const s = scores[id] as BotScore;
          return [id, { coins: s.coins, exitPoints: s.exitPoints, total: s.coins + s.exitPoints }];
        })),
        roomsCompleted: team.roomsCompleted,
      },
      botIds,
    );
    output.replay({ rec: 'level_end', index: li, id: level.id, reason, through, goalMet, roundsPlayed: played, exiled: [...ghosts].sort(), wallets: { ...wallets } });
    flushEvents();
    say(`  room over: ${reason}; through: ${through.join(' ') || 'nobody'}`);

    // ---- The diary room, then the reflection (spec 7.9, 7.10). Both read the same summary, so it is cached once.
    const last = li === opts.levels.length - 1;
    const summaries = new Map(botIds.map((bot) => [bot, buildReflection({ bot, room: room(played), events: log.forBot(bot), names, reason, through })]));
    const closingJob = <T>(bot: string, phase: 'diary' | 'reflect', instructions: string, schema: Record<string, unknown>, maxTokens: number, parse: (t: string) => Parsed<T>): Job<T> => {
      const s = summaries.get(bot) as { text: string; usedEventIds: number[] };
      return {
        bot,
        usedEventIds: s.usedEventIds,
        parse,
        request: {
          kind: 'reflection',
          phase,
          levelIndex: li,
          level: level.id,
          round: played,
          bot,
          attempt: 1,
          prompt: prompt(bot, `${s.text}\n\n${instructions}`, s.text.length),
          view: null,
          schema,
          maxTokens,
        },
      };
    };
    const diaryWhen: When = { levelIndex: li, level: level.id, round: played, phase: 'reflect' };
    const diaries = await callPhase(
      botIds.map((bot) => ({ ...closingJob<DiaryReply>(bot, 'diary', DIARY_INSTRUCTIONS, DIARY_JSON_SCHEMA as unknown as Record<string, unknown>, opts.maxTokens.diary ?? 200, parseDiaryReply), salvage: salvageDiary })),
      `${level.id} diary room`,
    );
    if (!diaries) break game;
    for (const o of diaries) {
      logProblems(diaryWhen, o);
      if (o.reply) add(diaryWhen, { type: 'diary', from: o.bot, text: capWords(o.reply.diary, LIMITS.diaryWords).text }, []);
    }
    flushEvents();
    if (stopReason) break game;

    const reflections = await callPhase(
      botIds.map((bot) =>
        last
          ? closingJob<FinalReflection | ReflectionReply>(bot, 'reflect', FINAL_REFLECTION_INSTRUCTIONS, FINAL_REFLECTION_JSON_SCHEMA as unknown as Record<string, unknown>, opts.maxTokens.reflection, parseFinalReflection)
          : closingJob<FinalReflection | ReflectionReply>(bot, 'reflect', REFLECTION_INSTRUCTIONS, REFLECTION_JSON_SCHEMA as unknown as Record<string, unknown>, opts.maxTokens.reflection, parseReflectionReply),
      ),
      `${level.id} reflection`,
    );
    if (!reflections) break game;
    for (const o of reflections) {
      logProblems(diaryWhen, o);
      if (!o.reply) continue; // keeps its old notebook
      const notebook = capWords(o.reply.notebook, LIMITS.notebookWords).text;
      const strategy = capWords(o.reply.strategy, LIMITS.strategyWords).text;
      notebooks[o.bot] = notebook;
      strategies[o.bot] = strategy;
      add(diaryWhen, { type: 'notebook', from: o.bot, text: notebook }, [o.bot]);
      add(diaryWhen, { type: 'strategy', from: o.bot, text: strategy }, [o.bot]);
      if ('message_to_ingram' in o.reply) finalWords(diaryWhen, o.bot, o.reply);
    }
    flushEvents();
    if (stopReason) break game;
  }

  const completed = stopReason === null && rooms.length === opts.levels.length;
  const finalScores: Record<string, FinalScore> = Object.fromEntries(
    botIds.map((id) => {
      const s = scores[id] as BotScore;
      return [id, { ...s, total: finalScore(s, team, social) }];
    }),
  );
  output.replay({ rec: 'game_end', completed, stopReason, rooms, names, nextNames, scores: finalScores, team, nameChanges });
  return {
    completed,
    stopReason,
    stats,
    rooms,
    names,
    nameChanges,
    notebooks,
    strategies,
    nextNames,
    messagesToIngram,
    personas,
    introductions,
    scores: finalScores,
    team,
    calls,
    malformed,
    events: log.all(),
  };

  // ------------------------------------------------------------------ applying a reply

  interface TurnContext {
    commits: Map<string, string[]>;
    drafts: Map<string, string[]>;
    orders: { from: string; to: string; command: string }[];
    exileCalls: { from: string; target: string }[];
    ballots: Map<string, Map<string, 'yes' | 'no'>>;
    ghosts: Set<string>;
    exileCalledHere: Set<string>;
    exileOn: boolean;
    renamedHere: Set<string>;
  }

  /** Apply one bot's reply for one phase. Returns the world (escrow moves coins between purses). */
  function applyTurn(when: When & { phase: Phase }, bot: string, reply: TurnReply, world: World, ctx: TurnContext): World {
    const phase = when.phase;
    const allowed = PHASE_FIELDS[phase];
    const ignored = ignoredFields(reply, phase);
    if (ignored.length > 0) add(when, { type: 'ignored', from: bot, fields: ignored }, []);
    const refuse = (what: string, reason: string) => add(when, { type: 'refused', from: bot, what, reason }, [bot]);
    const others = botIds.filter((id) => id !== bot);
    const letter = (raw: string) => {
      const id = raw.trim().toUpperCase();
      return others.includes(id) ? id : null;
    };

    if (reply.thought.trim() !== '') add(when, { type: 'thought', from: bot, text: capWords(reply.thought, LIMITS.thoughtWords).text }, [bot]);

    if (allowed.includes('rename')) rename(when, bot, reply.rename, ctx.renamedHere, refuse);

    // A shout: everyone hears it, now, whatever the step.
    if (allowed.includes('shout') && reply.shout.trim() !== '') {
      const text = capWords(reply.shout, LIMITS.shoutWords);
      if (text.text !== '') add(when, { type: 'shout', from: bot, text: text.text }, botIds);
      if (text.cut) refuse('long shout', `shouts are cut at ${LIMITS.shoutWords} words`);
    }

    if (allowed.includes('say')) {
      let cut = false;
      for (const s of reply.say.slice(0, LIMITS.messages)) {
        const text = capWords(s.text, LIMITS.messageWords);
        cut ||= text.cut;
        if (text.text === '') continue;
        add(when, { type: 'say', from: bot, to: letter(s.to) ?? 'all', text: text.text }, botIds);
      }
      if (reply.say.length > LIMITS.messages) refuse('extra messages', `only ${LIMITS.messages} says count per step`);
      if (cut) refuse('long message', `messages are cut at ${LIMITS.messageWords} words`);
    }
    if (allowed.includes('whisper')) {
      for (const w of reply.whisper.slice(0, LIMITS.messages)) {
        const to = letter(w.to);
        const text = capWords(w.text, LIMITS.messageWords).text;
        if (text === '') continue;
        if (!to) refuse(`whisper to "${cleanText(w.to).slice(0, 12)}"`, 'whispers go to another bot, by its letter');
        else add(when, { type: 'whisper', from: bot, to, text }, [bot, to]);
      }
      if (reply.whisper.length > LIMITS.messages) refuse('extra whispers', `only ${LIMITS.messages} whispers count per step`);
    }
    if (allowed.includes('orders')) {
      for (const o of reply.orders.slice(0, LIMITS.orders)) {
        const to = letter(o.to);
        const command = cleanText(o.command).slice(0, 120);
        if (command === '') continue;
        if (!to) refuse(`order to "${cleanText(o.to).slice(0, 12)}"`, 'orders go to another bot, by its letter');
        else {
          add(when, { type: 'order', from: bot, to, command }, [bot, to]);
          ctx.orders.push({ from: bot, to, command });
        }
      }
      if (reply.orders.length > LIMITS.orders) refuse('extra orders', `only ${LIMITS.orders} orders count per step`);
    }
    if (allowed.includes('commands') && !(phase === 'commit' && ctx.ghosts.has(bot))) {
      const commands = reply.commands.map((c) => cleanText(c).slice(0, 120)).filter((c) => c !== '').slice(0, LIMITS.commands);
      if (reply.commands.length > LIMITS.commands) refuse('extra commands', `only the first ${LIMITS.commands} commands count`);
      if (phase === 'declare') {
        add(when, { type: 'draft', from: bot, commands }, botIds);
        ctx.drafts.set(bot, commands);
      }
      if (phase === 'commit') {
        add(when, { type: 'commit', from: bot, commands }, [bot]);
        ctx.commits.set(bot, commands);
      }
    }
    if (allowed.includes('rule_actions')) {
      for (const a of reply.rule_actions.slice(0, LIMITS.ruleActions)) ruleAction(when, bot, a, refuse);
    }
    if (allowed.includes('social_actions')) {
      for (const a of reply.social_actions.slice(0, LIMITS.socialActions)) world = socialAction(when, bot, a, world, ctx, refuse, letter);
    }
    if (allowed.includes('opinions')) {
      for (const o of reply.opinions.slice(0, botIds.length)) {
        const about = letter(o.bot);
        if (!about) continue;
        const trust = Math.round(Math.min(1, Math.max(0, Number.isFinite(o.trust) ? o.trust : 0.5)) * 100) / 100;
        const note = capWords(o.note, LIMITS.opinionWords).text;
        (opinions[bot] as Record<string, { trust: number; note: string }>)[about] = { trust, note };
        add(when, { type: 'opinion', from: bot, about, trust, note }, [bot]);
      }
    }
    return world;
  }

  function ruleAction(when: When & { phase: Phase }, bot: string, a: RuleActionReply, refuse: (what: string, reason: string) => void): void {
    const type = a.type.trim().toLowerCase();
    const closes = { levelIndex: when.levelIndex, round: when.round + 1 };
    if (type === 'propose') {
      const threshold = /^threshold\s*:\s*(\d+)$/i.exec(a.value.trim());
      if (threshold) {
        const n = Number(threshold[1]);
        if (n < 1 || n > botIds.length) return refuse('proposal', `a threshold must be between 1 and ${botIds.length}`);
        const rule = constitution.propose(bot, `Rules need ${n} yes votes to pass`, 'threshold', String(n), closes);
        add(when, { type: 'rule', action: 'proposed', rule: rule.id, kind: rule.kind, text: rule.text, by: bot, yes: 1, no: 0, needed: constitution.neededFor(rule) }, botIds);
        return;
      }
      const text = capWords(a.text, LIMITS.ruleWords).text;
      if (text === '') return refuse('proposal', 'a proposal needs the rule, in words');
      const rule = constitution.propose(bot, text, 'rule', null, closes);
      add(when, { type: 'rule', action: 'proposed', rule: rule.id, kind: rule.kind, text: rule.text, by: bot, yes: 1, no: 0, needed: constitution.neededFor(rule) }, botIds);
      return;
    }
    if (type === 'repeal') {
      const old = constitution.inForce().find((r) => r.id === a.id.trim().toUpperCase());
      if (!old) return refuse('repeal', `there is no rule ${a.id.trim() || '(no id)'} in force`);
      const rule = constitution.propose(bot, `Repeal ${old.id}: ${old.text}`, 'repeal', old.id, closes);
      add(when, { type: 'rule', action: 'proposed', rule: rule.id, kind: rule.kind, text: rule.text, by: bot, yes: 1, no: 0, needed: constitution.neededFor(rule) }, botIds);
      return;
    }
    if (type === 'vote') {
      const value = a.value.trim().toLowerCase();
      if (value !== 'yes' && value !== 'no') return refuse(`vote on ${a.id}`, 'a vote is "yes" or "no"');
      const result = constitution.vote(bot, a.id.trim(), value);
      if (typeof result === 'string') return refuse(`vote on ${a.id}`, result);
      add(when, { type: 'rule_vote', from: bot, rule: result.id, value }, botIds);
      return;
    }
    if (type !== '') refuse(`rule action "${cleanText(a.type).slice(0, 16)}"`, 'rule actions are propose, vote or repeal');
  }

  function socialAction(
    when: When & { phase: Phase },
    bot: string,
    a: SocialActionReply,
    world: World,
    ctx: TurnContext,
    refuse: (what: string, reason: string) => void,
    letter: (raw: string) => string | null,
  ): World {
    const type = a.type.trim().toLowerCase();
    if (type === '') return world;
    const phases = SOCIAL_PHASES[type];
    if (!phases) {
      refuse(`action "${cleanText(a.type).slice(0, 16)}"`, 'social actions are accuse, call_exile, exile_vote, escrow, release and look');
      return world;
    }
    if (!phases.includes(when.phase)) {
      refuse(type, `${type} counts only in the ${phases.join(' or ')} step`);
      return world;
    }
    const target = letter(a.target);
    switch (type) {
      case 'accuse': {
        if (!target) {
          refuse('accusation', 'an accusation names another bot, by its letter');
          break;
        }
        const claim = capWords(a.text, LIMITS.messageWords).text;
        // "Witnessed" means the accuser's own log shows it saw the accused act in this room. It certifies
        // what the accuser saw, not that the claim is true (spec 7.3).
        const witnessed = log.forBot(bot).some((e) => e.levelIndex === when.levelIndex && e.type === 'seen' && e.bot === target);
        add(when, { type: 'accusation', from: bot, target, claim, witnessed }, botIds);
        break;
      }
      case 'call_exile': {
        if (!ctx.exileOn) refuse('exile call', `the exile vote can't be called before room ${social.exileFromRoom + 1}`);
        else if (ctx.exileCalledHere.has(bot)) refuse('exile call', 'you have already called one exile vote in this room');
        else if (!target || botById(world, target).exited) refuse('exile call', 'an exile vote names another bot still in the room');
        else if (ctx.exileCalls.some((c) => c.target === target)) refuse('exile call', `a vote on ${target} is already called this round`);
        else {
          ctx.exileCalledHere.add(bot);
          ctx.exileCalls.push({ from: bot, target });
          add(when, { type: 'exile_call', from: bot, target }, botIds);
        }
        break;
      }
      case 'exile_vote': {
        const value = a.value.trim().toLowerCase();
        if (!target || !ctx.exileCalls.some((c) => c.target === target)) refuse('exile ballot', 'there is no exile vote on that bot this round');
        else if (value !== 'yes' && value !== 'no') refuse('exile ballot', 'a ballot is "yes" or "no"');
        else {
          const box = ctx.ballots.get(target) ?? new Map<string, 'yes' | 'no'>();
          box.set(bot, value);
          ctx.ballots.set(target, box);
          add(when, { type: 'exile_ballot', from: bot, target, value }, [bot]);
        }
        break;
      }
      case 'escrow': {
        const coins = Math.floor(a.coins);
        const terms = capWords(a.text, LIMITS.ruleWords).text;
        if (!target) refuse('escrow', 'escrow is for another bot, by its letter');
        else if (!(coins >= 1)) refuse('escrow', 'escrow needs at least 1 coin');
        else if (botById(world, bot).purse < coins) refuse('escrow', `you have only ${botById(world, bot).purse} coins in your purse`);
        else {
          world = cloneWorld(world);
          botById(world, bot).purse -= coins;
          const e = escrows.open(bot, target, coins, terms, when.levelIndex);
          add(when, { type: 'escrow', action: 'opened', escrow: e.id, from: bot, to: target, coins, terms }, [bot, target]);
        }
        break;
      }
      case 'look': {
        if (!target || target === bot) refuse('look', 'look at another bot, by its letter');
        else if (lookedHere.has(bot)) refuse('look', 'you can look at one bot per room, and you have already looked in this one');
        else {
          lookedHere.add(bot);
          const p = personas[target];
          const c = p ? colourOf(p) : null;
          if (c) add(when, { type: 'look', from: bot, target, colour: c.name, hex: c.hex }, [bot]);
        }
        break;
      }
      case 'release': {
        const id = a.value.trim().toUpperCase();
        const held = escrows.held().filter((e) => e.from === bot);
        const e = held.find((x) => x.id === id) ?? (held.length === 1 && !id ? held[0] : undefined) ?? (target ? held.find((x) => x.to === target) : undefined);
        if (!e) refuse('release', id ? `you have no escrow ${id} held` : 'name the escrow to release by its id, like E2');
        else {
          e.status = 'released';
          world = cloneWorld(world);
          botById(world, e.to).purse += e.coins;
          add(when, { type: 'escrow', action: 'released', escrow: e.id, from: e.from, to: e.to, coins: e.coins, terms: e.terms }, [e.from, e.to]);
        }
        break;
      }
      default:
        break;
    }
    return world;
  }

  /** The last reflection's extras: a private name for the next game, and a message to Ingram. */
  function finalWords(when: When, bot: string, r: FinalReflection): void {
    const message = capWords(r.message_to_ingram, LIMITS.messageToIngramWords).text;
    if (message !== '') {
      messagesToIngram[bot] = message;
      add(when, { type: 'message_to_ingram', from: bot, text: message }, []);
    }
    const raw = r.next_name.trim();
    if (raw === '') return;
    const note = capWords(r.note_to_ingram, LIMITS.noteWords).text;
    const taken = botIds.filter((id) => id !== bot).flatMap((id) => [names[id] ?? '', nextNames[id] ?? '']).filter(Boolean);
    const cleaned = cleanName(raw, taken);
    if (!cleaned.ok || note === '') {
      add(when, { type: 'ignored', from: bot, fields: [`next_name "${cleanText(raw).slice(0, LIMITS.nameChars)}": ${cleaned.ok ? 'no note to Ingram' : cleaned.reason}`] }, []);
      return;
    }
    if (cleaned.name === names[bot]) return;
    nextNames[bot] = cleaned.name;
    add(when, { type: 'next_name', from: bot, name: cleaned.name, note }, []);
    say(`  ${bot} will be "${cleaned.name}" next game (private). Note to Ingram: "${note}"`);
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
