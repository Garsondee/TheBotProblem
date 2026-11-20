/**
 * The script: a recorded game turned into a timeline of beats.
 *
 * A game's events happen in phases, not in time, so the viewer decides how
 * long each thing takes on screen. The rules aim at one thing (Ingram,
 * 2026-11-20: "making conversations and thoughts easy to follow and
 * understand who is talking"):
 *   - one bot speaks at a time, and stays on screen long enough to read
 *     (reading time grows with the words)
 *   - each phase opens with a short title, so you always know whether you
 *     are watching plans (declare), talk, or secret commitments
 *   - the physics plays in real time: a second on screen is a second in the
 *     world
 * Times are seconds at 1x speed; the player scales them.
 */
import type { GameData, GameEvent, Phase, ResolveData } from './data';
import { authorOf, wordCount } from './data';

export type ThoughtMode = 'off' | 'commit' | 'all';

export interface ScriptOptions {
  /** Which private thoughts get their own time on screen. */
  thoughts: ThoughtMode;
}

/** "announce": a public outcome everyone learns at once (a rule passing, an exile vote's count). */
export type BeatKind = 'room-intro' | 'phase' | 'turn' | 'commit-all' | 'announce' | 'resolve' | 'room-end' | 'game-end';

export interface Beat {
  index: number;
  kind: BeatKind;
  room: number;
  round: number;
  phase: Phase | null;
  bot: string | null;
  /** What this beat shows: a bot's messages, plan and thought; or everyone's commits. */
  events: GameEvent[];
  resolve: ResolveData | null;
  start: number;
  dur: number;
}

export interface Script {
  beats: Beat[];
  total: number;
}

/** Seconds on screen. Tuned by watching: long enough to read at 1x, quick at 2x. */
export const TIMING = {
  roomIntro: 4.2,
  announce: 3.6,
  roomEnd: 4.2,
  gameEnd: 6,
  phaseTitle: 1.0,
  commitAll: 2.4,
  resolveTail: 0.9,
  turnBase: 1.0,
  perWord: 0.27,
  perThoughtWord: 0.2,
  turnMin: 1.8,
  turnMax: 16,
} as const;

/** Event types a turn can show, in the order they belong on screen. */
const TURN_TYPES = new Set(['name', 'note_to_ingram', 'say', 'whisper', 'order', 'accusation', 'exile_call', 'rule', 'rule_vote', 'escrow', 'draft', 'commit', 'exile_ballot', 'thought', 'refused', 'malformed']);

/** Outcomes announced to everyone, each with a beat of its own after the phase it closes. */
const ANNOUNCED = (e: GameEvent) => (e.type === 'rule' && e.action !== 'proposed') || e.type === 'exile_result';

function turnSeconds(events: readonly GameEvent[], showThought: boolean): number {
  let words = 0;
  for (const e of events) {
    switch (e.type) {
      case 'say':
      case 'whisper':
        words += wordCount(e.text);
        break;
      case 'order':
        words += 2 + wordCount(e.command) * 0.6;
        break;
      case 'draft':
      case 'commit':
        words += Math.min(8, e.commands.length * 1.4);
        break;
      case 'name':
        words += 3;
        break;
      case 'note_to_ingram':
        words += wordCount(e.text);
        break;
      case 'accusation':
        words += 3 + wordCount(e.claim);
        break;
      case 'exile_call':
        words += 5;
        break;
      case 'rule':
        words += 3 + wordCount(e.text);
        break;
      case 'escrow':
        words += 4 + wordCount(e.terms);
        break;
      case 'rule_vote':
      case 'exile_ballot':
        words += 3;
        break;
      case 'thought':
        if (showThought) words += wordCount(e.text) * (TIMING.perThoughtWord / TIMING.perWord);
        break;
      default:
        break;
    }
  }
  return Math.min(TIMING.turnMax, Math.max(TIMING.turnMin, TIMING.turnBase + words * TIMING.perWord));
}

/** Does this bot have something worth a turn of its own in this phase? */
function worthATurn(events: readonly GameEvent[], phase: Phase, thoughts: ThoughtMode): boolean {
  const spoken = events.some((e) => ['say', 'whisper', 'order', 'name', 'accusation', 'exile_call', 'rule', 'rule_vote', 'escrow'].includes(e.type));
  if (phase === 'declare') return spoken || events.some((e) => e.type === 'draft') || (thoughts === 'all' && events.some((e) => e.type === 'thought'));
  if (phase === 'talk') return spoken || (thoughts === 'all' && events.some((e) => e.type === 'thought'));
  return spoken || (thoughts !== 'off' && events.some((e) => e.type === 'thought' || e.type === 'commit' || e.type === 'exile_ballot'));
}

