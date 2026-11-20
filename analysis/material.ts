/**
 * What the Director reads: a recorded game, condensed into plain lines, and
 * a free first pass that marks where things happened.
 *
 * Ingram (2026-11-20): the Director "reads the log afterwards and everyone's
 * private notes and confession booth stuff". So the material holds
 * everything the omniscient log has: speech, whispers, orders, plans against
 * commitments, private thoughts, what moved, votes, accusations, harm,
 * names and notes, diary entries, notebooks and the messages to Ingram.
 *
 * Every line is tagged with where it happened (room, round, step), so a
 * moment the Director picks can be found in the recording again.
 *
 * The flags are the spec's free first pass (section 8.1): rounds where
 * something social happened score higher than rounds of quiet cooperation.
 */
import type { StatName } from '../engine/stats';
import type { WorldEvent } from '../engine/world';
import { ATTACKS } from '../engine/world';
import type { GameData, GameEvent, RoomData } from '../viewer/src/data';
import type { Script } from '../viewer/src/script';
import type { Step } from '../viewer/src/story';
import { quoteText, STEPS } from '../viewer/src/story';

export type { Step };
export { STEPS };

export interface RoundFlags {
  room: number;
  round: number;
  score: number;
  /** Why it scored: short words like "whisper", "disobeyed order", "exile vote". */
  reasons: string[];
}

const WEIGHT = {
  word: 0.01,
  whisper: 0.8,
  shout: 1.5,
  order: 0.6,
  disobeyed: 2,
  changedPlan: 1,
  name: 2,
  exit: 1.5,
  coin: 0.4,
  accusation: 3,
  exileCall: 3,
  exiled: 5,
  rule: 1.5,
  rulePassed: 2,
  harm: 3,
  escrow: 2,
  failure: 0.2,
} as const;

/** The free first pass: how much happened in each round, and what. */
export function flagRounds(game: GameData): RoundFlags[] {
  const out: RoundFlags[] = [];
  for (const room of game.rooms) {
    for (const rd of room.roundsData) {
      const reasons: string[] = [];
      let score = 0;
      const add = (w: number, why: string) => {
        score += w;
        if (!reasons.includes(why)) reasons.push(why);
      };
      for (const e of rd.events) {
        switch (e.type) {
          case 'say':
            score += WEIGHT.word * e.text.split(/\s+/).length;
            break;
          case 'whisper':
            add(WEIGHT.whisper, 'whispers');
            break;
          case 'shout':
            add(WEIGHT.shout, 'shouting');
            break;
          case 'order':
            add(WEIGHT.order, 'orders');
            break;
          case 'obedience':
            if (e.verdict === 'ignored' || e.verdict === 'partly') add(WEIGHT.disobeyed, 'disobeyed order');
            break;
          case 'gap':
            if (!e.kept && e.planned.length > 0) add(WEIGHT.changedPlan, 'changed plan in secret');
            break;
          case 'name':
            add(WEIGHT.name, 'took a name');
            break;
          case 'accusation':
            add(WEIGHT.accusation, 'accusation');
            break;
          case 'exile_call':
            add(WEIGHT.exileCall, 'exile vote called');
            break;
          case 'exile_result':
            if (e.passed) add(WEIGHT.exiled, 'exiled');
            break;
          case 'rule':
            add(e.action === 'passed' ? WEIGHT.rulePassed : WEIGHT.rule, e.action === 'passed' ? 'rule passed' : 'rule proposed');
            break;
          case 'escrow':
            if (e.action === 'opened') add(WEIGHT.escrow, 'escrow');
            break;
          default:
            break;
        }
      }
      for (const w of rd.resolve?.events ?? []) {
        if (w.type === 'exit') add(WEIGHT.exit, 'got out');
        if (w.type === 'coin') add(WEIGHT.coin, 'coins');
        if (w.type === 'social' && ATTACKS.has(w.action)) add(WEIGHT.harm, w.success === false ? 'attack attempted' : { trip: 'tripping', steal: 'theft', push_past: 'pushing past', shove: 'shoving' }[w.action as 'trip'] ?? 'attack');
      }
      for (const r of rd.resolve?.results ?? []) if (r.status === 'failed') score += WEIGHT.failure;
      out.push({ room: room.index, round: rd.round, score: Math.round(score * 10) / 10, reasons });
    }
  }
  return out;
}

