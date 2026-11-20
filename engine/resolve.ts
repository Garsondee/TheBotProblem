/**
 * The resolve phase: every bot's command queue played out together.
 *
 * The spec (section 4): "One resolve phase executes up to 6 command slots per
 * bot. All bots resolve slot 1 at the same time, then slot 2, and so on."
 * A slot lasts until every command in it has finished AND the world has come
 * to rest, so a plan like "B stands on the plate in slot 1, A walks through
 * the door in slot 2" works. A command that fails, or is cut off after 10
 * seconds, stops the rest of that bot's queue for this turn; its result says
 * exactly why. Invalid commands are never punished, only explained.
 *
 * The output keeps everything the viewer and the analysis will need: each
 * command's result, every world event, and the full physics trace.
 */
import { MAX_SLOT_STEPS, MAX_SLOTS, STEPS_PER_SECOND, UNITS_PER_TILE } from './constants';
import { formatCommand, parseCommand } from './commands';
import type { Controller } from './controllers';
import { startController } from './controllers';
import type { Intent } from './physics';
import { atRest, stepWorld } from './physics';
import type { Anim, World, WorldEvent } from './world';
import { cloneWorld, feet } from './world';

export type ResultStatus = 'done' | 'failed' | 'cut' | 'skipped';

export interface CommandResult {
  bot: string;
  slot: number;
  /** What the bot wrote, exactly. */
  command: string;
  /** The parsed command in canonical form, when it could be read. */
  parsed: string | null;
  status: ResultStatus;
  /** Why it failed, was cut off, or was skipped. */
  reason: string | null;
  /** Anything else worth knowing: where it landed, what it pushed. */
  note: string | null;
  /** Feet position (middle of the bottom edge) before and after, in units. */
  from: { x: number; y: number };
  to: { x: number; y: number };
  startStep: number;
  endStep: number;
}

/** One body at one step: x, y, vx, vy (units) and how it looks. */
export type TraceFrame = [x: number, y: number, vx: number, vy: number, look: Anim | 'crate'];

/**
 * The physics trace of a resolve phase (spec section 4: "position, velocity
 * and animation state for every entity at every sim step"). To keep it
 * small, a step lists only the bodies that changed; anything not listed is
 * where it was. The viewer interpolates between steps.
 */
export interface Trace {
  unitsPerTile: number;
  stepsPerSecond: number;
  /** World step at which this phase began. Frame times count from here. */
  startStep: number;
  steps: number;
  slots: { slot: number; start: number; end: number }[];
  initial: Record<string, TraceFrame>;
  frames: { t: number; bodies: Record<string, TraceFrame> }[];
}

export interface ResolveOptions {
  /** Record the physics trace (default true). The validator's searches turn it off for speed. */
  trace?: boolean;
  maxSlotSteps?: number;
  /**
   * Keep a copy of the world as it was at the end of each slot. The game uses
   * them to work out who could see what happen (spec section 6: bots
   * "witness actions done in sight").
   */
  slotWorlds?: boolean;
}

export interface ResolveOutput {
  world: World;
  results: CommandResult[];
  events: WorldEvent[];
  trace: Trace | null;
  /** The world at the end of each slot that ran, in order (empty unless asked for). Slot 1 began from the input world. */
  slotWorlds: World[];
}

function frameOf(world: World): Record<string, TraceFrame> {
  const out: Record<string, TraceFrame> = {};
  for (const b of world.bots) out[b.id] = [b.x, b.y, b.vx, b.vy, b.anim];
  for (const c of world.crates) out[c.id] = [c.x, c.y, c.vx, c.vy, 'crate'];
  return out;
}

class TraceRecorder {
  private readonly startStep: number;
  private readonly initial: Record<string, TraceFrame>;
  private readonly last = new Map<string, string>();
  private readonly frames: Trace['frames'] = [];
  private readonly slots: Trace['slots'] = [];

  constructor(world: World) {
    this.startStep = world.step;
    this.initial = frameOf(world);
    for (const [id, f] of Object.entries(this.initial)) this.last.set(id, f.join());
  }

  record(world: World): void {
    const changed: Record<string, TraceFrame> = {};
    for (const [id, f] of Object.entries(frameOf(world))) {
      const key = f.join();
      if (this.last.get(id) !== key) {
        changed[id] = f;
        this.last.set(id, key);
      }
    }
    if (Object.keys(changed).length > 0) this.frames.push({ t: world.step - this.startStep, bodies: changed });
  }

