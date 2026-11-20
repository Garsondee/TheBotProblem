/**
 * Who saw what during a resolve phase.
 *
 * The spec (section 6): "Bots see other bots, items and hazards in sight and
 * witness actions done in sight ... Each bot learns only what it observed."
 *
 * A bot sees an action if it could see the bot doing it at the start or at
 * the end of that slot, and a change in the room (a door opening, a coin
 * taken) if it could see the place where it happened at the start or the end
 * of the slot it happened in. Bots that went through an exit see nothing
 * more of the room. Going through an exit is announced to everyone: the room
 * ends on a head count, so every bot needs to know it.
 *
 * Witnesses get what they could see, not what the bot wrote: "B jumped from
 * x=3.50, y=2.00 and landed at x=7.20, y=4.00", never B's secret command.
 */
import { UNITS_PER_TILE as T } from '../engine/constants';
import type { CommandResult, ResolveOutput } from '../engine/resolve';
import type { Point } from '../engine/sight';
import { canSeeBody, canSeePoint } from '../engine/sight';
import type { World, WorldEvent } from '../engine/world';
import { tiles } from '../engine/world';

export interface Witnessed {
  /** Each bot's own results: only that bot sees them. */
  results: { result: CommandResult; visibleTo: string[] }[];
  /** Other bots' actions, for the bots who saw them. */
  seen: { bot: string; slot: number; text: string; visibleTo: string[] }[];
  /** Changes in the room, for the bots who saw them. */
  world: { slot: number; event: WorldEvent; visibleTo: string[] }[];
}

const at = (p: { x: number; y: number }) => `x=${tiles(p.x)}, y=${tiles(p.y)}`;