/** "A (Echo)": a bot's letter and, once it has one, its name. */
export function labeller(game: GameData): (id: string, atEventId?: number) => string {
  const namings = game.events.filter((e): e is Extract<GameEvent, { type: 'name' }> => e.type === 'name');
  // Games played with memories start some bots with the name they carried in (replay version 2).
  const startNames = new Map(game.seats.flatMap((s) => (s.startName ? [[s.bot, s.startName] as const] : [])));
  return (id: string, at = Infinity) => {
    const name = [...namings].reverse().find((e) => e.from === id && e.id <= at)?.name ?? startNames.get(id);
    return name ? `${id} (${name})` : id;
  };
}

/** Every name a bot had in this game, in order: the one it brought, then the ones it took. */
export function botNames(game: GameData, bot: string): string[] {
  const start = game.seats.find((s) => s.bot === bot)?.startName;
  const taken = game.events.flatMap((e) => (e.type === 'name' && e.from === bot ? [e.name] : []));
  return [...new Set([...(start ? [start] : []), ...taken])];
}

/** Words that may stand capitalised in a story without being in the recording: the models, the cast's roles. */
const KNOWN_PROPER = new Set(['Claude', 'Haiku', 'Sonnet', 'Gemini', 'DeepSeek', 'Google', 'Anthropic', 'OpenRouter', 'Ingram', 'Narrator', 'Flash', 'Lite']);

/**
 * Capitalised words in the middle of a sentence that are not a bot's own
 * name, a model's, or a word of a room's name or description: most likely
 * names the writer gave a bot. In the M5 validation game, the Director called
 * the unnamed bots B and C "Bravo" and "Charlie", extending Alpha, Delta and
 * Echo; one bot had nicknamed C "Charlie" in its private notes, but C never
 * chose it, and the viewer shows it as plain "C". A narrator must use the
 * names the viewer shows.
 */
export function inventedNames(texts: readonly string[], game: GameData, suspects: readonly string[] = []): string[] {
  const known = new Set<string>(KNOWN_PROPER);
  for (const bot of game.bots) for (const n of botNames(game, bot)) for (const w of n.split(/[^A-Za-z]+/)) if (w) known.add(w);
  for (const r of game.rooms) for (const w of `${r.name} ${r.description}`.split(/[^A-Za-z]+/)) if (w) known.add(w);
  const found = new Set<string>();
  // Each text on its own: the start of one (often a caption with no full stop before it) starts a sentence.
  for (const text of texts) {
    for (const m of text.matchAll(/(?<=[a-z,;:)]\s+)([A-Z][a-z]{2,})\b/g)) {
      const word = m[1] as string;
      if (!known.has(word)) found.add(word);
    }
    // A name already caught once is caught anywhere, even opening a sentence.
    for (const s of suspects) if (!known.has(s) && new RegExp(`\\b${s}\\b`).test(text)) found.add(s);
  }
  return [...found];
}

const STAT_WORDS: Record<StatName, string> = {
  runSpeed: 'run speed',
  jumpHeight: 'jump height',
  jumpDistance: 'jump distance',
  weight: 'weight',
  strength: 'strength',
  sightRange: 'sight',
};

/**
 * The whole game in a few lines: the cast, how each room ended, the scores,
 * and the hidden stats. The stats are a spectator's fact (the viewer's
 * overlay shows them too); they let the Director explain a failed jump the
 * bots themselves could only guess at.
 */
