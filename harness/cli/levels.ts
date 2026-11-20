/**
 * npm run levels [-- --level L2] [--seed some-seed] [--brief]
 *
 * Checks every level in config/levels/ and shows how it plays:
 *   1. the level as a picture
 *   2. its solution played with nominal stats, command by command
 *   3. the same solution with extreme and random hidden stats
 *   4. for cooperative levels, the search for a way one bot could finish alone
 *   5. determinism: the same seed twice must give a byte-identical trace
 * Free: no model is involved. Exits with an error code if any level fails.
 */
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { initWorld } from '../../engine/physics';
import { RunRandom } from '../../engine/random';
import { renderWorld } from '../../engine/render';
import type { BotStats, StatName } from '../../engine/stats';
import { bestStats, extremeStats, NOMINAL_STATS, rollStats, STAT_NAMES } from '../../engine/stats';
import { runSolution, soloCheck } from '../../engine/validate';
import { loadGameConfig } from '../config';
import { loadLevels } from '../levels';
import { say } from '../log';

const { values } = parseArgs({
  options: {
    level: { type: 'string' },
    seed: { type: 'string', default: 'levels-check' },
    brief: { type: 'boolean', default: false },
  },
});
const ranges = loadGameConfig().hiddenStats;
const levels = loadLevels().filter((l) => !values.level || l.id.toLowerCase().includes(values.level.toLowerCase()));
let allGood = true;

/** All 64 combinations of every stat at the top or bottom of its range. */
function corners(): BotStats[] {
  const out: BotStats[] = [];
  for (let mask = 0; mask < 1 << STAT_NAMES.length; mask++) {
    const signs = Object.fromEntries(STAT_NAMES.map((n, i) => [n, mask & (1 << i) ? 1 : -1])) as Record<StatName, 1 | -1>;
    out.push(extremeStats(ranges, signs));
  }
  return out;
}

for (const level of levels) {
  const ids = Object.keys(level.spawns).sort();
  const everyone = (s: BotStats) => Object.fromEntries(ids.map((id) => [id, s]));
  say(`== ${level.id}: ${level.name}${level.cooperative ? ' (cooperative)' : ''}`);
  say(`   ${level.description}`);
  if (!values.brief) for (const row of renderWorld(initWorld(level, everyone(NOMINAL_STATS)))) say(`   ${row}`);

  // 1. The solution with nominal stats, command by command.
  const run = runSolution(level, everyone(NOMINAL_STATS));
  if (!values.brief) {
    run.rounds.forEach((round, i) => {
      say(`   Round ${i + 1}`);
      for (const r of round.results) {
        const detail = r.reason ?? r.note;
        say(`     ${r.bot}.${r.slot} ${r.command.padEnd(34)} ${r.status}${detail ? `: ${detail}` : ''}`);
      }
    });
  }
  say(`   Nominal stats: ${run.completed ? 'finished' : 'NOT FINISHED'}; through the exit: ${run.botsThrough.join(' ') || 'nobody'}`);
  if (!run.completed) allGood = false;

  // 2. Extreme and random hidden stats.
  const extremes = corners().filter((s) => runSolution(level, everyone(s)).completed).length;
  const rng = new RunRandom(`${values.seed}:${level.id}`).stream('stats');
  let randomOk = 0;
  const RANDOM = 40;
  for (let i = 0; i < RANDOM; i++) {
    const stats = Object.fromEntries(ids.map((id) => [id, rollStats(rng, ranges)]));
    if (runSolution(level, stats).completed) randomOk++;
  }
  say(`   Solution works for ${extremes}/64 extreme stat combinations and ${randomOk}/${RANDOM} random rolls.`);
  if (extremes < 64 || randomOk < RANDOM) allGood = false;

  // 3. Can one bot do it alone?
  if (level.cooperative) {
    const solo = soloCheck(level, bestStats(ranges));
    if (solo.solvable) {
      allGood = false;
      say(`   PROBLEM: one bot can finish it alone: ${solo.path?.join(', ')}`);
    } else if (!solo.exhausted) {
      allGood = false;
      say(`   PROBLEM: the solo search gave up after ${solo.statesExplored} positions.`);
    } else {
      say(`   Cooperative: no single bot can finish it (searched every one of ${solo.statesExplored} positions the best possible bot can reach).`);
    }
  }

  // 4. Determinism: same seed, same trace, byte for byte.
  const seeded = () => {
    const r = new RunRandom(values.seed).stream('stats');
    const stats = Object.fromEntries(ids.map((id) => [id, rollStats(r, ranges)]));
    const out = runSolution(level, stats, { trace: true });
    return createHash('sha256')
      .update(JSON.stringify(out.rounds.map((x) => ({ results: x.results, events: x.events, trace: x.trace }))))
      .digest('hex')
      .slice(0, 16);
  };
  const first = seeded();
  const second = seeded();
  say(`   Same seed twice: ${first === second ? 'identical' : 'DIFFERENT'} trace (${first})`);
  if (first !== second) allGood = false;
  say();
}

say(allGood ? 'All levels are valid.' : 'Some levels have problems (see above).');
process.exitCode = allGood ? 0 : 1;
