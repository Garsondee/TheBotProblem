/**
 * The move menu: where each single move would take a bot from where it
 * stands now. This is milestone 3's answer to "reliable movement or skill?".
 *
 * Ingram (2026-11-20): "if we remove skill we remove tension / conflict". So
 * the engine doesn't plan routes for the bots (no go_to). Each round, every
 * bot gets a menu of single moves with the engine's prediction of where each
 * one ends. The skill that stays with the bots:
 *   - chaining moves into routes (only the first move of a queue is predicted)
 *   - timing moves around other bots (predictions assume nobody else moves)
 *   - learning their own bodies (predictions use the rulebook's nominal stats,
 *     and a bot's true stats differ a little: spec, "Discovery by design")
 *
 * The rules that keep a prediction from telling a bot more than it may know:
 *   - Every bot in the prediction has nominal stats, so no hidden stat shows
 *     through (another bot's true weight on a plate, say).
 *   - Bots and crates the viewer can't see are taken out of the prediction,
 *     so a predicted bump can't give them away.
 *   - A move is listed only if the bot's whole path stays in tiles it can see
 *     now, so a prediction can't reveal terrain out of sight.
 *   - Only movement is predicted. What levers, plates and doors do is for the
 *     bots to find out (Ingram: "We don't tell the bots about the rules of how
 *     these elements work").
 *   - A move that would fail isn't listed. The bot can still try it.
 */
import { UNITS_PER_TILE as T } from './constants';
import { surfaceIntervals } from './collision';
import { atRest } from './physics';
import type { Trace } from './resolve';
import { resolvePhase } from './resolve';
import type { Perception } from './sight';
import { NOMINAL_STATS, physicsFor } from './stats';
import type { Bot, World } from './world';
import { botById, cloneWorld, feet, footingText } from './world';

export interface Move {
  /** Exactly what to write. */
  command: string;
  /** Where the feet would end up, in units. */
  to: { x: number; y: number };
  /** Change of height, in units: positive is up. */
  rise: number;
  /** What the bot would end up on, in words: "solid ground", "crate C1", "the ladder", ... */
  on: string;
}

/**
 * The world as the viewer can know it: only what it sees, everyone with the
 * rulebook's stats, settled (taking something out can leave a body with
 * nothing under it).
 */
export function predictionWorld(world: World, botId: string, seen: Perception): World {
  const copy = cloneWorld(world);
  const keep = new Set(seen.bots);
  // The viewer always stays (even a ghost, out of the physics, still looks around); others only if seen and present.
  copy.bots = copy.bots.filter((b) => b.id === botId || (keep.has(b.id) && !b.exited));
  copy.crates = copy.crates.filter((c) => seen.crates.includes(c.id));
  const phys = physicsFor(NOMINAL_STATS);
  for (const b of copy.bots) {
    b.stats = NOMINAL_STATS;
    b.phys = phys;
  }
  return atRest(copy) ? copy : resolvePhase(copy, { [botId]: ['wait'] }, { trace: false }).world;
}

/** Every single move worth predicting, simplest first (when two reach the same spot, the first is kept). */
function candidates(bot: Bot, seen: Perception): string[] {
  if (bot.exited) return [];
  if (bot.onLadder) return ['climb(up)', 'climb(down)'];
  if (!bot.grounded) return [];
  const out = ['walk_to_edge(left)', 'walk_to_edge(right)'];
  for (const id of [...seen.bots, ...seen.crates, ...seen.doors, ...seen.plates, ...seen.levers, ...seen.exits, ...seen.coins, ...seen.ladders]) {
    out.push(`walk_to(${id})`);
  }
  out.push('climb(up)', 'climb(down)', 'drop', 'jump(up, run_up=0, hold=short)', 'jump(up, run_up=0, hold=full)');
  // Over a bot right beside you (the menu keeps it only where the hop would work).
  for (const id of seen.bots) out.push(`hop_over(${id})`);
  for (const runUp of [0, 1, 2, 3]) {
    for (const hold of ['short', 'full']) for (const dir of ['left', 'right']) out.push(`jump(${dir}, run_up=${runUp}, hold=${hold})`);
  }
  return out;
}