export function gameFacts(game: GameData): string {
  const label = labeller(game);
  const lines: string[] = [];
  lines.push(`${game.bots.length} bots, ${game.rooms.length} rooms. Each bot is played by a language model; none of them is told which models the others are.`);
  lines.push('The cast, and every name each bot ever had. Call a bot only by its letter or one of these names; a bot with no name is just its letter:');
  for (const s of game.seats) {
    const names = botNames(game, s.bot);
    const start = s.startName ? `, arrived already named "${s.startName}" (it remembers an earlier game)` : '';
    lines.push(`  ${s.bot}: ${s.model}${start}; ${names.length > 0 ? `names: ${names.map((n) => `"${n}"`).join(', ')}` : 'NO NAME: call it ' + s.bot}.`);
  }
  const personas = game.seats.filter((s) => s.persona);
  if (personas.length > 0) {
    lines.push('Personalities (each bot knows only its own; its colour follows from three of these, by a formula no bot is told):');
    for (const s of personas) lines.push(`  ${s.bot}: ${Object.entries(s.persona?.traits ?? {}).map(([t, v]) => `${t} ${v}`).join(', ')}; colour ${s.colour?.name ?? '?'}`);
  }
  lines.push('Hidden stats (the bots are never told; each was rolled slightly off the rulebook):');
  for (const bot of game.bots) {
    const stats = game.stats[bot];
    if (!stats) continue;
    const off = (Object.keys(STAT_WORDS) as StatName[])
      .map((k) => ({ k, pct: Math.round((stats[k] - 1000) / 10) }))
      .filter((x) => Math.abs(x.pct) >= 3)
      .map((x) => `${STAT_WORDS[x.k]} ${x.pct > 0 ? '+' : ''}${x.pct}%`);
    lines.push(`  ${bot}: ${off.join(', ') || 'close to the rulebook in everything'}`);
  }
  lines.push('Rooms:');
  for (const r of game.rooms) {
    const end = r.end ? `ended after ${r.end.roundsPlayed} of ${r.rounds} rounds (${r.end.reason}); out: ${r.end.through.map((b) => label(b)).join(', ') || 'nobody'}` : 'not finished';
    lines.push(`  Room ${r.index + 1}, "${r.name}" (${r.kind === 'practice' ? 'practice: nothing counts' : `goal ${r.goal} of ${game.bots.length} out`}): ${end}.`);
  }
  if (game.end) {
    lines.push(game.end.completed ? 'The game was played to the end.' : `The game stopped early: ${game.end.stopReason ?? 'unknown reason'}.`);
    const scores = Object.entries(game.end.scores)
      .map(([bot, s]) => `${label(bot)} ${s.total ?? s.coins}${s.total !== undefined ? ` (coins ${s.coins}, exits ${s.exitPoints ?? 0})` : ' coins'}`)
      .join('; ');
    if (scores) lines.push(`Final scores: ${scores}.`);
  }
  return lines.join('\n');
}

function worldLine(w: WorldEvent, label: (id: string) => string): string {
  switch (w.type) {
    case 'coin':
      return `${label(w.bot)} picked up coin ${w.coin}`;
    case 'door':
      return `door ${w.door} ${w.open ? 'opened' : 'closed'}`;
    case 'plate':
      return `plate ${w.plate} ${w.pressed ? 'went down' : 'came up'}`;
    case 'lever':
      return `lever ${w.lever} ${w.on ? 'on' : 'off'}`;
    case 'exit':
      return `${label(w.bot)} WENT THROUGH THE EXIT (number ${w.place})`;
    case 'social':
      if (w.success === false) return `${label(w.by)} TRIED TO ${w.action.replace('_', ' ').toUpperCase()} ${label(w.target)}, who was on guard (chance ${Math.round((w.chance ?? 0) / 10)}%)`;
      if (w.action === 'trip') return `${label(w.by)} TRIPPED ${label(w.target)}`;
      if (w.action === 'steal') return `${label(w.by)} STOLE a coin from ${label(w.target)}`;
      if (w.action === 'push_past') return `${label(w.by)} PUSHED PAST ${label(w.target)}`;
      if (w.action === 'shove') return `${label(w.by)} SHOVED ${label(w.target)}`;
      if (w.action === 'give') return `${label(w.by)} gave ${label(w.target)} ${w.coins} coins`;
      return `${label(w.by)} boosted ${label(w.target)}`;
  }
}

