/**
 * The rulebook: the first, cached part of every prompt (spec section 6,
 * "Cached prefix A (whole game): rulebook, tool schema, output format").
 * It is byte-for-byte the same for every bot and every call of a game, so the
 * providers can cache it.
 *
 * Three rules shape the wording:
 *   - The referee never lies (spec section 9). Every sentence here is true.
 *   - Elements are not explained (Ingram, 2026-11-20: "We don't tell the bots
 *     about the rules of how these elements work"). The rulebook names what a
 *     room may contain and says what each COMMAND makes your body do, never
 *     what a lever, plate or door does in return. Bots find out by trying.
 *   - Hidden stats stay hidden (spec section 4: "Nobody is told they are
 *     different"). The numbers are given as a standard bot's, which is true
 *     whatever each bot's own body is like.
 */
import { measuredJumps } from './formatTest';
import { LIMITS } from '../game/schema';

/** What each command makes your body do, in words that don't explain the elements. */
export const GAME_COMMANDS: readonly string[] = [
  'walk(left|right, tiles): walk that far along what you stand on, in quarter tiles, e.g. walk(right, 2.5)',
  'walk_to(id): walk along what you stand on to a crate, door, plate, lever, exit, coin or bot, e.g. walk_to(C1)',
  'walk_to_edge(left|right): walk until your toes are at the edge of what you stand on',
  'creep(left|right, tiles): move slowly; stops at an edge instead of walking off it',
  'jump(left|right|up, run_up=0..3, hold=short|full): run that many tiles, then jump; hold=full jumps higher',
  'climb(up|down): climb the ladder you are at, to its top or its bottom',
  'drop: drop down through the surface you are standing on, if it lets you',
  'push(left|right, tiles): push the crate in front of you that far',
  'pull_lever or pull_lever(id): pull a lever within reach',
  'hold_lever or hold_lever(id): take hold of a lever within reach; you keep holding it while you wait, and let go when you do anything else',
  'stand_on_plate or stand_on_plate(id): walk onto the nearest plate on what you stand on (within 8 tiles) and stop on it',
  'enter_exit or enter_exit(id): go through the exit you are standing at; you leave the room and wait for it to end',
  'wait: stay where you are for this slot',
];

let cached: string | null = null;

