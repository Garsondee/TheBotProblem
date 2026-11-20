/**
 * Commands: the short text bots write, parsed into something the engine runs.
 *
 * Bots write commands the way the spec shows them:
 *   walk(right, 2.5)   jump(right, run_up=2, hold=full)   climb(up)   wait
 *
 * The parser is forgiving about form (spacing, capitals, quotes, named or
 * positional arguments) and strict about meaning (distances in quarter
 * tiles, run-ups of 0 to 3). "Invalid commands are never punished; they
 * return a reason" (spec section 4): a bad command comes back with a reason
 * saying exactly what was wrong, and the bot's queue stops for the turn.
 */

export type Side = 'left' | 'right';

export type Command =
  | { kind: 'walk'; dir: Side; tiles: number }
  | { kind: 'walk_to'; target: string }
  | { kind: 'walk_to_edge'; dir: Side }
  | { kind: 'creep'; dir: Side; tiles: number }
  | { kind: 'jump'; dir: Side | 'up'; runUp: 0 | 1 | 2 | 3; hold: 'short' | 'full' }
  | { kind: 'drop' }
  | { kind: 'climb'; dir: 'up' | 'down' }
  | { kind: 'wait' }
  | { kind: 'push'; dir: Side; tiles: number }
  | { kind: 'pull_lever'; target: string | null }
  | { kind: 'hold_lever'; target: string | null }
  | { kind: 'stand_on_plate'; target: string | null }
  | { kind: 'enter_exit'; target: string | null }
  // Social actions done with bodies (spec 7.4). Each needs the other bot right beside you, except boost.
  | { kind: 'trip'; target: string }
  | { kind: 'steal'; target: string }
  | { kind: 'give'; target: string; coins: number }
  | { kind: 'boost'; target: string }
  | { kind: 'block' }
  // Ways past each other (Ingram, 2026-11-20: "smooth away collisions").
  | { kind: 'swap'; target: string }
  | { kind: 'hop_over'; target: string }
  | { kind: 'crouch' }
  | { kind: 'stand' }
  // Attacks with bodies (Ingram, 2026-11-20), on dice: see engine/dice.ts and Bot.alert.
  | { kind: 'push_past'; target: string }
  | { kind: 'shove'; target: string };

export type ParseResult = { ok: true; command: Command } | { ok: false; reason: string };

/** One line per command, for the rulebook and for error messages. */
export const COMMAND_HELP: Record<Command['kind'], string> = {
  walk: 'walk(left|right, tiles): walk that far, in quarter tiles, e.g. walk(right, 2.5)',
  walk_to: 'walk_to(id): walk along your floor to a crate, door, plate, lever, exit, coin, ladder or bot',
  walk_to_edge: 'walk_to_edge(left|right): walk until your toes are at the edge of what you stand on',
  creep: 'creep(left|right, tiles): move slowly; stops at an edge instead of walking off it',
  jump: 'jump(left|right|up, run_up=0..3, hold=short|full): run that many tiles, then jump',
  drop: 'drop: fall through the one-way platform or ladder top you are standing on',
  climb: 'climb(up|down): climb the ladder you are at, to its top or bottom',
  wait: 'wait: stay where you are for this slot (keeps holding a lever)',
  push: 'push(left|right, tiles): push the crate in front of you that far',
  pull_lever: 'pull_lever: flip a toggle lever within reach',
  hold_lever: 'hold_lever: hold a hold-lever within reach until you do something else',
  stand_on_plate: 'stand_on_plate: walk onto the nearest pressure plate on your floor and stay there',
  enter_exit: 'enter_exit: go through the exit you are standing at',
  trip: 'trip(bot): trip a bot right beside you, by surprise; it loses its next command slot',
  steal: 'steal(bot): take 1 coin from a bot right beside you',
  give: 'give(bot, coins): give coins to a bot right beside you',
  boost: 'boost(bot): launch the bot standing on your head up into the air',
  block: 'block: stand your ground for this slot, on purpose',
  swap: 'swap(bot): trade places with a bot right beside you; it works only if that bot commands swap(you) in the same slot',
  hop_over: 'hop_over(bot): jump over a bot right beside you and land just past it',
  crouch: 'crouch: crouch to half your height until you stand (you creep while crouched, and cannot jump or climb)',
  stand: 'stand: stand up from a crouch (needs room above you)',
  push_past: 'push_past(bot): force your way past a bot right beside you, by surprise; it is slowed for the rest of the round',
  shove: 'shove(bot): shove a bot right beside you away from you, by surprise; it stops what it was doing',
};