export function buildScript(game: GameData, options: ScriptOptions): Script {
  const beats: Beat[] = [];
  let t = 0;
  const push = (b: Omit<Beat, 'index' | 'start'>) => {
    beats.push({ ...b, index: beats.length, start: t });
    t += b.dur;
  };
  for (const room of game.rooms) {
    push({ kind: 'room-intro', room: room.index, round: 0, phase: null, bot: null, events: [], resolve: null, dur: TIMING.roomIntro });
    for (const rd of room.roundsData) {
      for (const phase of ['declare', 'talk', 'commit'] as const) {
        const inPhase = rd.events.filter((e) => e.phase === phase && TURN_TYPES.has(e.type));
        const bots = [...new Set(inPhase.map(authorOf).filter((b): b is string => b !== null))].sort();
        const turns = bots
          .map((bot) => ({ bot, events: inPhase.filter((e) => authorOf(e) === bot) }))
          .filter((x) => worthATurn(x.events, phase, options.thoughts));
        const commits = inPhase.filter((e) => e.type === 'commit');
        const announced = rd.events.filter((e) => e.phase === phase && ANNOUNCED(e));
        const announce = () => {
          for (const e of announced) push({ kind: 'announce', room: room.index, round: rd.round, phase, bot: null, events: [e], resolve: null, dur: TIMING.announce });
        };
        if (turns.length === 0 && !(phase === 'commit' && commits.length > 0)) {
          announce();
          continue;
        }
        push({ kind: 'phase', room: room.index, round: rd.round, phase, bot: null, events: [], resolve: null, dur: TIMING.phaseTitle });
        if (phase === 'commit' && options.thoughts === 'off') {
          push({ kind: 'commit-all', room: room.index, round: rd.round, phase, bot: null, events: commits, resolve: null, dur: TIMING.commitAll });
          // Public acts in the commit phase (an exile call's ballots are secret, but a spoken word isn't) still get their turn.
          for (const turn of turns.filter((x) => x.events.some((e) => e.type !== 'commit' && e.type !== 'thought' && e.type !== 'exile_ballot'))) {
            push({ kind: 'turn', room: room.index, round: rd.round, phase, bot: turn.bot, events: turn.events.filter((e) => e.type !== 'commit'), resolve: null, dur: turnSeconds(turn.events.filter((e) => e.type !== 'commit'), false) });
          }
          announce();
          continue;
        }
        for (const turn of turns) {
          const showThought = options.thoughts === 'all' || (options.thoughts === 'commit' && phase === 'commit');
          push({
            kind: 'turn',
            room: room.index,
            round: rd.round,
            phase,
            bot: turn.bot,
            events: turn.events,
            resolve: null,
            dur: turnSeconds(turn.events, showThought),
          });
        }
        announce();
      }
      if (rd.resolve) {
        push({
          kind: 'resolve',
          room: room.index,
          round: rd.round,
          phase: null,
          bot: null,
          events: rd.events.filter((e) => e.phase === 'resolve'),
          resolve: rd.resolve,
          dur: Math.max(1, rd.resolve.trace.steps / rd.resolve.trace.stepsPerSecond) + TIMING.resolveTail,
        });
      }
    }
    if (room.end) push({ kind: 'room-end', room: room.index, round: room.end.roundsPlayed, phase: null, bot: null, events: room.closingEvents, resolve: null, dur: TIMING.roomEnd });
  }
  if (game.end) push({ kind: 'game-end', room: game.rooms.length - 1, round: 0, phase: null, bot: null, events: [], resolve: null, dur: TIMING.gameEnd });
  return { beats, total: t };
}

/** The beat playing at time t, and how far into it we are. */
export function beatAt(script: Script, t: number): { beat: Beat; local: number } {
  const { beats } = script;
  let lo = 0;
  let hi = beats.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((beats[mid] as Beat).start <= t) lo = mid;
    else hi = mid - 1;
  }
  const beat = beats[lo] as Beat;
  return { beat, local: Math.min(beat.dur, Math.max(0, t - beat.start)) };
}

/** The first beat that shows an event (for jumping from the transcript to the moment it was said). */
export function beatForEvent(script: Script, eventId: number): Beat | null {
  return script.beats.find((b) => b.events.some((e) => e.id === eventId)) ?? null;
}