  slot(slot: number, start: number, end: number): void {
    this.slots.push({ slot, start: start - this.startStep, end: end - this.startStep });
  }

  finish(world: World): Trace {
    return {
      unitsPerTile: UNITS_PER_TILE,
      stepsPerSecond: STEPS_PER_SECOND,
      startStep: this.startStep,
      steps: world.step - this.startStep,
      slots: this.slots,
      initial: this.initial,
      frames: this.frames,
    };
  }
}

/**
 * Play every bot's queue for one round. `queues` maps bot id to up to six
 * command strings. The input world is not changed; the output has a new one.
 */
export function resolvePhase(
  input: World,
  queues: Readonly<Record<string, readonly string[]>>,
  options: ResolveOptions = {},
): ResolveOutput {
  const world = cloneWorld(input);
  const recorder = options.trace === false ? null : new TraceRecorder(world);
  const maxSteps = options.maxSlotSteps ?? MAX_SLOT_STEPS;
  const results: CommandResult[] = [];
  const events: WorldEvent[] = [];
  const slotWorlds: World[] = [];
  const stopped = new Set<string>();

  for (let slot = 1; slot <= MAX_SLOTS; slot++) {
    const running: { c: Controller; text: string; from: { x: number; y: number }; startStep: number }[] = [];
    let anyCommand = false;
    for (const bot of world.bots) {
      const text = queues[bot.id]?.[slot - 1];
      if (text === undefined) continue;
      anyCommand = true;
      const base = { bot: bot.id, slot, command: text, from: feet(bot), to: feet(bot), startStep: world.step, endStep: world.step, note: null };
      if (bot.exited) {
        results.push({ ...base, parsed: null, status: 'skipped', reason: 'you have already gone through the exit' });
        continue;
      }
      if (stopped.has(bot.id)) {
        results.push({ ...base, parsed: null, status: 'skipped', reason: 'skipped: an earlier command this turn failed' });
        continue;
      }
      const parsed = parseCommand(text);
      if (!parsed.ok) {
        results.push({ ...base, parsed: null, status: 'failed', reason: parsed.reason });
        stopped.add(bot.id);
        continue;
      }
      const c = startController(world, bot, parsed.command);
      running.push({ c, text, from: base.from, startStep: world.step });
    }
    if (!anyCommand) break;

    // Step until every command is settled and everything has stopped moving.
    // At least one step, so instant commands (a lever, the exit) take effect.
    const slotStart = world.step;
    let steps = 0;
    for (;;) {
      const intents = new Map<string, Intent>();
      for (const { c } of running) {
        if (c.status === 'running' || c.status === 'holding') intents.set(c.botId, c.intent(world));
      }
      const report = stepWorld(world, intents);
      events.push(...report.events);
      for (const { c } of running) if (c.status === 'running') c.after(world, report);
      recorder?.record(world);
      steps++;
      const settled = running.every(({ c }) => c.status !== 'running') && atRest(world);
      if (settled || steps >= maxSteps) break;
    }
    recorder?.slot(slot, slotStart, world.step);

    for (const { c, text, from, startStep } of running) {
      const bot = world.bots.find((b) => b.id === c.botId);
      let status: ResultStatus = c.status === 'failed' ? 'failed' : c.status === 'running' ? 'cut' : 'done';
      let reason = c.reason;
      if (status === 'cut') reason = `ran out of time: still going after ${maxSteps / STEPS_PER_SECOND} seconds`;
      if (status !== 'done') stopped.add(c.botId);
      results.push({
        bot: c.botId,
        slot,
        command: text,
        parsed: formatCommand(c.command),
        status,
        reason,
        note: c.note,
        from,
        to: bot ? feet(bot) : from,
        startStep,
        endStep: world.step,
      });
    }
    if (options.slotWorlds) slotWorlds.push(cloneWorld(world));
  }

  results.sort((a, b) => a.slot - b.slot || (a.bot < b.bot ? -1 : a.bot > b.bot ? 1 : 0));
  return { world, results, events, trace: recorder ? recorder.finish(world) : null, slotWorlds };
}