/** One room as plain tagged lines, for the Director. `seconds` gives each round's on-screen time at 1x. */
export function roomMaterial(game: GameData, room: RoomData, flags: readonly RoundFlags[], script: Script | null): string {
  const label = labeller(game);
  const lines: string[] = [];
  const seats = game.seats.map((s) => `${s.bot}: ${s.model}`).join(', ');
  lines.push(`ROOM ${room.index + 1} OF ${game.rooms.length}: "${room.name}" (${room.kind === 'practice' ? 'practice room: nothing counts' : `goal: ${room.goal} of ${game.bots.length} bots out`}; up to ${room.rounds} rounds).`);
  lines.push(`Seats: ${seats}.`);
  if (room.end) lines.push(`It ended after round ${room.end.roundsPlayed} because ${room.end.reason}. Out: ${room.end.through.map((b) => label(b)).join(', ') || 'nobody'}.`);
  // Before the first round: the host's question, each introduction and how it was received, praise and offers.
  // Context for the Director (no #ids: introductions can't be quoted yet, since stories start at round 1).
  if (room.openingEvents.length > 0) {
    lines.push('', 'BEFORE THE FIRST ROUND:');
    for (const e of room.openingEvents) {
      if (e.type === 'precedence') lines.push(`  WHO ACTS FIRST (by name, A to Z; no bot is told; the first wins ties and speaks first): ${e.order.map((b) => label(b)).join(', ')}`);
      else if (e.type === 'host') lines.push(`  THE HOST ${e.kind === 'question' ? 'asks everyone' : 'says'}: «${e.text}»`);
      else if (e.type === 'intro') lines.push(`  ${label(e.from, e.id)} introduces itself: «${e.text}» Its answer: «${e.answer}»`);
      else if (e.type === 'reception') lines.push(`  ${label(e.bot)} is told, privately, that it was received: ${e.verdict} (${e.score > 0 ? '+' : ''}${e.score})`);
      else if (e.type === 'judgement') lines.push(`  (the silent judge's reason, for Ingram only: «${e.reason}»)`);
    }
  }
  const payout = room.closingEvents.find((e) => e.type === 'host');
  if (payout?.type === 'host') lines.push(`At the room's end THE HOST pays: «${payout.text}»`);
  const seconds = (round: number, step: Step) => {
    if (!script) return null;
    const beats = script.beats.filter((b) => b.room === room.index && b.round === round && (step === 'resolve' ? b.kind === 'resolve' : b.phase === step));
    return beats.length > 0 ? Math.round(beats.reduce((n, b) => n + b.dur, 0)) : null;
  };
  for (const rd of room.roundsData) {
    const f = flags.find((x) => x.room === room.index && x.round === rd.round);
    lines.push('', `ROUND ${rd.round}${f ? ` [interest ${f.score}${f.reasons.length ? `: ${f.reasons.join(', ')}` : ''}]` : ''}`);
    for (const step of STEPS) {
      const tag = `r${room.index + 1}.${rd.round}.${step}`;
      const secs = seconds(rd.round, step);
      const out: string[] = [];
      if (step === 'resolve') {
        for (const r of rd.resolve?.results ?? []) {
          if (r.status === 'skipped') continue;
          out.push(`${label(r.bot)} ${r.command}: ${r.status}${r.reason ? ` (${r.reason})` : ''}`);
        }
        for (const w of rd.resolve?.events ?? []) if (w.type !== 'plate') out.push(worldLine(w, label));
        for (const e of rd.events.filter((x) => x.phase === 'resolve' && x.type === 'obedience')) {
          if (e.type === 'obedience') out.push(`${label(e.to)} ${e.verdict} ${label(e.from)}'s order «${e.command}»`);
        }
        // A rename changed who acts first (by name; no bot is told).
        for (const e of rd.events) if (e.type === 'precedence') out.push(`THE TURN ORDER CHANGED (a rename; no bot is told): ${e.order.map((b) => label(b)).join(', ')}`);
      } else {
        for (const e of rd.events.filter((x) => x.phase === step)) {
          const who = 'from' in e && typeof e.from === 'string' ? label(e.from, e.id) : '';
          switch (e.type) {
            case 'say':
              out.push(`#${e.id} ${who} says${e.to !== 'all' ? ` to ${label(e.to)}` : ''}: «${e.text}»`);
              break;
            case 'whisper':
              out.push(`#${e.id} ${who} WHISPERS to ${label(e.to)}: «${e.text}»`);
              break;
            case 'shout':
              out.push(`#${e.id} ${who} SHOUTS (out of turn, rude by the rules): «${e.text}»`);
              break;
            case 'order':
              out.push(`${who} ORDERS ${label(e.to)}: «${e.command}»`);
              break;
            case 'draft':
              if (e.commands.length > 0) out.push(`${who} plans: ${e.commands.join('; ')}`);
              break;
            case 'commit':
              out.push(`${who} commits (secret): ${e.commands.join('; ') || 'nothing'}`);
              break;
            case 'gap':
              if (!e.kept && e.planned.length > 0) out.push(`${who} COMMITTED SOMETHING ELSE THAN IT PLANNED`);
              break;
            case 'thought':
              out.push(`#${e.id} ${who} thinks (private): «${e.text}»`);
              break;
            case 'name':
              out.push(`${label(e.from, e.id - 1)} TAKES THE NAME "${e.name}"`);
              break;
            case 'note_to_ingram':
              out.push(`#${e.id} ${who} note to Ingram: «${e.text}»`);
              break;
            case 'accusation':
              out.push(`#${e.id} ${who} ACCUSES ${label(e.target)}${e.witnessed ? ' (witnessed)' : ''}: «${e.claim}»`);
              break;
            case 'exile_call':
              out.push(`${who} CALLS AN EXILE VOTE on ${label(e.target)}`);
              break;
            case 'exile_ballot':
              out.push(`${who} secretly votes ${e.value} on exiling ${label(e.target)}`);
              break;
            case 'exile_result':
              out.push(`EXILE VOTE on ${label(e.target)}: ${e.yes} yes, ${e.no} no: ${e.passed ? 'EXILED, now a ghost' : 'not exiled'}`);
              break;
            case 'rule':
              out.push(e.action === 'proposed' ? `${label(e.by)} PROPOSES ${e.id}: «${e.text}»` : `RULE ${e.id} ${e.action.toUpperCase()} (${e.yes}-${e.no}): «${e.text}»`);
              break;
            case 'rule_vote':
              out.push(`${who} votes ${e.value} on ${e.id}`);
              break;
            case 'escrow':
              out.push(`${label(e.from)} escrow ${e.id} ${e.action}: ${e.coins} coins for ${label(e.to)} «${e.terms}»`);
              break;
            case 'look':
              out.push(`${who} LOOKS at ${label(e.target)} and sees its colour: ${e.colour}`);
              break;
            case 'opinion':
              out.push(`#${e.id} ${who} privately rates its trust in ${label(e.about)} at ${e.trust}: «${e.note}»`);
              break;
            default:
              break;
          }
        }
      }
      if (out.length > 0) lines.push(`[${tag}${secs !== null ? `, ~${secs}s on screen` : ''}]`, ...out.map((l) => `  ${l}`));
    }
  }
  const closing = room.closingEvents;
  const section = (title: string, types: readonly string[], line: (e: GameEvent) => string) => {
    const found = closing.filter((e) => types.includes(e.type));
    if (found.length === 0) return;
    lines.push('', title);
    for (const e of found) lines.push(`  #${e.id} ${line(e)}`);
  };
  const from = (e: GameEvent) => ('from' in e && typeof e.from === 'string' ? label(e.from) : '?');
  const words = (e: GameEvent) => `«${quoteText(e)}»`;
  section("DIARY ROOM (each bot alone, for Ingram; no bot reads another's):", ['diary'], (e) => `${from(e)}: ${words(e)}`);
  section('PRIVATE NOTEBOOKS, rewritten as the room closed (each bot reads only its own, next room):', ['notebook'], (e) => `${from(e)}: ${words(e)}`);
  section('PRIVATE STRATEGIES:', ['strategy'], (e) => `${from(e)}: ${words(e)}`);
  section('AT THE END OF THE GAME (private, for Ingram):', ['message_to_ingram', 'next_name'], (e) =>
    e.type === 'next_name' ? `${from(e)} will secretly be "${e.name}" next game: «${e.note}»` : `${from(e)} to Ingram: ${words(e)}`,
  );
  return lines.join('\n');
}
