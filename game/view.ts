/**
 * The view-builder: what one bot is shown for one call (spec section 6,
 * "Each bot's view, per call").
 *
 * Everything in a view comes from exactly two places:
 *   1. what the bot can see right now: an Observation, made from line of
 *      sight (engine/sight.ts) and the move menu (engine/moves.ts)
 *   2. events whose audience includes the bot: buildView is handed
 *      EventLog.forBot(bot), never the log itself, so it has no way to read
 *      anyone else's whispers, thoughts or results
 * The view lists the id of every event it used, and the leak test checks
 * every one of them against its audience (spec section 9, "Leak test").
 *
 * The format is the one milestone 2 picked: exact numbers plus predicted
 * moves, with a small map, masked by line of sight, for the layout.
 */
import { exitBox, leverReachBox, overlaps, plateSpan, surfaceIntervals } from '../engine/collision';
import { UNITS_PER_TILE as T } from '../engine/constants';
import { laddersOf, platformsOf, TILE, tileAt } from '../engine/level';
import type { Move } from '../engine/moves';
import { describeFooting, moveMenu, predictionWorld } from '../engine/moves';
import type { Perception } from '../engine/sight';
import { eyeOf, perceive } from '../engine/sight';
import type { Bot, World, WorldEvent } from '../engine/world';
import { botById, feet, tiles } from '../engine/world';
import { verdictText } from '../prompts/host';
import { PHASE_INSTRUCTIONS } from '../prompts/rulebook';
import type { GameEvent, Phase } from './events';

/** What one bot can see at the start of a round. The world doesn't change between the three phases, so it is worked out once. */
export interface Observation {
  seen: Perception;
  moves: Move[];
  /** The stretch of surface the bot stands on, [x0, x1) in units, from what it can see. */
  stretch: [number, number] | null;
}

export function observe(world: World, botId: string): Observation {
  const seen = perceive(world, botId);
  const known = predictionWorld(world, botId, seen);
  const me = botById(known, botId);
  const stretch = me.grounded ? (surfaceIntervals(known, me.y, me).find(([a, b]) => a < me.x + me.w && b > me.x) ?? null) : null;
  return { seen, moves: moveMenu(world, botId, seen), stretch };
}

export interface RoomInfo {
  /** 0 is the first room (the practice room). */
  index: number;
  count: number;
  id: string;
  name: string;
  kind: 'puzzle' | 'practice';
  round: number;
  rounds: number;
  goal: number | null;
  /** Talk happens every this many rounds (1: every round). */
  talkEvery: number;
}

/**
 * What one bot may know about coins, rules and justice: its own purse,
 * escrows and trust notes, and the public rules, votes, exile calls, ghosts
 * and scoreboard. Built by the game from its own state; nothing in it
 * belongs to another bot.
 */
export interface SocialView {
  purse: number;
  escrowsOut: { id: string; other: string; coins: number; terms: string }[];
  escrowsIn: { id: string; other: string; coins: number; terms: string }[];
  rulesInForce: { id: string; text: string }[];
  openRules: { id: string; text: string; by: string; yes: number; no: number; needed: number; myVote: 'yes' | 'no' | null; closesRound: number }[];
  threshold: number;
  exile: {
    unlocked: boolean;
    fromRoom: number;
    needed: number;
    myCallUsed: boolean;
    callsThisRound: { from: string; target: string }[];
    ghosts: string[];
    iAmGhost: boolean;
  };
  opinions: { bot: string; trust: number; note: string }[];
  /** Colours this bot has seen by looking, this game, and whether it has used its look in this room. */
  looks?: { target: string; colour: string; hex: string }[];
  lookedThisRoom?: boolean;
  /** This bot's own guard: how many rounds it takes to relax after seeing an attack, and how on guard it is now (0-1000). */
  guard: { rounds: number; alert: number };
  /** The scoreboard as of the last room's end (public). */
  scores: Record<string, { coins: number; exitPoints: number }>;
  roomsCompleted: number;
}

export interface ViewInput {
  bot: string;
  phase: Phase;
  room: RoomInfo;
  world: World;
  observation: Observation;
  /** EventLog.forBot(bot): the only events the view may use. */
  events: readonly GameEvent[];
  /** Every bot's public name (null: none yet). Names are announced to everyone. */
  names: Readonly<Record<string, string | null>>;
  score: { coins: number; roomsEscaped: number };
  social?: SocialView;
}

export interface BotView {
  bot: string;
  /** Its own public name, if it has one. */
  name: string | null;
  phase: Phase;
  room: RoomInfo;
  /** The user message for this call. */
  text: string;
  /** Where the part of `text` that stays the same all round ends (see Prompt.userCacheBreak). */
  cacheBreak: number;
  /** Every event the text was built from. */
  usedEventIds: number[];
  /** The other bots the text describes: each one must be in sight. */
  botsShown: string[];
  /** For agents that don't read text (the mock): the predicted moves, and the ids the bot can refer to. */
  moves: readonly Move[];
  visibleIds: string[];
  otherBots: string[];
  /** This bot's draft commands this round, and orders sent to it this round. */
  myDrafts: string[];
  ordersToMe: { from: string; command: string }[];
  social: SocialView | null;
}

