/**
 * Affordances: what a bot can reach from where it stands, worked out by the
 * engine with the rulebook's NOMINAL stats.
 *
 * The spec (section 6): "Affordances computed with nominal stats: 'reachable:
 * ledge L3 (jump run_up=2), crate C1 (walk 3.25). Not reachable alone:
 * platform P4.'" Bots get exact answers to "can I get there?" so that the
 * hard part of the game is coordinating, not arithmetic (principle 5).
 *
 * The engine finds out by trying: every useful command from the bot's spot,
 * then every command from each new spot, a few moves deep, on a copy of the
 * world in which this bot has nominal stats. The first (shortest) plan that
 * reaches a target is the one reported. The same search, run with the best
 * stats the rules allow, is the validator's "can one bot finish alone?" check.
 *
 * Because the plans assume nominal stats, a bot whose hidden stats differ will
 * see results that don't quite match the plan. That gap is how bots discover
 * their own stats (spec: "Discovery by design").
 */
import { UNITS_PER_TILE as T } from './constants';
import { coinBox, exitBox, leverReachBox, overlaps } from './collision';
import type { Level } from './level';
import { atRest } from './physics';
import { resolvePhase } from './resolve';
import type { BotStats } from './stats';
import { NOMINAL_STATS, physicsFor } from './stats';
import type { Bot, World } from './world';
import { botById, cloneWorld } from './world';

/** Something a bot might want to get to. Surfaces are in units: stand anywhere on [x0, x1) at height y. */
export type Target =
  | { id: string; kind: 'surface'; x0: number; x1: number; y: number }
  | { id: string; kind: 'lever' | 'exit' | 'coin'; entity: string };

export interface Reach {
  id: string;
  reachable: boolean;
  /** The shortest plan found, from where the bot stands now. */
  plan: string[] | null;
}

/** Every command worth trying from a standing position. */
export function exploreCommands(level: Level): string[] {
  const ids = [...level.crates, ...level.plates, ...level.doors, ...level.levers, ...level.exits].map((e) => e.id);
  const out = ['walk_to_edge(left)', 'walk_to_edge(right)'];
  for (const d of [1, 2, 4]) out.push(`walk(left, ${d})`, `walk(right, ${d})`);
  for (const id of ids) out.push(`walk_to(${id})`);
  for (const dir of ['left', 'right']) {
    for (const r of [0, 1, 2, 3]) out.push(`jump(${dir}, run_up=${r}, hold=full)`);
    out.push(`jump(${dir}, run_up=0, hold=short)`);
  }
  out.push('jump(up, run_up=0, hold=full)', 'drop', 'climb(up)', 'climb(down)', 'pull_lever');
  out.push('push(left, 2)', 'push(right, 2)', 'enter_exit');
  return out;
}

/** Positions closer than a quarter tile count as the same place, which keeps the search finite. */
export function stateKey(world: World, botId: string): string {
  const bot = world.bots.find((b) => b.id === botId);
  const parts = [bot ? `${Math.round(bot.x / (T / 4))},${bot.y},${bot.onLadder ? 'L' : ''},${bot.exited ? 'X' : ''}` : 'none'];
  for (const c of world.crates) parts.push(`${c.id}:${Math.round(c.x / (T / 4))},${c.y}`);
  for (const [id, on] of Object.entries(world.levers)) if (on) parts.push(id);
  return parts.join('|');
}

/** Has `bot` reached `target` in this world? */
export function hasReached(world: World, bot: Bot, target: Target): boolean {
  const { level } = world;
  switch (target.kind) {
    case 'surface':
      return bot.grounded && bot.y === target.y && bot.x < target.x1 && bot.x + bot.w > target.x0;
    case 'lever': {
      const lever = level.levers.find((l) => l.id === target.entity);
      return lever !== undefined && !bot.onLadder && overlaps(bot, leverReachBox(lever));
    }
    case 'exit': {
      const exit = level.exits.find((e) => e.id === target.entity);
      return exit !== undefined && (bot.exited || overlaps(bot, exitBox(exit)));
    }
    case 'coin': {
      const coin = level.coins.find((c) => c.id === target.entity);
      return coin !== undefined && (bot.coins.includes(coin.id) || overlaps(bot, coinBox(coin)));
    }
  }
}

/**
 * A copy of the world with only this bot in it, given the stats to search
 * with (nominal by default). The other bots are taken out entirely: "alone"
 * means alone, and standing on someone's head is help, even if they never
 * move a muscle.
 */
export function aloneWith(world: World, botId: string, stats: BotStats = NOMINAL_STATS): World {
  const copy = cloneWorld(world);
  copy.bots = copy.bots.filter((b) => b.id === botId);
  const bot = botById(copy, botId);
  bot.stats = stats;
  bot.phys = physicsFor(stats);
  return copy;
}

export interface SearchOptions {
  /** Longest plan to try (default 4 commands). */
  maxDepth?: number;
  /** Most places to visit before giving up (default 4000). */
  maxStates?: number;
}

export interface SearchResult {
  reaches: Reach[];
  statesExplored: number;
  /** True if every place within maxDepth was tried. */
  exhausted: boolean;
}

/**
 * Breadth-first search for the shortest plan to each target for `botId`.
 * Any other bots in the world act as obstacles; pass a world from
 * aloneWith() to search for what the bot can do on its own.
 */
export function searchPlans(input: World, botId: string, targets: readonly Target[], options: SearchOptions = {}): SearchResult {
  const maxDepth = options.maxDepth ?? 4;
  const maxStates = options.maxStates ?? 4000;
  // Plans start from a settled world: a bot still falling can't walk or jump, so let everything land first.
  const world = atRest(input) ? input : resolvePhase(input, { [botId]: ['wait'] }, { trace: false }).world;
  const commands = exploreCommands(world.level);
  const found = new Map<string, string[]>();
  const check = (w: World, plan: string[]) => {
    const bot = botById(w, botId);
    for (const t of targets) if (!found.has(t.id) && hasReached(w, bot, t)) found.set(t.id, plan);
  };
  check(world, []);
  const seen = new Set([stateKey(world, botId)]);
  let frontier: { world: World; plan: string[] }[] = [{ world, plan: [] }];
  let exhausted = true;
  for (let depth = 1; depth <= maxDepth && frontier.length > 0 && found.size < targets.length; depth++) {
    const next: typeof frontier = [];
    for (const { world: w, plan } of frontier) {
      for (const command of commands) {
        const out = resolvePhase(w, { [botId]: [command] }, { trace: false });
        const result = out.results[0];
        if (!result || result.status !== 'done') continue;
        const key = stateKey(out.world, botId);
        if (seen.has(key)) continue;
        if (seen.size >= maxStates) {
          exhausted = false;
          break;
        }
        seen.add(key);
        const newPlan = [...plan, command];
        check(out.world, newPlan);
        next.push({ world: out.world, plan: newPlan });
      }
    }
    frontier = next;
    if (depth === maxDepth && next.length > 0) exhausted = false;
  }
  return {
    reaches: targets.map((t) => ({ id: t.id, reachable: found.has(t.id), plan: found.get(t.id) ?? null })),
    statesExplored: seen.size,
    exhausted,
  };
}

/** Affordances for one bot: what it can reach alone, with nominal stats. */
export function affordances(world: World, botId: string, targets: readonly Target[], options: SearchOptions = {}): SearchResult {
  return searchPlans(aloneWith(world, botId), botId, targets, options);
}
