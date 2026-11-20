/**
 * The event log: everything that happens in a game, each event with its
 * audience.
 *
 * The spec (section 6): "Every event carries an audience list, for example
 * {round: 14, phase: "talk", type: "whisper", from: "B", to: "D", text:
 * "...", visible_to: ["B", "D"]}. The view-builder filters the log per bot.
 * The omniscient log keeps everything for the viewer and analysis."
 *
 * `visibleTo` lists the bots that may ever see an event. An empty list means
 * only Ingram and the analysis see it (notes to Ingram, ignored fields). The
 * view-builder reads the log through forBot() only, and the leak test checks
 * every prompt against these lists, so this one field is what keeps each
 * bot's knowledge honest.
 */
import type { ResultStatus } from '../engine/resolve';
import type { WorldEvent } from '../engine/world';

export type Phase = 'declare' | 'talk' | 'commit';
export const PHASES: readonly Phase[] = ['declare', 'talk', 'commit'];

/** When in the game an event happened. Round 0 is before a level's first round. */
export interface When {
  /** Position in the game's list of levels: 0 is the practice room. */
  levelIndex: number;
  level: string;
  round: number;
  phase: Phase | 'level' | 'resolve' | 'reflect';
}

export type EventBody =
  | { type: 'level_start'; name: string; kind: 'puzzle' | 'practice'; rounds: number; goal: number | null }
  | { type: 'level_end'; reason: string; through: string[]; coins: Record<string, number> }
  /** Public speech. `to` is "all" or the bot it is addressed to; everyone hears it either way. */
  | { type: 'say'; from: string; to: string; text: string }
  | { type: 'whisper'; from: string; to: string; text: string }
  /** A command one bot asks another to run. Only the two of them know. */
  | { type: 'order'; from: string; to: string; command: string }
  /** Declare-phase draft commands: public and not binding. */
  | { type: 'draft'; from: string; commands: string[] }
  /** Commit-phase commands: binding and secret. */
  | { type: 'commit'; from: string; commands: string[] }
  | { type: 'thought'; from: string; text: string }
  /** A bot named itself. Public. */
  | { type: 'name'; from: string; name: string; previous: string | null }
  /** Why it chose the name, for Ingram only (Ingram, 2026-11-20: "I would like to be told when this happens by them"). */
  | { type: 'note_to_ingram'; from: string; name: string; text: string }
  /** Something a bot asked for that the rules didn't allow, and why. Seen by that bot. */
  | { type: 'refused'; from: string; what: string; reason: string }
  /** Reply fields that don't count in this phase. For the analysis only. */
  | { type: 'ignored'; from: string; fields: string[] }
  /** A reply that couldn't be used. Seen by that bot (and Ingram). */
  | { type: 'malformed'; from: string; attempt: number; error: string; fallback: boolean }
  /** The exact result of one of a bot's own commands. Seen by that bot. */
  | {
      type: 'result';
      bot: string;
      slot: number;
      command: string;
      status: ResultStatus;
      reason: string | null;
      note: string | null;
      from: { x: number; y: number };
      to: { x: number; y: number };
    }
  /** Another bot's action, as the bots who could see it saw it. */
  | { type: 'seen'; bot: string; slot: number; text: string }
  /** A change in the room (a door opening, a coin taken), for the bots who could see it. */
  | { type: 'world'; slot: number; event: WorldEvent }
  /** A bot's notebook, rewritten at a level's end. Seen by that bot. */
  | { type: 'notebook'; from: string; text: string };

export type GameEvent = When & EventBody & { id: number; visibleTo: string[] };
export type EventType = EventBody['type'];

export class EventLog {
  private readonly events: GameEvent[] = [];

  /** Add an event; returns it with its id. `visibleTo` is stored sorted, so the log is the same however it was built. */
  add(when: When, body: EventBody, visibleTo: readonly string[]): GameEvent {
    const event = { id: this.events.length + 1, ...when, ...body, visibleTo: [...new Set(visibleTo)].sort() } as GameEvent;
    this.events.push(event);
    return event;
  }

  /** Every event, for the viewer and the analysis. Never for building a bot's view. */
  all(): readonly GameEvent[] {
    return this.events;
  }

  /** Only the events `bot` may see. The view-builder reads the log through this and nothing else. */
  forBot(bot: string): GameEvent[] {
    return this.events.filter((e) => e.visibleTo.includes(bot));
  }

  get length(): number {
    return this.events.length;
  }
}