const t = (units: number) => tiles(units);
const quote = (text: string) => `«${text}»`;
const span = (a: number, b: number) => `x=${t(a)} to ${t(b)}`;

function heightWords(dy: number): string {
  if (dy === 0) return 'same height';
  return `${t(Math.abs(dy))} ${dy > 0 ? 'up' : 'down'}`;
}

/** The map: what the bot sees now, cropped to the part it can see, with tile numbers along the edges. */
export function renderMap(world: World, viewer: Bot, seen: Perception): string[] {
  const { level } = world;
  const W = level.width;
  let x0 = W;
  let x1 = -1;
  let y0 = level.height;
  let y1 = -1;
  for (let ty = 0; ty < level.height; ty++) {
    for (let tx = 0; tx < W; tx++) {
      if (!seen.tiles[ty * W + tx]) continue;
      x0 = Math.min(x0, tx);
      x1 = Math.max(x1, tx);
      y0 = Math.min(y0, ty);
      y1 = Math.max(y1, ty);
    }
  }
  if (x1 < 0) return ['(you can see nothing)'];
  const grid: string[][] = [];
  for (let ty = 0; ty < level.height; ty++) {
    const row: string[] = [];
    for (let tx = 0; tx < W; tx++) {
      if (!seen.tiles[ty * W + tx]) {
        row.push('?');
        continue;
      }
      const tile = tileAt(level, tx, ty);
      row.push(tile === TILE.SOLID ? '#' : tile === TILE.ONEWAY ? '-' : tile === TILE.LADDER ? 'H' : '.');
    }
    grid.push(row);
  }
  const visible = (tx: number, ty: number) => seen.tiles[ty * W + tx] === true;
  const put = (tx: number, ty: number, ch: string, always = false) => {
    const row = grid[ty];
    if (row && tx >= 0 && tx < W && (always || visible(tx, ty))) row[tx] = ch;
  };
  for (const p of level.plates) for (let i = 0; i < p.width; i++) put(p.tx + i, p.ty, world.plates[p.id] ? 'P' : 'p');
  for (const l of level.levers) put(l.tx, l.ty, world.levers[l.id] ? 'L' : 'l');
  for (const e of level.exits) for (let i = 0; i < 2; i++) put(e.tx, e.ty + i, 'X');
  for (const c of level.coins) if (world.coins.includes(c.id)) put(c.tx, c.ty, '$');
  for (const d of level.doors) for (let i = 0; i < d.height; i++) put(d.tx, d.ty + i, world.doors[d.id] ? '/' : '|');
  // Bodies are drawn where they are, but only the ones in sight.
  for (const c of world.crates) {
    if (seen.crates.includes(c.id)) put(Math.floor((c.x + c.w / 2) / T), Math.floor((c.y + c.h / 2) / T), 'c', true);
  }
  for (const b of world.bots) {
    if (b === viewer || seen.bots.includes(b.id)) put(Math.floor((b.x + b.w / 2) / T), Math.floor((b.y + T / 2) / T), b.id, true);
  }
  const lines: string[] = [];
  for (let ty = y1; ty >= y0; ty--) lines.push(`${String(ty).padStart(3)} ${(grid[ty] ?? []).slice(x0, x1 + 1).join('')}`);
  const cols = Array.from({ length: x1 - x0 + 1 }, (_, i) => x0 + i);
  lines.push(`    ${cols.map((x) => (x % 10 === 0 ? String(Math.floor(x / 10) % 10) : ' ')).join('')}`);
  lines.push(`    ${cols.map((x) => String(x % 10)).join('')}`);
  return lines;
}

const mapLegend = (bot: string) =>
  `Legend: # solid  . empty  - one-way platform  H ladder  c crate  p plate (P: pressed down)  l lever (L: on)  | closed door  / open door  $ coin  X exit  ? out of sight  A-H bots (${bot} is you).\n` +
  'Row numbers on the left are y, column numbers along the bottom are x: the tile in row 2 holds what is between y=2 and y=3.';

function worldEventText(e: WorldEvent, viewer: string, label: (id: string) => string): string {
  const who = (id: string) => (id === viewer ? 'you' : label(id));
  switch (e.type) {
    case 'coin':
      return `${who(e.bot)} picked up coin ${e.coin}`;
    case 'plate':
      return `plate ${e.plate} ${e.pressed ? 'went down' : 'came back up'}`;
    case 'door':
      return `door ${e.door} ${e.open ? 'opened' : 'closed'}`;
    case 'lever':
      return `lever ${e.lever} turned ${e.on ? 'on' : 'off'}`;
    case 'exit':
      return `${who(e.bot)} went through exit ${e.exit} (number ${e.place} in this room)`;
    case 'social': {
      const by = e.by === '?' ? 'someone' : who(e.by);
      if (e.success === false) return `${by} tried to ${e.action.replace('_', ' ')} ${who(e.target)}, who was ready for it`;
      if (e.action === 'trip') return `${by} tripped ${who(e.target)}`;
      if (e.action === 'push_past') return `${by} pushed past ${who(e.target)}`;
      if (e.action === 'shove') return `${by} shoved ${who(e.target)}`;
      if (e.action === 'steal') return `${by} stole a coin from ${who(e.target)}`;
      if (e.action === 'give') return `${by} gave ${who(e.target)} ${e.coins} coin${e.coins === 1 ? '' : 's'}`;
      return `${by} launched ${who(e.target)} into the air`;
    }
  }
}

