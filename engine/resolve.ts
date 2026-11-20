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
import type { Command } from './commands';
import { formatCommand, parseCommand } from './commands';
import { overlaps } from './collision';
import type { Controller } from './controllers';
import { planSwaps, startController } from './controllers';
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
  /**
   * The order bots act in: within each slot their commands start in this order, and in each step the one
   * first in it wins whatever two bots reach at once (a coin, a place in the exit, a gap, a lever, a shove
   * before the other's command starts). Missing: the world's own order, which is by letter. The game passes
   * its turn order here (game/order.ts); the bots are never told what it is.
   */
  order?: readonly string[];
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

/** Two bots in one place (only a swap cut short does this): the upper one is set on the other's head. */
function separateOverlaps(world: World): void {
  const bots = world.bots.filter((b) => !b.exited);
  for (const a of bots) {
    for (const b of bots) {
      if (a.id >= b.id || !overlaps(a, b)) continue;
      const [top, under] = a.y >= b.y ? [a, b] : [b, a];
      top.y = under.y + under.h;
      top.vy = 0;
    }
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
  // Every loop in the engine goes through world.bots in order, so sorting this copy is what makes the
  // turn order hold everywhere at once (a stable sort: bots the order doesn't name keep their places, last).
  if (options.order) {
    const rank = (id: string) => {
      const i = options.order?.indexOf(id) ?? -1;
      return i < 0 ? Number.MAX_SAFE_INTEGER : i;
    };
    world.bots.sort((a, b) => rank(a.id) - rank(b.id));
  }
  const recorder = options.trace === false ? null : new TraceRecorder(world);
  const maxSteps = options.maxSlotSteps ?? MAX_SLOT_STEPS;
  const results: CommandResult[] = [];
  const events: WorldEvent[] = [];
  const slotWorlds: World[] = [];
  const stopped = new Set<string>();

  for (let slot = 1; slot <= MAX_SLOTS; slot++) {
    const running: { c: Controller; text: string; from: { x: number; y: number }; startStep: number }[] = [];
    let anyCommand = false;
    // Trips already pending when this slot starts cost a slot now. A trip made during this slot costs the
    // target its NEXT slot, whichever bot happens to be handled first: all of a slot's commands start together.
    const trippedNow = new Set(world.bots.filter((b) => b.tripped).map((b) => b.id));
    const usedTrip = new Set<string>();
    // Swaps need both bots' commands for this slot, so they are paired before anything starts.
    const runnable = new Map<string, Command>();
    for (const bot of world.bots) {
      const text = queues[bot.id]?.[slot - 1];
      if (text === undefined || bot.exited || stopped.has(bot.id) || trippedNow.has(bot.id)) continue;
      const parsed = parseCommand(text);
      if (parsed.ok) runnable.set(bot.id, parsed.command);
    }
    const swaps = planSwaps(world, runnable);
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
      if (trippedNow.has(bot.id)) {
        // A trip costs exactly one slot; the rest of the queue still runs.
        usedTrip.add(bot.id);
        results.push({ ...base, parsed: null, status: 'skipped', reason: 'you were tripped, and lost this slot' });
        continue;
      }
      const parsed = parseCommand(text);
      if (!parsed.ok) {
        results.push({ ...base, parsed: null, status: 'failed', reason: parsed.reason });
        stopped.add(bot.id);
        continue;
      }
      // Shoved by a bot the engine handled first in this slot: this command never gets going, for that reason
      // (handled the other way round, the step loop below ends it the same way).
      if (bot.interrupt) {
        results.push({ ...base, parsed: formatCommand(parsed.command), status: 'failed', reason: bot.interrupt });
        stopped.add(bot.id);
        bot.interrupt = null;
        continue;
      }
      // A toggle lever flips the moment it is pulled, inside startController, so the step
      // loop below never sees it change: record the flip here, at this slot's first step.
      const leversBefore = parsed.command.kind === 'pull_lever' ? { ...world.levers } : null;
      const swap = swaps.get(bot.id);
      const c = startController(world, bot, parsed.command, swap ? { swap } : undefined);
      if (leversBefore) {
        for (const [id, on] of Object.entries(world.levers)) {
          if (leversBefore[id] !== on) events.push({ step: world.step + 1, type: 'lever', lever: id, on, by: bot.id });
        }
      }
      // Trips, thefts, gifts and boosts happen the moment they start: log them at this slot's first step.
      for (const e of c.events) events.push({ ...e, step: world.step + 1 });
      running.push({ c, text, from: base.from, startStep: world.step });
    }
    // A trip that cost a slot is used up, unless the bot was tripped again during this slot.
    const renewed = new Set(running.flatMap(({ c }) => c.events.filter((e) => e.type === 'social' && e.action === 'trip').map((e) => (e.type === 'social' ? e.target : ''))));
    for (const b of world.bots) if (usedTrip.has(b.id) && !renewed.has(b.id)) b.tripped = false;
    if (!anyCommand) break;

    // Step until every command is settled and everything has stopped moving.
    // At least one step, so instant commands (a lever, the exit) take effect.
    const slotStart = world.step;
    let steps = 0;
    for (;;) {
      // Something done to a bot mid-command (a shove) ends that command, with the reason it is told. All of a
      // slot's commands have started by now, so this is the same whichever bot the engine handled first.
      for (const { c } of running) {
        const b = world.bots.find((x) => x.id === c.botId);
        if (b?.interrupt && (c.status === 'running' || c.status === 'holding')) {
          c.status = 'failed';
          c.reason = b.interrupt;
        }
      }
      for (const b of world.bots) b.interrupt = null;
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
    // Passing through ends with the slot. A swap cut short (something blocked the walker) can leave the two
    // in one place: the upper one is then standing on the other's head, which the physics can carry on from.
    for (const b of world.bots) b.passThrough = null;
    separateOverlaps(world);

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

  // Being pushed past slows a bot for the rest of the round, and no longer.
  for (const b of world.bots) b.slowed = false;
  results.sort((a, b) => a.slot - b.slot || (a.bot < b.bot ? -1 : a.bot > b.bot ? 1 : 0));
  return { world, results, events, trace: recorder ? recorder.finish(world) : null, slotWorlds };
}