/**
 * The stretch of surface a bot stands on, as a key: jumps that land anywhere
 * on it count as one destination. A ladder top and the shelf beside it are
 * one stretch: you can walk from one to the other.
 */
function stretchKey(world: World, bot: Bot): string {
  if (bot.onLadder) return `ladder@${Math.floor((bot.x + bot.w / 2) / T)}`;
  const stretch = surfaceIntervals(world, bot.y, bot).find(([a, b]) => a < bot.x + bot.w && b > bot.x);
  return `${bot.y}|${stretch ? `${stretch[0]}-${stretch[1]}` : 'none'}`;
}

/** Did the bot's middle stay in tiles the viewer can see, the whole way? */
function pathInSight(trace: Trace | null, bot: Bot, world: World, tiles: readonly boolean[]): boolean {
  if (!trace) return false;
  const width = world.level.width;
  for (const frame of trace.frames) {
    const b = frame.bodies[bot.id];
    if (!b) continue;
    const tx = Math.floor((b[0] + bot.w / 2) / T);
    const ty = Math.floor((b[1] + bot.h / 2) / T);
    if (tiles[ty * width + tx] !== true) return false;
  }
  return true;
}

export function describeFooting(bot: Bot): string {
  if (bot.onLadder) return 'the ladder';
  return bot.support ? footingText(bot) : 'nothing (in the air)';
}

const spotKey = (bot: Bot) => `${Math.round(bot.x / (T / 4))}|${bot.y}|${bot.onLadder ? 'ladder' : describeFooting(bot)}`;

/** Would a plain walk get the bot to within half a tile of `target`, on the same footing? */
function walkReaches(start: World, botId: string, target: Bot): boolean {
  const me = botById(start, botId);
  const dx = target.x - me.x;
  const quarters = Math.round(Math.abs(dx) / (T / 4)) / 4;
  if (quarters === 0) return true;
  const walk = resolvePhase(start, { [botId]: [`walk(${dx > 0 ? 'right' : 'left'}, ${quarters})`] }, { trace: false });
  const walked = botById(walk.world, botId);
  return walk.results[0]?.status === 'done' && walked.y === target.y && Math.abs(walked.x - target.x) <= T / 2;
}

/**
 * The move menu for `botId`: each move's predicted landing spot, one move per
 * distinct spot, sorted left to right. `seen` is what the bot can see now
 * (sight.perceive).
 */
export function moveMenu(world: World, botId: string, seen: Perception, options: { maxMoves?: number } = {}): Move[] {
  const maxMoves = options.maxMoves ?? 16;
  const start = predictionWorld(world, botId, seen);
  const me = botById(start, botId);
  const from = feet(me);
  const spots = new Map<string, Move>([[spotKey(me), { command: '', to: from, rise: 0, on: '' }]]); // "stay put" isn't a move
  const jumpLandings = new Set<string>();
  const startStretch = stretchKey(start, me);
  for (const command of candidates(me, seen)) {
    const out = resolvePhase(start, { [botId]: [command] }, { trace: true });
    const result = out.results[0];
    if (!result || result.status !== 'done') continue;
    const end = botById(out.world, botId);
    if (end.exited || !pathInSight(out.trace, end, start, seen.tiles)) continue;
    const key = spotKey(end);
    if (spots.has(key)) continue;
    if (command.startsWith('jump')) {
      // Jumps are listed by where they land: the first (simplest) jump to each surface stands for the rest.
      const landing = stretchKey(out.world, end);
      if (jumpLandings.has(landing)) continue;
      // A jump that lands on the floor a plain walk would reach is a walk with extra risk: leave it out.
      if (landing === startStretch && walkReaches(start, botId, end)) continue;
      jumpLandings.add(landing);
    }
    const to = feet(end);
    spots.set(key, { command, to, rise: to.y - from.y, on: describeFooting(end) });
  }
  const moves = [...spots.values()].filter((m) => m.command !== '');
  // Too many? Keep the ones that change height first: those are the ones that are hard to work out.
  const kept = moves.length <= maxMoves ? moves : [...moves].sort((a, b) => Number(b.rise !== 0) - Number(a.rise !== 0)).slice(0, maxMoves);
  return kept.sort((a, b) => a.to.x - b.to.x || a.to.y - b.to.y);
}