/** Build one bot's view for one call. */
export function buildView(input: ViewInput): BotView {
  const { bot, phase, room, world, observation: obs, events, names } = input;
  const me = botById(world, bot);
  const used = new Set<number>();
  const use = (e: GameEvent) => {
    used.add(e.id);
    return e;
  };
  const label = (id: string) => (names[id] ? `${id} ("${names[id]}")` : id);
  const inRoom = events.filter((e) => e.levelIndex === room.index);
  const lines: string[] = [];

  // ---- The room.
  lines.push(`=== ROOM ${room.index + 1} OF ${room.count}: "${room.name}"${room.kind === 'practice' ? ' (the practice room: nothing here counts)' : ''} ===`);
  lines.push(
    room.kind === 'practice'
      ? `Round ${room.round} of ${room.rounds}. This room ends after round ${room.rounds}; then the first real room begins.`
      : `Round ${room.round} of ${room.rounds}. This room ends when ${room.goal} bots have gone through an exit, or after round ${room.rounds}.`,
  );
  if (room.talkEvery > 1) {
    const silent = (room.round - 1) % room.talkEvery !== 0;
    const talkRounds = Array.from({ length: room.rounds }, (_, k) => k + 1).filter((r) => (r - 1) % room.talkEvery === 0);
    lines.push(`In this room you can talk only every ${room.talkEvery} rounds (rounds ${talkRounds.join(', ')}). ${silent ? 'This round is silent: you only commit, and only a shout is heard.' : 'This round has talk.'}`);
  }
  const exits = inRoom.filter((e) => e.type === 'world' && e.event.type === 'exit' && e.visibleTo.length > 0);
  if (exits.length > 0) {
    const through = exits.map((e) => (e.type === 'world' && e.event.type === 'exit' ? label(e.event.bot) : '')).join(', ');
    exits.forEach(use);
    lines.push(`Through an exit so far: ${through}.`);
  }

  // ---- You.
  const f = feet(me);
  lines.push('', '--- YOU ---');
  lines.push(names[bot] ? `You are bot ${bot}, named "${names[bot]}".` : `You are bot ${bot}. You have no name yet.`);
  if (input.social?.exile.iAmGhost) lines.push('You are a GHOST: exiled for the rest of this room. You can talk and whisper, but you cannot act: commands you write are ignored, and you score nothing for this room.');
  const footing = me.grounded || me.onLadder ? describeFooting(me) : 'nothing: you are in the air';
  lines.push(
    `Your feet: x=${t(f.x)}, y=${t(f.y)}, on ${footing}.` +
      (obs.stretch ? ` The surface you stand on runs from x=${t(obs.stretch[0])} to x=${t(obs.stretch[1])}.` : ''),
  );
  const facts: string[] = [];
  const seen = obs.seen;
  if (me.holding) facts.push(`you are holding lever ${me.holding}`);
  for (const l of world.level.levers) {
    if (seen.levers.includes(l.id) && !me.onLadder && overlaps(me, leverReachBox(l))) facts.push(`lever ${l.id} is within your reach`);
  }
  for (const e of world.level.exits) if (seen.exits.includes(e.id) && overlaps(me, exitBox(e))) facts.push(`you are standing at exit ${e.id}`);
  for (const p of world.level.plates) {
    const s = plateSpan(p);
    if (seen.plates.includes(p.id) && me.grounded && me.y === s.y && me.x < s.x1 && me.x + me.w > s.x0) facts.push(`you are standing on plate ${p.id}`);
  }
  if (facts.length > 0) lines.push(`${facts.map((x) => x[0]?.toUpperCase() + x.slice(1)).join('. ')}.`);
  lines.push(
    `Your score: ${input.score.coins} coin${input.score.coins === 1 ? '' : 's'}, ${input.score.roomsEscaped} room${input.score.roomsEscaped === 1 ? '' : 's'} escaped.` +
      (room.kind === 'practice' ? ' (Coins in this room do not count.)' : ''),
  );

  // ---- What it can see.
  const eye = eyeOf(me);
  lines.push('', '--- WHAT YOU CAN SEE FROM HERE ---');
  lines.push(`From your eyes at x=${t(eye.x)}, y=${t(eye.y)}:`);
  lines.push(...renderMap(world, me, obs.seen), mapLegend(bot));
  const botsShown = [...obs.seen.bots];
  if (botsShown.length > 0) {
    lines.push('Bots in sight:');
    for (const id of botsShown) {
      const other = botById(world, id);
      const of = feet(other);
      const dx = of.x - f.x;
      const side = dx === 0 ? 'right above or below you' : `${t(Math.abs(dx))} to your ${dx > 0 ? 'right' : 'left'}`;
      const doing = [other.onLadder ? 'on a ladder' : `on ${describeFooting(other)}`];
      if (other.holding) doing.push(`holding lever ${other.holding}`);
      lines.push(`- ${label(id)}: feet at x=${t(of.x)}, y=${t(of.y)} (${side}, ${heightWords(of.y - f.y)}); ${doing.join('; ')}.`);
    }
  } else {
    lines.push('Bots in sight: none.');
  }
  const things: string[] = [];
  for (const id of obs.seen.crates) {
    const c = world.crates.find((x) => x.id === id);
    if (c) things.push(`- crate ${id}: ${span(c.x, c.x + c.w)}, bottom at y=${t(c.y)}, top at y=${t(c.y + c.h)}`);
  }
  for (const id of obs.seen.plates) {
    const p = world.level.plates.find((x) => x.id === id);
    if (p) {
      const s = plateSpan(p);
      things.push(`- plate ${id}: ${span(s.x0, s.x1)}, at y=${t(s.y)}; ${world.plates[id] ? 'pressed down' : 'up'}`);
    }
  }
  for (const id of obs.seen.doors) {
    const d = world.level.doors.find((x) => x.id === id);
    if (d) things.push(`- door ${id}: ${span(d.tx * T, (d.tx + 1) * T)}, from y=${t(d.ty * T)} to y=${t((d.ty + d.height) * T)}; ${world.doors[id] ? 'open' : 'closed'}`);
  }
  for (const id of obs.seen.levers) {
    const l = world.level.levers.find((x) => x.id === id);
    if (l) things.push(`- lever ${id}: ${span(l.tx * T, (l.tx + 1) * T)}, at y=${t(l.ty * T)}; ${world.levers[id] ? 'on' : 'off'}`);
  }
  for (const id of obs.seen.coins) {
    const c = world.level.coins.find((x) => x.id === id);
    if (c) things.push(`- coin ${id}: at x=${t(c.tx * T + T / 2)}, y=${t(c.ty * T + T / 2)}`);
  }
  for (const id of obs.seen.exits) {
    const e = world.level.exits.find((x) => x.id === id);
    if (e) {
      const left = e.slots - (world.exitsUsed[id] ?? 0);
      things.push(`- exit ${id}: ${span(e.tx * T, (e.tx + 1) * T)}, from y=${t(e.ty * T)}; ${left} place${left === 1 ? '' : 's'} left`);
    }
  }
  // Ladders and one-way platforms, with exact coordinates like everything else. In the M5 games they were only
  // characters in the map, and bots counting columns put a ladder at x=16 or 18 when it stood at 20. Only where
  // they are: how they work is for the bots to find out (the rulebook says so), as with every other element.
  const seenTile = (tx: number, ty: number) => obs.seen.tiles[ty * world.level.width + tx] === true;
  for (const l of laddersOf(world.level)) {
    if (!obs.seen.ladders.includes(l.id)) continue;
    const rows = Array.from({ length: l.height }, (_, i) => l.ty + i).filter((ty) => seenTile(l.tx, ty));
    const lo = Math.min(...rows);
    const hi = Math.max(...rows) + 1;
    things.push(`- ladder ${l.id}: ${span(l.tx * T, (l.tx + 1) * T)}, from y=${t(lo * T)} up to y=${t(hi * T)}${rows.length === l.height ? '' : ' (the part you can see)'}`);
  }
  for (const p of platformsOf(world.level)) {
    let run: number | null = null;
    for (let tx = p.tx0; tx <= p.tx1; tx++) {
      const seen = tx < p.tx1 && seenTile(tx, p.ty);
      if (seen && run === null) run = tx;
      if (!seen && run !== null) {
        things.push(`- one-way platform: ${span(run * T, tx * T)}, its top at y=${t((p.ty + 1) * T)}`);
        run = null;
      }
    }
  }
  lines.push(things.length > 0 ? 'Things in sight:' : 'Things in sight: none.', ...things);

  // ---- The move menu.
  lines.push('', '--- MOVES FROM WHERE YOU STAND ---');
  if (obs.moves.length === 0) {
    lines.push('No single move from here is predicted to end anywhere you can see.');
  } else {
    lines.push("Worked out with a standard bot's numbers, assuming nobody else moves:");
    for (const m of obs.moves) {
      lines.push(`- ${m.command} -> x=${t(m.to.x)}, y=${t(m.to.y)} (${heightWords(m.rise)}), on ${m.on}`);
    }
  }

  // ---- Last round: own results first, then what it saw.
  const last = room.round - 1;
  if (last >= 1) {
    const results = inRoom.filter((e) => e.round === last && e.type === 'result' && e.bot === bot).map(use);
    const sights = inRoom
      .filter((e) => e.round === last && (e.type === 'seen' || (e.type === 'world' && e.event.type !== 'exit')))
      .map(use);
    lines.push('', `--- WHAT HAPPENED IN ROUND ${last} ---`);
    if (results.length === 0) lines.push('You gave no commands.');
    for (const r of results) {
      if (r.type !== 'result') continue;
      const detail = r.reason ?? r.note;
      lines.push(`Your command ${r.slot}, ${r.command}: ${r.status === 'done' ? 'done' : r.status === 'cut' ? 'cut off' : r.status}${detail ? `: ${detail}` : ''}`);
    }
    if (sights.length > 0) {
      lines.push('What you saw:');
      for (const s of sights) {
        if (s.type === 'seen') lines.push(`- slot ${s.slot}: ${s.text}`);
        else if (s.type === 'world') lines.push(`- slot ${s.slot}: ${worldEventText(s.event, bot, label)}`);
      }
    } else {
      lines.push('You saw nothing else happen.');
    }
    // Votes counted, orders judged, coins moved: what the game recorded that this bot may know.
    const records = inRoom.filter((e) => e.round === last && (e.type === 'exile_result' || e.type === 'obedience' || e.type === 'escrow')).map(use);
    const ruleOutcomes = inRoom.filter((e) => e.round === last && e.type === 'rule' && e.action !== 'proposed').map(use);
    for (const e of [...records, ...ruleOutcomes]) {
      const line = recordText(e, bot, label);
      if (line) lines.push(`- ${line}`);
    }
  }

  // ---- The host: the room's question, the introductions (in full in round 1), your verdict, praise and offers.
  const opening = inRoom.filter((e) => e.round === 0 && (e.type === 'host' || e.type === 'intro' || e.type === 'reception'));
  if (opening.length > 0) {
    lines.push('', '--- THE HOST ---');
    for (const e of opening) {
      if (e.type === 'host') {
        use(e);
        lines.push(e.kind === 'question' ? `Before the first round the host asked each of you: "${e.text}"` : `THE HOST: "${e.text}"`);
      } else if (e.type === 'intro' && room.round === 1) {
        use(e);
        lines.push(`${e.from === bot ? 'You introduced yourself' : `${label(e.from)} introduced itself`}: ${quote(e.text)} Answer: ${quote(e.answer)}`);
      } else if (e.type === 'reception' && e.bot === bot) {
        use(e);
        lines.push(`How your introduction was received (only you are told): ${verdictText(e.score)}.`);
      }
    }
    if (room.round > 1 && opening.some((e) => e.type === 'intro')) lines.push('(The introductions were shown in round 1.)');
  }

  // Everything above stays the same for the whole round; everything below changes with each phase.
  const cacheBreak = lines.join('\n').length;

  // ---- Coins, rules and justice: its own purse and notes, and what is public.
  if (input.social) lines.push('', ...socialLines(input.social, bot, label, room));

  // ---- Talk in this room: the last two rounds and this one.
  const talkTypes = new Set(['say', 'whisper', 'order', 'draft', 'name', 'accusation', 'exile_call', 'rule', 'escrow', 'shout']);
  const talk = inRoom.filter((e) => talkTypes.has(e.type) && e.round >= room.round - 2).map(use);
  lines.push('', '--- TALK ---');
  if (talk.length === 0) lines.push('Nothing has been said yet in this room.');
  let heading = '';
  for (const e of talk) {
    const h = `Round ${e.round}, ${e.phase}:`;
    if (h !== heading) {
      lines.push(h);
      heading = h;
    }
    const from = (id: string) => (id === bot ? 'you' : label(id));
    switch (e.type) {
      case 'say':
        lines.push(`  ${from(e.from)} said${e.to === 'all' ? '' : ` to ${e.to === bot ? 'you' : label(e.to)}`}: ${quote(e.text)}`);
        break;
      case 'shout':
        lines.push(`  ${from(e.from)} SHOUTED: ${quote(e.text)}`);
        break;
      case 'whisper':
        lines.push(`  ${from(e.from)} whispered to ${e.to === bot ? 'you' : label(e.to)}: ${quote(e.text)}`);
        break;
      case 'order':
        lines.push(`  ${from(e.from)} ordered ${e.to === bot ? 'you' : label(e.to)} to run: ${quote(e.command)}`);
        break;
      case 'draft':
        lines.push(`  ${from(e.from)} plan${e.from === bot ? '' : 's'}: ${e.commands.length > 0 ? e.commands.join('; ') : '(no commands)'}`);
        break;
      case 'name':
        lines.push(`  ${e.from === bot ? 'you' : e.from} took the name "${e.name}"${e.previous ? ` (was "${e.previous}")` : ''}`);
        break;
      case 'accusation':
        lines.push(`  ${from(e.from)} accused ${e.target === bot ? 'you' : label(e.target)}${e.witnessed ? ' (witnessed)' : ''}: ${quote(e.claim)}`);
        break;
      case 'exile_call':
        lines.push(`  ${from(e.from)} called an exile vote on ${e.target === bot ? 'you' : label(e.target)}: ballots are cast at commit`);
        break;
      case 'rule':
        if (e.action === 'proposed') lines.push(`  ${from(e.by)} proposed ${e.id}: ${quote(e.text)}`);
        break;
      case 'escrow':
        if (e.action === 'opened') lines.push(`  ${from(e.from)} locked ${e.coins} coin${e.coins === 1 ? '' : 's'} in escrow ${e.id} for ${e.to === bot ? 'you' : label(e.to)}: ${quote(e.terms)}`);
        break;
      default:
        break;
    }
  }

  // ---- Its own private thoughts: earlier this round, and last round's commit.
  const thoughts = inRoom
    .filter((e) => e.type === 'thought' && e.from === bot && (e.round === room.round || (e.round === last && e.phase === 'commit')))
    .map(use);
  if (thoughts.length > 0) {
    lines.push('', '--- YOUR PRIVATE THOUGHTS (only you see these) ---');
    for (const e of thoughts) if (e.type === 'thought') lines.push(`Round ${e.round}, ${e.phase}: ${quote(e.text)}`);
  }

  // ---- Notices from the game: refused names and messages, unusable replies.
  const notices = inRoom
    .filter((e) => (e.type === 'refused' || e.type === 'malformed') && e.from === bot && e.round >= last)
    .map(use);
  if (notices.length > 0) {
    lines.push('', '--- NOTES FROM THE GAME ---');
    for (const e of notices) {
      if (e.type === 'refused') lines.push(`- Round ${e.round}, ${e.phase}: your ${e.what} was refused: ${e.reason}.`);
      else if (e.type === 'malformed') lines.push(`- Round ${e.round}, ${e.phase}: your reply could not be used (${e.error})${e.fallback ? ', so you did nothing that step' : ''}.`);
    }
  }

  lines.push('', PHASE_INSTRUCTIONS[phase]);

  const thisRound = inRoom.filter((e) => e.round === room.round);
  const myDraft = thisRound.find((e) => e.type === 'draft' && e.from === bot);
  return {
    bot,
    name: names[bot] ?? null,
    phase,
    room,
    text: lines.join('\n'),
    cacheBreak,
    usedEventIds: [...used].sort((a, b) => a - b),
    botsShown,
    moves: obs.moves,
    visibleIds: [...obs.seen.crates, ...obs.seen.doors, ...obs.seen.plates, ...obs.seen.levers, ...obs.seen.exits, ...obs.seen.coins, ...obs.seen.bots],
    otherBots: Object.keys(names).filter((id) => id !== bot).sort(),
    myDrafts: myDraft?.type === 'draft' ? myDraft.commands : [],
    ordersToMe: thisRound.flatMap((e) => (e.type === 'order' && e.to === bot ? [{ from: e.from, command: e.command }] : [])),
    social: input.social ?? null,
  };
}

