/** Helpers for engine tests: tiny levels drawn inline, and a way to play rounds on them. */
import type { Level, LevelFile } from '../engine/level';
import { LevelFileSchema, parseLevel } from '../engine/level';
import { initWorld } from '../engine/physics';
import type { CommandResult, ResolveOutput } from '../engine/resolve';
import { resolvePhase } from '../engine/resolve';
import type { BotStats } from '../engine/stats';
import { NOMINAL_STATS } from '../engine/stats';
import type { World, WorldEvent } from '../engine/world';

/** A level from a picture. Every test map includes an exit ("x") so the level is valid. */
export function makeLevel(map: string[], key: LevelFile['key'] = {}, extra: Partial<LevelFile> = {}): Level {
  return parseLevel(
    LevelFileSchema.parse({
      id: 'test',
      name: 'Test',
      description: '',
      map,
      key: { x: { type: 'exit', id: 'X', slots: 8 }, ...key },
      goal: { botsThrough: 1 },
      solution: [{}],
      ...extra,
    }),
  );
}

/** Every bot in the level, with nominal stats unless given. */
export function startWorld(level: Level, stats: Record<string, BotStats> = {}): World {
  const ids = Object.keys(level.spawns);
  return initWorld(level, Object.fromEntries(ids.map((id) => [id, stats[id] ?? NOMINAL_STATS])));
}

export interface Played {
  world: World;
  results: CommandResult[];
  events: WorldEvent[];
  outputs: ResolveOutput[];
}

/** Play rounds one after another. Each round maps bot ids to command queues. */
export function play(world: World, ...rounds: Record<string, string[]>[]): Played {
  const outputs: ResolveOutput[] = [];
  let w = world;
  for (const queues of rounds) {
    const out = resolvePhase(w, queues);
    outputs.push(out);
    w = out.world;
  }
  return {
    world: w,
    results: outputs.flatMap((o) => o.results),
    events: outputs.flatMap((o) => o.events),
    outputs,
  };
}

/** The highest a body's feet got during a round, from the trace. */
export function peakY(out: ResolveOutput, id: string): number {
  let peak = out.trace?.initial[id]?.[1] ?? 0;
  for (const f of out.trace?.frames ?? []) {
    const frame = f.bodies[id];
    if (frame) peak = Math.max(peak, frame[1]);
  }
  return peak;
}

export const bot = (world: World, id: string) => {
  const b = world.bots.find((x) => x.id === id);
  if (!b) throw new Error(`no bot ${id}`);
  return b;
};
