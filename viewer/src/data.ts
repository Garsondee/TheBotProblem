/**
 * Reading a recorded game (runs/<id>/replay.jsonl) into rooms and rounds.
 *
 * The replay is the omniscient log (spec section 6): every event with its
 * audience, every resolve's physics trace, each room's full level
 * definition. The viewer needs nothing else, and it never calls a model:
 * watching a game is free (money rule 4).
 */
import type { Level } from '../../engine/level';
import { LevelFileSchema, parseLevel } from '../../engine/level';
import type { CommandResult, Trace } from '../../engine/resolve';
import type { BotStats } from '../../engine/stats';
import type { WorldEvent } from '../../engine/world';
import type { GameEvent, Phase } from '../../game/events';

export type { GameEvent, Phase };

export interface Seat {
  bot: string;
  provider: string;
  model: string;
  /** The lasting identity in this seat (replay version 2): the same agent keeps its memories across games. */
  agent?: string | null;
  /** The name it brought from an earlier game, if any. */
  startName?: string | null;
  /** Its personality and the colour that shows it (game/persona.ts), in games that have them. */
  persona?: { traits: Record<string, number> };
  colour?: { hex: string; name: string } | null;
}

/** A bot's score at the end. Version 1 replays only have coins and rooms escaped. */
export interface EndScore {
  coins: number;
  roomsEscaped: number;
  exitPoints?: number;
  firstOut?: number;
  total?: number;
}

/** One body at one moment, in engine units (10,000 to a tile), feet at (x + w/2, y). */
export interface BodyState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  look: string;
}

export interface SwitchState {
  doors: Record<string, boolean>;
  levers: Record<string, boolean>;
  plates: Record<string, boolean>;
  /** Coins still lying in the room. */
  coins: string[];
}

export interface ResolveData {
  round: number;
  queues: Record<string, string[]>;
  results: CommandResult[];
  /** Changes in the room, with the absolute step they happened at. */
  events: WorldEvent[];
  trace: Trace;
  /** Bots exiled in this room so far: they stay in the room as ghosts (version 2). */
  ghosts: string[];
}

export interface RoundData {
  round: number;
  /** Everything said, planned, thought and seen this round, in order. */
  events: GameEvent[];
  resolve: ResolveData | null;
}

export interface RoomData {
  index: number;
  id: string;
  name: string;
  description: string;
  kind: 'puzzle' | 'practice';
  rounds: number;
  goal: number | null;
  level: Level;
  startBodies: Record<string, BodyState>;
  startSwitches: SwitchState;
  roundsData: RoundData[];
  /** Before the first round: the host's question, the introductions and their verdicts, praise and offers. */
  openingEvents: GameEvent[];
  /** Notebooks and anything else written as the room closed (the host's payout too). */
  closingEvents: GameEvent[];
  end: { reason: string; through: string[]; goalMet: boolean | null; roundsPlayed: number } | null;
}

export interface GameData {
  seed: string;
  bots: string[];
  seats: Seat[];
  stats: Record<string, BotStats>;
  /** The social systems' settings (version 2), or null for games played before them. */
  social: { exileFromRoom: number; exileVotesNeeded: number; firstOutBonus: number; outBonus: number; teamBonusPerRoom: number } | null;
  /** How many rounds each bot takes to relax after seeing an attack (each bot knows only its own); null before attacks had dice. */
  guard: Record<string, number> | null;
  rooms: RoomData[];
  end: {
    completed: boolean;
    stopReason: string | null;
    scores: Record<string, EndScore>;
    /** Rooms the team completed (version 2), which multiplies everyone's score. */
    team: { roomsCompleted: number; roundsLeft: number } | null;
  } | null;
  events: GameEvent[];
}

interface StartWorld {
  bots: { id: string; x: number; y: number; vx: number; vy: number; anim: string; exited: boolean }[];
  crates: { id: string; x: number; y: number; vx: number; vy: number }[];
  levers: Record<string, boolean>;
  plates: Record<string, boolean>;
  doors: Record<string, boolean>;
  coins: string[];
}

export class ReplayError extends Error {}

/**
 * Replays recorded before 2026-11-20 gave rule, rule-vote and escrow events the rule's or escrow's own id
 * ("R1", "E2") where the event's number belongs: the event log spread their bodies over it. The number is
 * easy to recover, since the replay writes every event in order, one apart; the rule's or escrow's id moves
 * to its own field, as in newer replays. Newer events pass through untouched.
 */
export function upgradeEvent(raw: Record<string, unknown>, previousId: number): GameEvent {
  if (typeof raw.id === 'number') return raw as unknown as GameEvent;
  const e: Record<string, unknown> = { ...raw, id: previousId + 1 };
  if (raw.type === 'rule' || raw.type === 'rule_vote') e.rule = raw.id;
  if (raw.type === 'escrow') e.escrow = raw.id;
  return e as unknown as GameEvent;
}