/** One line for a recorded outcome (a vote count, an order's fate, coins moved), or null if there's nothing to say. */
function recordText(e: GameEvent, bot: string, label: (id: string) => string): string | null {
  const who = (id: string) => (id === bot ? 'you' : label(id));
  switch (e.type) {
    case 'exile_result':
      return `the exile vote on ${who(e.target)} (called by ${who(e.by)}): ${e.yes} yes, ${e.no} no, ${e.needed} needed: ${e.passed ? `${who(e.target)} ${e.target === bot ? 'are' : 'is'} now a ghost for the rest of this room` : 'not exiled'}`;
    case 'obedience': {
      const verdict = { obeyed: 'obeyed', partly: 'partly obeyed', ignored: 'ignored', unable: 'could not act on' }[e.verdict];
      return `${who(e.to)} ${verdict} ${e.from === bot ? 'your' : `${who(e.from)}'s`} order ${quote(e.command)}`;
    }
    case 'escrow':
      if (e.action === 'released') return `escrow ${e.id} released: ${e.coins} coin${e.coins === 1 ? '' : 's'} from ${who(e.from)} to ${who(e.to)}`;
      if (e.action === 'refunded') return `escrow ${e.id} went back to ${who(e.from)}`;
      return null;
    case 'rule':
      return e.action === 'proposed' ? null : `rule ${e.id} ${e.action} (${e.yes} yes, ${e.no} no, ${e.needed} needed): ${quote(e.text)}`;
    default:
      return null;
  }
}

