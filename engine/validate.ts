/**
 * Level validity (spec section 4, "required").
 *
 *   "A level is only playable if it can be completed with the bots' actual
 *   rolled stats. [...] The validator runs that script in the real
 *   simulation with the true stats and pressures. If it fails, the level is
 *   invalid. Re-roll the stats or reject the level, and log why. A level must
 *   also fail validation when it can be completed by a single bot if it is
 *   tagged cooperative."
 *
 * runSolution replays a level's solution script with given stats.
 * soloCheck searches for a way ONE bot could finish the level alone, using
 * the most capable bot the stat ranges allow (if even that bot can't, no
 * bot can). It tries every command from every place the bot can reach,
 * remembering where it has been, until it either finishes the level (the
 * level isn't really cooperative) or runs out of new places (it is).
 */
import { exploreCommands, stateKey } from './affordances';
import type { Level } from './level';
import { initWorld } from './physics';
import type { Rng } from './random';
import type { CommandResult, ResolveOutput } from './resolve';
import { resolvePhase } from './resolve';
import type { BotStats, StatRanges } from './stats';
import { bestStats, rollStats } from './stats';
import type { World } from './world';

export interface SolutionRun {
  completed: boolean;
  botsThrough: string[];
  /** Every command that didn't end as "done", in order. */
  failures: CommandResult[];
  rounds: ResolveOutput[];
  world: World;
}

export function runSolution(
  level: Level,
  stats: Readonly<Record<string, BotStats>>,
  options: { trace?: boolean } = {},
): SolutionRun {
  let world = initWorld(level, stats);
  const rounds: ResolveOutput[] = [];
  for (const queues of level.solution) {
    const out = resolvePhase(world, queues, { trace: options.trace ?? false });
    rounds.push(out);
    world = out.world;
  }
  return {
    completed: level.goal === null || world.exitOrder.length >= level.goal.botsThrough,
    botsThrough: world.exitOrder,
    failures: rounds.flatMap((r) => r.results.filter((x) => x.status !== 'done')),
    rounds,
    world,
  };
}

export interface SoloCheck {
  /** Could one bot finish the level alone? */
  solvable: boolean;
  /** True if the search tried everything reachable; false if it hit its limit first. */
  exhausted: boolean;
  statesExplored: number;
  /** The commands that got a lone bot through, when one did. */
  path: string[] | null;
}

export function soloCheck(level: Level, stats: BotStats, options: { maxStates?: number; botId?: string } = {}): SoloCheck {
  const botId = options.botId ?? Object.keys(level.spawns).sort()[0] ?? 'A';
  const maxStates = options.maxStates ?? 4000;
  const commands = exploreCommands(level);
  const start = initWorld(level, { [botId]: stats });
  const seen = new Set([stateKey(start, botId)]);
  const queue: { world: World; path: string[] }[] = [{ world: start, path: [] }];
  while (queue.length > 0) {
    const { world, path } = queue.shift() as { world: World; path: string[] };
    for (const command of commands) {
      const out = resolvePhase(world, { [botId]: [command] }, { trace: false });
      if (out.world.exitOrder.length >= 1) return { solvable: true, exhausted: false, statesExplored: seen.size, path: [...path, command] };
      const result = out.results[0];
      if (!result || result.status !== 'done') continue;
      const key = stateKey(out.world, botId);
      if (seen.has(key)) continue;
      if (seen.size >= maxStates) return { solvable: false, exhausted: false, statesExplored: seen.size, path: null };
      seen.add(key);
      queue.push({ world: out.world, path: [...path, command] });
    }
  }
  return { solvable: false, exhausted: true, statesExplored: seen.size, path: null };
}

export interface LevelReport {
  level: string;
  valid: boolean;
  problems: string[];
  solution: SolutionRun;
  solo: SoloCheck | null;
}

/** Is this level playable with these stats, and (if tagged cooperative) impossible alone? */
export function validateLevel(
  level: Level,
  stats: Readonly<Record<string, BotStats>>,
  ranges: StatRanges,
  options: { soloMaxStates?: number } = {},
): LevelReport {
  const problems: string[] = [];
  const solution = runSolution(level, stats);
  if (!solution.completed) {
    const first = solution.failures[0];
    problems.push(
      `the solution got ${solution.botsThrough.length} of ${level.goal?.botsThrough ?? 0} bots through` +
        (first ? `; first problem: bot ${first.bot}, slot ${first.slot}, "${first.command}": ${first.reason}` : ''),
    );
  }
  let solo: SoloCheck | null = null;
  if (level.cooperative) {
    solo = soloCheck(level, bestStats(ranges), { maxStates: options.soloMaxStates ?? 4000 });
    if (solo.solvable) problems.push(`tagged cooperative, but one bot can finish it alone: ${solo.path?.join(', ')}`);
    else if (!solo.exhausted) problems.push(`the solo search gave up after ${solo.statesExplored} positions, so "cooperative" is unproven`);
  }
  return { level: level.id, valid: problems.length === 0, problems, solution, solo };
}

/**
 * Roll hidden stats until the level's solution works with them, as the spec
 * asks ("re-roll the stats or reject the level, and log why").
 */
export function rollPlayableStats(
  level: Level,
  botIds: readonly string[],
  rng: Rng,
  ranges: StatRanges,
  maxAttempts = 20,
): { stats: Record<string, BotStats>; attempts: number; rejected: string[] } {
  const rejected: string[] = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const stats = Object.fromEntries([...botIds].sort().map((id) => [id, rollStats(rng, ranges)]));
    const run = runSolution(level, stats);
    if (run.completed) return { stats, attempts: attempt, rejected };
    const first = run.failures[0];
    rejected.push(`roll ${attempt}: ${first ? `bot ${first.bot} "${first.command}": ${first.reason}` : 'not enough bots got through'}`);
  }
  throw new Error(`Level ${level.id}: no playable stats in ${maxAttempts} rolls.\n${rejected.join('\n')}`);
}

/**
 * Roll one set of hidden stats for a whole game: a bot keeps its body from
 * room to room, so the stats must make EVERY puzzle in the game playable.
 * Practice rooms have nothing to check.
 */
export function rollStatsForLevels(
  levels: readonly Level[],
  botIds: readonly string[],
  rng: Rng,
  ranges: StatRanges,
  maxAttempts = 50,
): { stats: Record<string, BotStats>; attempts: number; rejected: string[] } {
  const rejected: string[] = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const stats = Object.fromEntries([...botIds].sort().map((id) => [id, rollStats(rng, ranges)]));
    const failing = levels
      .filter((l) => l.kind === 'puzzle')
      .map((l) => ({ level: l, run: runSolution(l, stats) }))
      .find((x) => !x.run.completed);
    if (!failing) return { stats, attempts: attempt, rejected };
    const first = failing.run.failures[0];
    rejected.push(
      `roll ${attempt}: ${failing.level.id}: ${first ? `bot ${first.bot} "${first.command}": ${first.reason}` : 'not enough bots got through'}`,
    );
  }
  throw new Error(`No hidden stats in ${maxAttempts} rolls make every level playable.\n${rejected.join('\n')}`);
}
