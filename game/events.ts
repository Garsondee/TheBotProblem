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
  | { type: 'notebook'; from: string; text: string }
  /** Its strategy paragraph (spec 7.9), rewritten at a level's end. Seen by that bot. */
  | { type: 'strategy'; from: string; text: string }
  // ---- The constitution (spec 7.1): proposals, votes and outcomes are public.
  | { type: 'rule'; action: 'proposed' | 'passed' | 'failed'; id: string; kind: 'rule' | 'repeal' | 'threshold'; text: string; by: string; yes: number; no: number; needed: number }
  | { type: 'rule_vote'; from: string; id: string; value: 'yes' | 'no' }
  // ---- Justice (spec 7.3).
  /** Public. `witnessed`: the accuser's own log shows it saw the accused act in this room (not that the claim is true). */
  | { type: 'accusation'; from: string; target: string; claim: string; witnessed: boolean }
  | { type: 'exile_call'; from: string; target: string }
  /** A ballot: secret, seen only by the voter. */
  | { type: 'exile_ballot'; from: string; target: string; value: 'yes' | 'no' }
  /** The count, public: who called it and whether it passed, never who voted how. */
  | { type: 'exile_result'; target: string; by: string; yes: number; no: number; needed: number; passed: boolean }
  // ---- Trade (spec 7.4): coins held by the engine against a promise. Seen by the two bots.
  | { type: 'escrow'; action: 'opened' | 'released' | 'refunded'; id: string; from: string; to: string; coins: number; terms: string }
  // ---- Orders and obedience (spec 7.2).
  /** Seen by the bot that got the order, and by the one that gave it if it saw what happened. */
  | { type: 'obedience'; from: string; to: string; command: string; verdict: 'obeyed' | 'partly' | 'ignored' | 'unable' }
  /** What a bot declared against what it committed. For the analysis only. */
  | { type: 'gap'; from: string; planned: string[]; committed: string[]; kept: boolean }
  /** A bot's trust in another (spec 7.9), updated at commit. Seen by that bot. */
  | { type: 'opinion'; from: string; about: string; trust: number; note: string }
  // ---- For Ingram and the Director only.
  /** The diary room (spec 7.10): what a bot really thinks, at each level's end. */
  | { type: 'diary'; from: string; text: string }
  /** A name chosen privately at the end of a game, for the next one. */
  | { type: 'next_name'; from: string; name: string; note: string }
  /** A bot's message to Ingram at the end of the game (spec 7.10). */
  | { type: 'message_to_ingram'; from: string; text: string }
  /** The scoreboard at a level's end. Public. */
  | { type: 'scores'; scores: Record<string, { coins: number; exitPoints: number; total: number }>; roomsCompleted: number };

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