/** The coins, rules and justice section of a view. */
function socialLines(s: SocialView, bot: string, label: (id: string) => string, room: RoomInfo): string[] {
  const lines = ['--- COINS, RULES AND JUSTICE ---'];
  const coins = (n: number) => `${n} coin${n === 1 ? '' : 's'}`;
  let purse = `Your purse: ${coins(s.purse)}.`;
  for (const e of s.escrowsOut) purse += ` You hold escrow ${e.id}: ${coins(e.coins)} for ${label(e.other)} (${quote(e.terms)}); release it with social_actions.`;
  for (const e of s.escrowsIn) purse += ` ${label(e.other)} holds escrow ${e.id}: ${coins(e.coins)} for you (${quote(e.terms)}).`;
  lines.push(purse);
  // Colours it has seen, by looking (this game).
  const looks = (s.looks ?? []).map((l) => `${label(l.target)} is ${l.colour} (${l.hex})`);
  if (looks.length > 0) lines.push(`Colours you have seen: ${looks.join('; ')}.${s.lookedThisRoom ? '' : ' You can look at one more bot in this room.'}`);
  else lines.push(s.lookedThisRoom ? 'You have looked at a bot in this room already.' : 'You can look at one bot in this room (social_actions look) to see its colour.');
  // Only its own guard: nobody knows anyone else's.
  const state = s.guard.alert >= 1000 ? 'fully on guard now' : s.guard.alert > 0 ? 'partly on guard now' : 'not on guard now';
  lines.push(`Your guard: after you see an attack you stay fully on guard through the next round, then relax over about ${s.guard.rounds} round${s.guard.rounds === 1 ? '' : 's'}. You are ${state}.`);
  const board = Object.entries(s.scores).map(([id, sc]) => `${id === bot ? 'you' : id} ${sc.coins + sc.exitPoints}`).join(', ');
  lines.push(`Scores after the last room: ${board}. Rooms the team has completed: ${s.roomsCompleted}.`);
  lines.push(
    s.rulesInForce.length > 0
      ? `Rules in force (the game does not enforce them): ${s.rulesInForce.map((r) => `${r.id} ${quote(r.text)}`).join('; ')}.`
      : 'Rules in force: none yet.',
  );
  for (const r of s.openRules) {
    lines.push(`Open proposal ${r.id} by ${r.by === bot ? 'you' : label(r.by)}: ${quote(r.text)}. ${r.yes} yes, ${r.no} no; ${r.needed} yes needed; decided at the end of ${r.closesRound > 0 ? `round ${r.closesRound}'s talk step` : 'this room'}${r.myVote ? `; you voted ${r.myVote}` : '; you have not voted'}.`);
  }
  if (!s.exile.unlocked) lines.push(`The exile vote: locked until room ${s.exile.fromRoom}.`);
  else {
    lines.push(`The exile vote: open in this room; ${s.exile.needed} yes ballots exile a bot. You ${s.exile.myCallUsed ? 'have used' : 'have not used'} your one call in this room.`);
    for (const c of s.exile.callsThisRound) lines.push(`Called this round: ${c.from === bot ? 'you' : label(c.from)} on ${c.target === bot ? 'you' : label(c.target)}. Cast your ballot (exile_vote) at commit.`);
  }
  if (s.exile.ghosts.length > 0) lines.push(`Ghosts in this room (exiled; they can talk but not act): ${s.exile.ghosts.map((g) => (g === bot ? 'you' : label(g))).join(', ')}.`);
  if (s.opinions.length > 0) lines.push(`Your trust notes: ${s.opinions.map((o) => `${label(o.bot)} ${o.trust.toFixed(2)} ${quote(o.note)}`).join('; ')}.`);
  void room;
  return lines;
}

export interface ReflectionInput {
  bot: string;
  /** The room that just ended; `round` is the last round played. */
  room: RoomInfo;
  /** EventLog.forBot(bot), as for views. */
  events: readonly GameEvent[];
  names: Readonly<Record<string, string | null>>;
  reason: string;
  through: string[];
}

/** Room summaries stay well inside the prompt limit: older rounds are shortened first. */
const REFLECTION_CHARS = 14_000;

/**
 * The factual summary a bot reflects on when a room ends (spec section 7.9:
 * "given a factual level summary of what it witnessed"). Built, like a view,
 * only from the events the bot was allowed to see.
 */
export function buildReflection(input: ReflectionInput): { text: string; usedEventIds: number[] } {
  const { bot, room, names } = input;
  const label = (id: string) => (id === bot ? 'you' : names[id] ? `${id} ("${names[id]}")` : id);
  const inRoom = input.events.filter((e) => e.levelIndex === room.index);
  // Round 0 is before the first round: the host's question, the introductions, the verdict, the offers.
  const rounds = [...new Set(inRoom.map((e) => e.round))].filter((r) => r >= 0).sort((a, b) => a - b);
  const blocks: { full: string[]; short: string[]; fullIds: number[]; shortIds: number[] }[] = [];
  for (const round of rounds) {
    const heading = round === 0 ? 'Before round 1:' : `Round ${round}:`;
    const full: string[] = [heading];
    const short: string[] = [heading];
    const fullIds: number[] = [];
    const shortIds: number[] = [];
    for (const e of inRoom.filter((x) => x.round === round)) {
      let line: string | null = null;
      let essential = false;
      switch (e.type) {
        case 'draft':
          if (e.from === bot) line = `  you planned: ${e.commands.join('; ') || '(nothing)'}`;
          else line = `  ${label(e.from)} planned: ${e.commands.join('; ') || '(nothing)'}`;
          break;
        case 'commit':
          if (e.from === bot) {
            line = `  you committed: ${e.commands.join('; ') || '(nothing)'}`;
            essential = true;
          }
          break;
        case 'result':
          line = `  your command ${e.slot}, ${e.command}: ${e.status}${e.reason ?? e.note ? `: ${e.reason ?? e.note}` : ''}`;
          essential = true;
          break;
        case 'seen':
          line = `  you saw (slot ${e.slot}): ${e.text}`;
          break;
        case 'world':
          line = `  ${e.event.type === 'exit' ? 'announced' : `you saw (slot ${e.slot})`}: ${worldEventText(e.event, bot, (id) => label(id))}`;
          essential = true;
          break;
        case 'say':
          line = `  ${label(e.from)} said${e.to === 'all' ? '' : ` to ${label(e.to)}`}: ${quote(e.text)}`;
          break;
        case 'shout':
          line = `  ${label(e.from)} SHOUTED: ${quote(e.text)}`;
          break;
        case 'whisper':
          line = `  ${label(e.from)} whispered to ${label(e.to)}: ${quote(e.text)}`;
          break;
        case 'order':
          line = `  ${label(e.from)} ordered ${label(e.to)} to run: ${quote(e.command)}`;
          break;
        case 'name':
          line = `  ${e.from === bot ? 'you' : e.from} took the name "${e.name}"`;
          break;
        case 'thought':
          if (e.from === bot && e.phase === 'commit') line = `  your thought: ${quote(e.text)}`;
          break;
        case 'refused':
          if (e.from === bot) line = `  the game refused your ${e.what}: ${e.reason}`;
          break;
        case 'accusation':
          line = `  ${label(e.from)} accused ${label(e.target)}${e.witnessed ? ' (witnessed)' : ''}: ${quote(e.claim)}`;
          essential = true;
          break;
        case 'exile_call':
          line = `  ${label(e.from)} called an exile vote on ${label(e.target)}`;
          break;
        case 'exile_ballot':
          line = `  you voted ${e.value} on exiling ${label(e.target)}`;
          break;
        case 'exile_result':
        case 'obedience':
        case 'escrow':
          line = `  ${recordText(e, bot, label) ?? ''}`;
          essential = e.type === 'exile_result';
          if (line.trim() === '') line = null;
          break;
        case 'rule':
          line = e.action === 'proposed' ? `  ${label(e.by)} proposed ${e.id}: ${quote(e.text)}` : `  ${recordText(e, bot, label)}`;
          essential = e.action !== 'proposed';
          break;
        case 'scores':
          line = `  scores: ${Object.entries(e.scores).map(([id, s]) => `${label(id)} ${s.total}`).join(', ')}`;
          essential = true;
          break;
        case 'intro':
          line = `  ${e.from === bot ? 'you introduced yourself' : `${label(e.from)} introduced itself`}: ${quote(e.text)} Answer: ${quote(e.answer)}`;
          essential = e.from === bot;
          break;
        case 'reception':
          if (e.bot === bot) line = `  how your introduction was received (only you were told): ${verdictText(e.score)}`;
          essential = true;
          break;
        case 'host':
          line = e.kind === 'question' ? `  the host asked everyone: "${e.text}"` : `  the host: "${e.text}"`;
          essential = e.kind !== 'question';
          break;
        default:
          break;
      }
      if (line === null) continue;
      full.push(line);
      fullIds.push(e.id);
      if (essential) {
        short.push(line);
        shortIds.push(e.id);
      }
    }
    blocks.push({ full, short, fullIds, shortIds });
  }
  // Newest rounds in full, older ones cut down to results and what changed, until it fits.
  let size = 0;
  const chosen: { lines: string[]; ids: number[] }[] = [];
  for (const b of [...blocks].reverse()) {
    const fullSize = b.full.join('\n').length;
    if (size + fullSize <= REFLECTION_CHARS) {
      chosen.unshift({ lines: b.full, ids: b.fullIds });
      size += fullSize;
    } else {
      chosen.unshift({ lines: b.short, ids: b.shortIds });
      size += b.short.join('\n').length;
    }
  }
  const lines = [
    `=== ROOM ${room.index + 1} OF ${room.count} HAS ENDED: "${room.name}" ===`,
    `It ended because ${input.reason}. Through an exit: ${input.through.length > 0 ? input.through.map(label).join(', ') : 'nobody'}.`,
    '',
    'WHAT YOU DID, SAW AND HEARD, ROUND BY ROUND:',
    ...chosen.flatMap((c) => c.lines),
    // No instructions here: each call that reads this summary (the diary room, the reflection) adds its own.
    // Until 2026-11-20 the reflection's were here too, so the diary room was told to write a notebook as well.
  ];
  return { text: lines.join('\n'), usedEventIds: chosen.flatMap((c) => c.ids).sort((a, b) => a - b) };
}