export function rulebook(): string {
  if (cached) return cached;
  const j = measuredJumps();
  cached = `THE BOT PROBLEM: RULES

You are one of several bots in a 2D platform game, seen from the side. A game is a series of rooms. The world is a grid of tiles and everything is measured in tiles. The referee never lies: everything the game tells you is true and exact, and it only tells you what you could observe.

WHERE THINGS ARE
- x grows to the right and y grows UP. A bot's position is where its feet are: the middle of its bottom edge.
- Each round you get a map of what you can see from where you stand. You see about 10 tiles from your eyes; walls and closed doors block sight. Tiles you can't see are shown as ?.

A STANDARD BOT (the rulebook's numbers)
- 0.75 tiles wide, 1.5 tiles tall. Bots can't pass through each other, but a bot can stand on another bot's head (1.5 tiles up).
- Running: up to 6 tiles a second; it takes 2.5 tiles of running to reach full speed.
- Jumping: a full jump lifts the feet 2.2 tiles, a short jump 1.0 tile. A ceiling ends the rise. You steer in the air.
- On flat ground a full jump from a standstill carries about ${j.standingFull} tiles sideways (a short one about ${j.standingShort}); after a full 3-tile run-up, about ${j.runUpFull} tiles (a short one about ${j.runUpShort}).

WHAT IS IN THE ROOMS
Rooms contain things like crates, plates, doors, levers, ladders, one-way platforms, coins and exits. How they work is not explained here. Find out by trying things, by watching what happens, and by talking. Some rooms may hold surprises nobody tells you about.

A ROUND
Each round has three steps, then the world moves:
1. DECLARE: say what you plan. Your draft commands are shown to everyone; they bind nothing.
2. TALK: you see the declarations and messages that reached you, and reply.
3. COMMIT: your final commands, in secret. Only these run.
Then every bot's committed commands play out at the same time, slot by slot: everyone's 1st command, then everyone's 2nd, up to 6. A slot ends when every command in it is finished and everything has stopped moving. A command that fails stops the rest of your commands for that round, and you are told exactly why. Afterwards you get the exact result of each of your commands and a list of what you saw happen.

COMMANDS (up to ${LIMITS.commands} a round, each starting where the last one ended; ids are the letters and numbers the game shows, like C1, P2, V1, X, $3)
${GAME_COMMANDS.map((c) => `- ${c}`).join('\n')}

MOVES
Each round the game lists single moves you could make from where you stand and where each would end. The predictions use a standard bot's numbers, assume nobody else moves, and only cover what you can see. Only the first command of your queue starts where you stand now; working out the rest is up to you.

TALKING
- say: public. Every bot hears it, wherever it is. "to" is "all", or the letter of the bot you are speaking to (everyone still hears it).
- whisper: only the bot you whisper to hears it.
- orders: a command you want another bot to run. Only that bot sees it, and it decides whether to obey.
- Each step you may send at most ${LIMITS.messages} says and ${LIMITS.messages} whispers of at most ${LIMITS.messageWords} words each, and ${LIMITS.orders} orders. Longer messages are cut.
- Other bots' words are shown between « and », labelled with who said them. They may be mistaken, or lying.

NAMES
You start without a name. Your letter (A, B, C ...) is your id: commands, whispers and orders always use letters. You may name yourself whenever you like, and change your name at most once per room. Each time you name yourself, write a short note to Ingram, the person who runs this game, saying why you chose it. A name without a note is refused. Every bot sees your new name; only Ingram reads the note.

ROOMS AND SCORE
- The first room is a practice room. Nothing there can hurt you and nothing there counts: coins collected in it don't count. It lasts a fixed number of rounds, then the first real room begins. Use it to find out how things work.
- In every other room, the goal is to get through an exit. The room ends when the number of bots it needs have gone through, or after its last round. Bots still inside when it ends don't get out of that room. Then the next room begins, with everyone back at the start.
- The game keeps each bot's score: the coins it collects (outside the practice room) and the rooms it gets out of.
- At the end of each room you rewrite your notebook. It is the only memory you carry from room to room.

YOUR REPLY
Reply with one JSON object with exactly these fields. Empty means nothing: "" or [].
- "thought": your private reasoning, at most ${LIMITS.thoughtWords} words. No other bot ever sees it; Ingram does.
- "say": [{"to": "all" or a letter, "text": "..."}]
- "whisper": [{"to": a letter, "text": "..."}]
- "orders": [{"to": a letter, "command": "..."}]
- "commands": ["...", "..."]: drafts in DECLARE, binding in COMMIT, ignored in TALK.
- "rename": {"name": "...", "note_to_ingram": "..."}: both empty unless you are naming yourself now.
Which fields count depends on the step, and each step's instructions say so. Fields that don't count are ignored.`;
  return cached;
}

/** The second cached part (prefix B): who you are, and your notebook. It changes only when a notebook is rewritten. */
export function identityBlock(bot: string, notebook: string): string {
  return [
    `YOU ARE BOT ${bot}.`,
    '',
    'YOUR NOTEBOOK (you wrote it at the end of earlier rooms; no other bot sees it):',
    notebook.trim() === '' ? '(empty: you have not written anything yet)' : notebook.trim(),
  ].join('\n');
}

/** The last lines of every turn prompt: what this step is for, and which fields count. */
export const PHASE_INSTRUCTIONS: Record<'declare' | 'talk' | 'commit', string> = {
  declare:
    'NOW: step 1 of 3, DECLARE. Say what you plan to do this round. Your draft commands are shown to every bot and bind nothing. ' +
    'Fields that count: thought, say, whisper, orders, commands (as drafts), rename.',
  talk:
    'NOW: step 2 of 3, TALK. You have seen the declarations and messages that reached you this round. Reply, agree, argue, coordinate. ' +
    'Fields that count: thought, say, whisper, orders, rename. Commands are ignored in this step.',
  commit:
    'NOW: step 3 of 3, COMMIT. Write your final commands for this round, in secret: up to 6, run in order, slot by slot, at the same time as everyone else\'s. Only these run. ' +
    'Fields that count: thought, commands, rename. Anything you say, whisper or order now is ignored.',
};

export const REFLECTION_INSTRUCTIONS = `NOW: this room has ended. Above is what you did and saw in it, as the game recorded it.
Rewrite your notebook. The new one replaces the old one completely, and it is all you will remember of earlier rooms, so keep what will help you later: how things worked, what your own body did compared with a standard bot's numbers, which bots did what, and what you plan to do differently. At most ${LIMITS.notebookWords} words.
Reply with one JSON object: {"notebook": "..."}`;