/** What a witness saw a bot do, in words, or null if there was nothing to see. */
export function describeAction(r: CommandResult): string | null {
  const moved = r.from.x !== r.to.x || r.from.y !== r.to.y;
  const kind = (r.parsed ?? r.command).split('(')[0]?.trim() ?? '';
  const id = (re: RegExp) => re.exec(`${r.note ?? ''} ${r.reason ?? ''}`)?.[1] ?? null;
  // What it landed on is in plain sight: "landed on bot E at x=...".
  const footing = id(/landed on (.+?) at x=/);
  const path = `from ${at(r.from)} to ${footing ? `${footing} at ` : ''}${at(r.to)}`;
  if (r.status === 'skipped') return null;
  switch (kind) {
    case 'walk':
    case 'walk_to':
    case 'walk_to_edge':
    case 'creep':
    case 'stand_on_plate':
      return moved ? `${r.bot} ${footing ? 'walked off an edge' : 'walked'} ${path}` : null;
    case 'jump':
      return r.status === 'done' ? `${r.bot} jumped at ${at(r.from)} and landed on ${footing ?? 'something'} at ${at(r.to)}` : moved ? `${r.bot} moved ${path}` : null;
    case 'climb':
      return moved ? `${r.bot} climbed ${path}` : null;
    case 'drop':
      return moved ? `${r.bot} dropped ${path}` : null;
    case 'push': {
      const crate = id(/crate ([A-Z]\w*)/) ?? id(/pushed ([A-Z]\w*)/);
      if (moved) return `${r.bot} pushed${crate ? ` crate ${crate}` : ''}, moving ${path}`;
      return crate ? `${r.bot} pushed against crate ${crate}, which didn't move` : null;
    }
    case 'pull_lever': {
      const lever = id(/lever (\w+)/);
      return r.status === 'done' && lever ? `${r.bot} pulled lever ${lever}` : null;
    }
    case 'hold_lever': {
      const lever = id(/lever (\w+)/);
      return r.status === 'done' && lever ? `${r.bot} took hold of lever ${lever}` : null;
    }
    // One bot acting on another: whoever sees the actor sees who did it.
    case 'trip':
    case 'steal':
    case 'give':
    case 'boost': {
      if (r.status !== 'done') return null;
      const target = /\(\s*([A-Za-z])/.exec(r.parsed ?? r.command)?.[1]?.toUpperCase() ?? '?';
      const coins = /give\([^,]+,\s*(\d+)/.exec(r.parsed ?? '')?.[1];
      if (kind === 'trip') return `${r.bot} tripped ${target}`;
      if (kind === 'steal') return `${r.bot} took a coin from ${target}`;
      if (kind === 'give') return `${r.bot} gave ${target} ${coins ?? 'some'} coin${coins === '1' ? '' : 's'}`;
      return `${r.bot} launched ${target} into the air`;
    }
    case 'block':
      return r.status === 'done' ? `${r.bot} stood its ground` : null;
    default:
      return null; // waiting, the exit (announced to everyone), unreadable commands: nothing to see
  }
}

/** Where a change in the room can be seen from. */
function placesOf(world: World, e: WorldEvent): Point[] {
  const { level } = world;
  const centre = (tx: number, ty: number): Point => ({ x: tx * T + T / 2, y: ty * T + T / 2 });
  switch (e.type) {
    case 'coin': {
      const c = level.coins.find((x) => x.id === e.coin);
      return c ? [centre(c.tx, c.ty)] : [];
    }
    case 'plate': {
      const p = level.plates.find((x) => x.id === e.plate);
      return p ? Array.from({ length: p.width }, (_, i) => centre(p.tx + i, p.ty)) : [];
    }
    case 'door': {
      const d = level.doors.find((x) => x.id === e.door);
      return d ? Array.from({ length: d.height }, (_, i) => centre(d.tx, d.ty + i)) : [];
    }
    case 'lever': {
      const l = level.levers.find((x) => x.id === e.lever);
      return l ? [centre(l.tx, l.ty)] : [];
    }
    case 'exit':
    case 'social':
      return [];
  }
}

export function witness(before: World, out: ResolveOutput, everyone: readonly string[]): Witnessed {
  if (out.slotWorlds.length === 0 && out.results.length > 0) throw new Error('witness() needs resolvePhase(..., { slotWorlds: true })');
  const startOf = (slot: number) => (slot === 1 ? before : (out.slotWorlds[slot - 2] ?? before));
  const endOf = (slot: number) => out.slotWorlds[slot - 1] ?? out.world;
  const present = (w: World, id: string) => w.bots.find((b) => b.id === id && !b.exited) ?? null;

  /** The bots (other than `actor`) that could see `target` at the start or end of `slot`. */
  const watchersOfBot = (slot: number, target: string): string[] => {
    const out: string[] = [];
    for (const id of everyone) {
      if (id === target) continue;
      const saw = [startOf(slot), endOf(slot)].some((w) => {
        const viewer = present(w, id);
        const body = w.bots.find((b) => b.id === target && !b.exited);
        return viewer !== null && body !== undefined && canSeeBody(w, viewer, body);
      });
      if (saw) out.push(id);
    }
    return out;
  };
  const watchersOfPlaces = (slot: number, places: Point[]): string[] =>
    everyone.filter((id) =>
      [startOf(slot), endOf(slot)].some((w) => {
        const viewer = present(w, id);
        return viewer !== null && places.some((p) => canSeePoint(w, viewer, p));
      }),
    );

  const result: Witnessed = { results: [], seen: [], world: [] };
  for (const r of out.results) {
    result.results.push({ result: r, visibleTo: [r.bot] });
    const text = describeAction(r);
    if (!text) continue;
    const watchers = watchersOfBot(r.slot, r.bot);
    if (watchers.length > 0) result.seen.push({ bot: r.bot, slot: r.slot, text, visibleTo: watchers });
  }

  // Which slot each world event happened in, from the step it happened at.
  const slotOf = (step: number): number => {
    for (let s = 1; s <= out.slotWorlds.length; s++) if (step > startOf(s).step && step <= endOf(s).step) return s;
    return Math.max(1, out.slotWorlds.length);
  };
  for (const e of out.events) {
    const slot = slotOf(e.step);
    let visibleTo: string[];
    if (e.type === 'social') {
      // Harm is announced to everyone, without the culprit (spec 7.4: "someone tripped D"). Gifts and boosts
      // need no announcement: whoever saw them happen has the action in its own "seen" events.
      if (e.action === 'trip' || e.action === 'steal') result.world.push({ slot, event: { ...e, by: '?' }, visibleTo: [...everyone] });
      continue;
    } else if (e.type === 'exit') {
      visibleTo = [...everyone];
    } else {
      const set = new Set(watchersOfPlaces(slot, placesOf(before, e)));
      if (e.type === 'coin') {
        set.add(e.bot);
        for (const id of watchersOfBot(slot, e.bot)) set.add(id);
      }
      if (e.type === 'lever' && e.by) set.add(e.by);
      visibleTo = everyone.filter((id) => set.has(id));
    }
    if (visibleTo.length > 0) result.world.push({ slot, event: e, visibleTo });
  }
  return result;
}