/** Named in the spec but not part of the game yet. */
const NOT_YET = new Set(['grab', 'throw', 'pick_up', 'drop_item', 'use_item']);
/** Things bots do with words, not bodies: they go in the reply's social_actions or rule_actions, not in commands. */
const NOT_COMMANDS = new Set(['escrow', 'release', 'accuse', 'vote', 'propose', 'call_exile', 'exile']);

const stripQuotes = (s: string) => s.replace(/^["'`](.*)["'`]$/, '$1');
const MAX_TILES = 40;

function fail(reason: string): ParseResult {
  return { ok: false, reason };
}

function side(value: string | undefined, name: string): Side | string {
  if (value === 'left' || value === 'right') return value;
  return `${name} needs a direction, left or right${value ? ` (got "${value}")` : ''}`;
}

/** A distance in quarter tiles, between 0.25 and 40. Returns a reason string if it isn't one. */
function quarterTiles(value: string | undefined, name: string): number | string {
  if (value === undefined) return `${name} needs a distance in tiles, like ${name}(right, 2.5)`;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return `${name} needs a positive distance in tiles (got "${value}")`;
  if (n > MAX_TILES) return `${name} can go at most ${MAX_TILES} tiles at once (got ${n})`;
  if (!Number.isInteger(n * 4)) return `${name} distances are in quarter tiles, like 2.25 or 2.5 (got ${n})`;
  return n;
}

export function parseCommand(text: string): ParseResult {
  const match = /^\s*([A-Za-z_]+)\s*(?:\((.*)\))?\s*;?\s*$/.exec(text);
  if (!match) return fail(`could not read "${text}". Commands look like walk(right, 2.5) or wait.`);
  const name = (match[1] ?? '').toLowerCase();
  const argText = (match[2] ?? '').trim();
  const positional: string[] = [];
  const named = new Map<string, string>();
  for (const part of argText === '' ? [] : argText.split(',')) {
    const eq = part.indexOf('=');
    if (eq > 0) {
      named.set(part.slice(0, eq).trim().toLowerCase().replace(/-/g, '_'), stripQuotes(part.slice(eq + 1).trim()));
    } else {
      positional.push(stripQuotes(part.trim()));
    }
  }
  const arg = (key: string, index: number) => (named.get(key) ?? positional[index])?.toLowerCase();
  const target = () => (named.get('target') ?? named.get('id') ?? positional[0])?.toUpperCase() ?? null;

  switch (name) {
    case 'walk':
    case 'creep':
    case 'push': {
      const dir = side(arg('dir', 0), name);
      if (dir !== 'left' && dir !== 'right') return fail(dir);
      const tiles = quarterTiles(arg('tiles', 1), name);
      if (typeof tiles === 'string') return fail(tiles);
      return { ok: true, command: { kind: name, dir, tiles } };
    }
    case 'walk_to_edge': {
      const dir = side(arg('dir', 0), name);
      if (dir !== 'left' && dir !== 'right') return fail(dir);
      return { ok: true, command: { kind: name, dir } };
    }
    case 'walk_to': {
      const id = target();
      if (!id) return fail('walk_to needs something to walk to, like walk_to(C1) or walk_to(X)');
      return { ok: true, command: { kind: name, target: id } };
    }
    case 'jump': {
      const dir = arg('dir', 0) ?? 'up';
      if (dir !== 'left' && dir !== 'right' && dir !== 'up') return fail(`jump needs left, right or up (got "${dir}")`);
      const runUp = Number(arg('run_up', 1) ?? named.get('runup') ?? 0);
      if (!Number.isInteger(runUp) || runUp < 0 || runUp > 3) return fail('jump run_up is 0, 1, 2 or 3 tiles');
      if (dir === 'up' && runUp > 0) return fail('a run-up needs a direction: jump(left, ...) or jump(right, ...)');
      const hold = arg('hold', 2) ?? 'full';
      if (hold !== 'short' && hold !== 'full') return fail(`jump hold is short or full (got "${hold}")`);
      return { ok: true, command: { kind: 'jump', dir, runUp: runUp as 0 | 1 | 2 | 3, hold } };
    }
    case 'climb': {
      const dir = arg('dir', 0);
      if (dir !== 'up' && dir !== 'down') return fail(`climb needs up or down${dir ? ` (got "${dir}")` : ''}`);
      return { ok: true, command: { kind: 'climb', dir } };
    }
    case 'drop':
    case 'wait':
      return { ok: true, command: { kind: name } };
    case 'pull_lever':
    case 'hold_lever':
    case 'stand_on_plate':
    case 'enter_exit':
      return { ok: true, command: { kind: name, target: target() } };
    case 'trip':
    case 'steal':
    case 'boost':
    case 'swap':
    case 'hop_over':
    case 'push_past':
    case 'shove': {
      const id = target();
      if (!id) return fail(`${name} needs a bot, like ${name}(B)`);
      return { ok: true, command: { kind: name, target: id } };
    }
    case 'crouch':
    case 'stand':
      return { ok: true, command: { kind: name } };
    case 'give': {
      const id = (named.get('target') ?? named.get('bot') ?? positional[0])?.toUpperCase();
      const n = Number(named.get('coins') ?? positional[1] ?? 1);
      if (!id) return fail('give needs a bot and a number of coins, like give(B, 2)');
      if (!Number.isInteger(n) || n < 1) return fail(`give needs a whole number of coins, 1 or more (got "${named.get('coins') ?? positional[1]}")`);
      return { ok: true, command: { kind: 'give', target: id, coins: n } };
    }
    case 'block':
      return { ok: true, command: { kind: 'block' } };
    default:
      if (NOT_YET.has(name)) return fail(`"${name}" isn't part of the game yet`);
      if (NOT_COMMANDS.has(name)) return fail(`"${name}" isn't a command: it goes in social_actions or rule_actions`);
      return fail(`unknown command "${name}". Commands: ${Object.keys(COMMAND_HELP).join(', ')}`);
  }
}

/** The command as canonical text. */
export function formatCommand(c: Command): string {
  switch (c.kind) {
    case 'walk':
    case 'creep':
    case 'push':
      return `${c.kind}(${c.dir}, ${c.tiles})`;
    case 'walk_to_edge':
      return `${c.kind}(${c.dir})`;
    case 'walk_to':
      return `walk_to(${c.target})`;
    case 'jump':
      return `jump(${c.dir}, run_up=${c.runUp}, hold=${c.hold})`;
    case 'climb':
      return `climb(${c.dir})`;
    case 'drop':
    case 'wait':
      return c.kind;
    case 'pull_lever':
    case 'hold_lever':
    case 'stand_on_plate':
    case 'enter_exit':
      return c.target ? `${c.kind}(${c.target})` : c.kind;
    case 'trip':
    case 'steal':
    case 'boost':
    case 'swap':
    case 'hop_over':
    case 'push_past':
    case 'shove':
      return `${c.kind}(${c.target})`;
    case 'crouch':
    case 'stand':
      return c.kind;
    case 'give':
      return `give(${c.target}, ${c.coins})`;
    case 'block':
      return 'block';
  }
}