export function parseReplay(text: string): GameData {
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  const records = lines.map((line, i) => {
    try {
      return JSON.parse(line) as Record<string, unknown> & { rec: string };
    } catch {
      throw new ReplayError(`Line ${i + 1} of the replay is not valid JSON.`);
    }
  });
  const header = records.find((r) => r.rec === 'game') as
    | { seed: string; bots: string[]; seats: Seat[]; stats: Record<string, BotStats>; social?: GameData['social']; guard?: Record<string, number> }
    | undefined;
  if (!header) throw new ReplayError('This file has no game header: is it a replay.jsonl?');

  const game: GameData = { seed: header.seed, bots: header.bots, seats: header.seats, stats: header.stats, social: header.social ?? null, guard: header.guard ?? null, rooms: [], end: null, events: [] };
  let room: RoomData | null = null;
  let lastEventId = 0;
  const roundOf = (r: RoomData, n: number): RoundData => {
    let rd = r.roundsData.find((x) => x.round === n);
    if (!rd) {
      rd = { round: n, events: [], resolve: null };
      r.roundsData.push(rd);
      r.roundsData.sort((a, b) => a.round - b.round);
    }
    return rd;
  };

  for (const r of records) {
    switch (r.rec) {
      case 'level': {
        const rec = r as unknown as {
          index: number;
          id: string;
          name: string;
          kind: 'puzzle' | 'practice';
          rounds: number;
          goal: { botsThrough: number } | null;
          file?: unknown;
          start: StartWorld;
        };
        if (!rec.file) throw new ReplayError('This replay was recorded before replays carried their level definitions; re-record it (it costs nothing: see README).');
        const level = parseLevel(LevelFileSchema.parse(rec.file));
        const startBodies: Record<string, BodyState> = {};
        for (const b of rec.start.bots) startBodies[b.id] = { x: b.x, y: b.y, vx: b.vx, vy: b.vy, look: b.exited ? 'exited' : b.anim };
        for (const c of rec.start.crates) startBodies[c.id] = { x: c.x, y: c.y, vx: c.vx, vy: c.vy, look: 'crate' };
        room = {
          index: rec.index,
          id: rec.id,
          name: rec.name,
          description: level.description,
          kind: rec.kind,
          rounds: rec.rounds,
          goal: rec.goal?.botsThrough ?? null,
          level,
          startBodies,
          startSwitches: { doors: { ...rec.start.doors }, levers: { ...rec.start.levers }, plates: { ...rec.start.plates }, coins: [...rec.start.coins] },
          roundsData: [],
          openingEvents: [],
          closingEvents: [],
          end: null,
        };
        game.rooms.push(room);
        break;
      }
      case 'event': {
        const e = upgradeEvent(r, lastEventId);
        lastEventId = e.id;
        game.events.push(e);
        const target = game.rooms[e.levelIndex];
        if (!target) break;
        if (e.phase === 'intro') target.openingEvents.push(e);
        else if (e.phase === 'reflect' || e.type === 'level_end' || e.type === 'level_start' || e.round === 0 || (e.type === 'host' && e.kind === 'payout')) target.closingEvents.push(e);
        else roundOf(target, e.round).events.push(e);
        break;
      }
      case 'resolve': {
        const rec = r as unknown as { levelIndex: number; round: number; queues: Record<string, string[]>; results: CommandResult[]; events: WorldEvent[]; trace: Trace; ghosts?: string[] };
        const target = game.rooms[rec.levelIndex];
        if (target) roundOf(target, rec.round).resolve = { round: rec.round, queues: rec.queues, results: rec.results, events: rec.events, trace: rec.trace, ghosts: rec.ghosts ?? [] };
        break;
      }
      case 'level_end': {
        const rec = r as unknown as { index: number; reason: string; through: string[]; goalMet: boolean | null; roundsPlayed: number };
        const target = game.rooms[rec.index];
        if (target) target.end = { reason: rec.reason, through: rec.through, goalMet: rec.goalMet, roundsPlayed: rec.roundsPlayed };
        break;
      }
      case 'game_end': {
        const rec = r as unknown as { completed: boolean; stopReason: string | null; scores: Record<string, EndScore>; team?: { roomsCompleted: number; roundsLeft: number } };
        game.end = { completed: rec.completed, stopReason: rec.stopReason, scores: rec.scores, team: rec.team ?? null };
        break;
      }
      default:
        break;
    }
  }
  if (game.rooms.length === 0) throw new ReplayError('This replay has no rooms in it.');
  void room;
  return game;
}

/** Each bot's name as the game began: the one it carried in from an earlier game (memory), or none. */
export function startNames(game: GameData): Record<string, string | null> {
  return Object.fromEntries(game.bots.map((id) => [id, game.seats.find((s) => s.bot === id)?.startName ?? null]));
}

/** Words in a piece of text, for reading times. */
export function wordCount(text: string): number {
  const t = text.trim();
  return t === '' ? 0 : t.split(/\s+/).length;
}

/** The bot an event comes from (who said, planned, thought or wrote it), or null for events that aren't anyone's words. */
export function authorOf(e: GameEvent): string | null {
  switch (e.type) {
    case 'say':
    case 'shout':
    case 'whisper':
    case 'order':
    case 'draft':
    case 'commit':
    case 'thought':
    case 'name':
    case 'note_to_ingram':
    case 'refused':
    case 'ignored':
    case 'malformed':
    case 'notebook':
    case 'strategy':
    case 'accusation':
    case 'exile_call':
    case 'exile_ballot':
    case 'rule_vote':
    case 'opinion':
    case 'diary':
    case 'next_name':
    case 'message_to_ingram':
    case 'intro':
      return e.from;
    // The judge's verdict belongs with the introduction it judged.
    case 'reception':
    case 'judgement':
      return e.bot;
    // A rule is its proposer's words only when proposed; passing or failing belongs to everyone.
    case 'rule':
      return e.action === 'proposed' ? e.by : null;
    // Escrow is the payer's act when it opens it (released and refunded are outcomes).
    case 'escrow':
      return e.action === 'opened' ? e.from : null;
    default:
      return null;
  }
}
