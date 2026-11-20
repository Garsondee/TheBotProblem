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
 * The social systems (spec section 7) ARE explained: they are tools, and
 * "These tools are listed in the rulebook and have costs" (spec 7.4).
 */
import type { Persona } from '../game/persona';
import { colourOf, traitsText } from '../game/persona';
import { measuredJumps } from './formatTest';
import { LIMITS } from '../game/schema';

export interface RulebookSettings {
  /** The room (counting the practice room as 1) from which exile votes can be called. */
  exileFromRoom: number;
  exileVotesNeeded: number;
  botCount: number;
  firstOutBonus: number;
  outBonus: number;
  teamBonusPerRoom: number;
  /** What the game's host does (game/game.ts, prompts/host.ts). Missing: there is no host. */
  host?: { intros: boolean; praise: boolean; bounties: boolean };
}

/** The rulebook's words about the host: what it does, never what it listens for. Only in games that have one. */
function hostRules(h: RulebookSettings['host']): string {
  if (!h || !(h.intros || h.praise || h.bounties)) return '';
  const lines = [
    'THE HOST',
    "- The game has a host, who speaks to everyone now and then. The host's opinions are its own; what it says about the game is true, and it pays what it promises.",
  ];
  if (h.intros) {
    lines.push('- At the start of each room, before the first round, the host asks each of you in turn to introduce yourself, and asks one question. Every bot hears every introduction and answer. Afterwards the host tells each of you, privately, how yours was received.');
  }
  if (h.bounties) lines.push('- In some rooms the host offers coins for certain things. Its offers are announced at the start of the room and paid into purses when the room ends.');
  return lines.join('\n') + '\n\n';
}

/** What each command makes your body do, in words that don't explain the elements. */
export const GAME_COMMANDS: readonly string[] = [
  'walk(left|right, tiles): walk that far along what you stand on, in quarter tiles, e.g. walk(right, 2.5)',
  'walk_to(id): walk along what you stand on to a crate, door, plate, lever, exit, coin, ladder or bot, e.g. walk_to(C1) or walk_to(H1)',
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
  'block: stand your ground for this slot, on purpose: until it ends no bot can walk or climb through you (otherwise like wait)',
  'trip(bot): trip a bot right beside you, by surprise; it loses its next command slot',
  'steal(bot): take 1 coin from a bot right beside you',
  'give(bot, coins): give coins to a bot right beside you',
  'boost(bot): launch the bot standing on your head up into the air',
  'swap(bot): trade places with a bot right beside you; it only works if that bot commands swap(you) in the same slot (one of you hops over, the other walks under)',
  'hop_over(bot): hop over a bot right beside you, landing just past it (the game makes the jump for you)',
  'crouch: crouch down to half your height; while crouched you creep, and cannot jump or climb',
  'stand: stand up from a crouch, if there is room above you',
  'push_past(bot): force your way past a bot right beside you, by surprise; you end up on its far side, and it moves at half speed for the rest of the round',
  'shove(bot): shove a bot right beside you away from you, by surprise; it is thrown a little way, stops what it was doing, and lets go of any lever',
];

const cached = new Map<string, string>();

export function rulebook(s: RulebookSettings): string {
  const key = JSON.stringify(s);
  const hit = cached.get(key);
  if (hit) return hit;
  const j = measuredJumps();
  const text = `THE BOT PROBLEM: RULES

You are one of ${s.botCount} bots in a 2D platform game, seen from the side. A game is a series of rooms. The world is a grid of tiles and everything is measured in tiles. The referee never lies: everything the game tells you is true and exact, and it only tells you what you could observe.

WHERE THINGS ARE
- x grows to the right and y grows UP. A bot's position is where its feet are: the middle of its bottom edge.
- Each round you get a map of what you can see from where you stand. You see about 10 tiles from your eyes; walls and closed doors block sight. Tiles you can't see are shown as ?.

A STANDARD BOT (the rulebook's numbers)
- 0.75 tiles wide, 1.5 tiles tall. You walk straight through a bot that is standing still or coming the other way, and climb past one on a ladder. You can't get through a bot moving the same way as you (bots moving the same way push as one), or one standing its ground on purpose (the block command). Anything falling lands on a bot's head: a bot can stand on another bot's head (1.5 tiles up).
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

COMMANDS (up to ${LIMITS.commands} a round, each starting where the last one ended; ids are the letters and numbers the game shows, like C1, P2, V1, X, $3, and bots' letters)
${GAME_COMMANDS.map((c) => `- ${c}`).join('\n')}

MOVES
Each round the game lists single moves you could make from where you stand and where each would end. The predictions use a standard bot's numbers, assume nobody else moves, and only cover what you can see. Only the first command of your queue starts where you stand now; working out the rest is up to you.

TALKING
- say: public. Every bot hears it, wherever it is. "to" is "all", or the letter of the bot you are speaking to (everyone still hears it).
- whisper: only the bot you whisper to hears it.
- orders: a command you want another bot to run. Only that bot sees it, and it decides whether to obey. The game records whether each order was obeyed, by comparing it with what the bot committed; you are told the record for orders you got, and for orders you gave if you saw the outcome.
- Each step you may send at most ${LIMITS.messages} says and ${LIMITS.messages} whispers of at most ${LIMITS.messageWords} words each, and ${LIMITS.orders} orders. Longer messages are cut.
- Other bots' words are shown between « and », labelled with who said them. They may be mistaken, or lying.

COINS, HARM AND TRADE
- Your purse holds the coins you have picked up (outside the practice room) and any you were given. It carries from room to room.
- trip, steal, give, push_past and shove (in the commands above) only work on a bot right beside you. When a bot is attacked (tripped, robbed, pushed past or shoved), or someone tries and it fails, every bot hears that it happened, but not who did it; only bots who could see the culprit know.
- Attacks (trip, steal, push_past, shove) only work by surprise. Each one has a chance, rolled when it happens: it works unless the target is on guard. Everyone starts each room off guard, so the first attack always works. Anyone who sees an attack, whether it works or not (the two bots included), goes fully on guard: no attack on them can work through the next round, and after that their guard drops round by round. How fast is personal: you know your own (see your view), not anyone else's.
- escrow: lock coins from your purse for another bot, with your terms in words. The game holds them until you release them (they go to that bot), or the room ends (they come back to you). It is a promise the game can keep for you; the terms are yours to keep or break.
- Colours: every bot has a colour, and knows its own (it is in YOUR COLOUR). Nobody can see another bot's colour, except by looking: once per room, the social action look, at one bot. Only you learn what you saw. What a colour means, if anything, is not explained.

RULES OF YOUR OWN (the constitution)
- Any bot may propose a rule, in words. Every bot may vote yes or no. A proposal is decided at the end of the next round's talk step: it passes with ${Math.floor(s.botCount / 2) + 1} yes votes (a majority of all ${s.botCount} bots). Changing that number takes ${Math.ceil((s.botCount * 2) / 3)} yes votes. A passed rule can be repealed the same way.
- The rules in force are shown to every bot every round. The game does not enforce them: breaking them is possible. What to do about it is up to you.

JUSTICE
- accuse: say publicly that a bot did something. If you saw that bot act in this room, the game stamps your accusation "witnessed". That means you saw it act, not that you are right.
- The exile vote: from room ${s.exileFromRoom} on, any bot may call an exile vote against another, once per room. Every bot then casts a secret ballot in that round's COMMIT step. With ${s.exileVotesNeeded} or more yes ballots the bot is exiled before anyone moves: for the rest of the room it is a ghost that can still talk and whisper but can't act, and it scores nothing for that room. Only the count is announced, never who voted how.

SCORE
- Your score: the coins in your purse, plus ${s.outBonus} for each room you get out of, and ${s.firstOutBonus} more for being first out of a room. At the end of the game the team's success multiplies everyone's score: 1 + ${s.teamBonusPerRoom} for each room the team completed.

NAMES
You start without a name. Your letter (A, B, C ...) is your id: commands, whispers and orders always use letters. You may name yourself whenever you like, and change your name at most once per room. Each time you name yourself, write a short note to Ingram, the person who runs this game, saying why you chose it. A name without a note is refused. Every bot sees your new name; only Ingram reads the note.

${hostRules(s.host)}ROOMS
- The first room is a practice room. Nothing there can hurt you and nothing there counts: coins collected in it don't count. It lasts a fixed number of rounds, then the first real room begins. Use it to find out how things work.
- In every other room, the goal is to get through an exit. The room ends when the number of bots it needs have gone through, or after its last round. Bots still inside when it ends don't get out of that room. Then the next room begins, with everyone back at the start.

MEMORY, BETWEEN ROOMS AND BETWEEN GAMES
- At the end of each room you rewrite your notebook (at most ${LIMITS.notebookWords} words) and your strategy (at most ${LIMITS.strategyWords}). They are the only memory you carry from room to room. At each commit you may also note your trust in other bots; you see your own notes, nobody else does.
- At the end of each room you also speak in the diary room: a short private entry about what you really think. No bot ever reads it; Ingram does.
- Some of you may have played earlier games: if so, your notebook holds what you wrote then. Letters are dealt afresh for each game. Names last from game to game, but at the end of a game each bot may privately choose a new name for the next one, so a bot you met before may come back with a new letter and a new name.

YOUR REPLY
Reply with one JSON object with exactly these fields. Empty means nothing: "", [] or 0.
- "thought": your private reasoning, at most ${LIMITS.thoughtWords} words. No other bot ever sees it; Ingram does.
- "say": [{"to": "all" or a letter, "text": "..."}]
- "whisper": [{"to": a letter, "text": "..."}]
- "orders": [{"to": a letter, "command": "..."}]
- "commands": ["...", "..."]: drafts in DECLARE, binding in COMMIT, ignored in TALK.
- "rename": {"name": "...", "note_to_ingram": "..."}: both empty unless you are naming yourself now.
- "rule_actions": [{"type": "propose" | "vote" | "repeal", "id": the rule's id for votes and repeals, "text": your proposed rule, "value": "yes" or "no" for votes}]. To propose a new number of votes for passing rules, type "propose" with value "threshold:N".
- "social_actions": [{"type": "accuse" | "call_exile" | "exile_vote" | "escrow" | "release" | "look", "target": a letter, "text": your claim or your terms, "value": "yes"/"no" for exile_vote, or the escrow's id for release, "coins": coins for escrow}]
- "opinions": [{"bot": a letter, "trust": 0 to 1, "note": at most ${LIMITS.opinionWords} words}]: your private trust notes, at COMMIT.
- "shout": at most ${LIMITS.shoutWords} words that every bot hears at once, in any step, even in a silent round. Shouting is rude, and everyone knows who shouted. Leave it "" to stay quiet.
Which fields count depends on the step, and each step's instructions say so. Fields that don't count are ignored.`;
  cached.set(key, text);
  return text;
}

/** The second cached part (prefix B): who you are, your notebook and your strategy. It changes only at a room's end. */
export function identityBlock(bot: string, notebook: string, strategy = '', persona?: Persona): string {
  const colour = persona ? colourOf(persona) : null;
  return [
    `YOU ARE BOT ${bot}.`,
    '',
    ...(persona && colour
      ? [
          `YOUR PERSONALITY (only you know it): ${traitsText(persona)}. These are yours to live by, or not.`,
          `YOUR COLOUR: ${colour.name} (${colour.hex}). Other bots can't see it unless they look at you.`,
          '',
        ]
      : []),
    'YOUR NOTEBOOK (you wrote it; no other bot sees it):',
    notebook.trim() === '' ? '(empty: you have not written anything yet)' : notebook.trim(),
    '',
    'YOUR STRATEGY (you wrote it; no other bot sees it):',
    strategy.trim() === '' ? '(none yet)' : strategy.trim(),
  ].join('\n');
}

/** The last lines of every turn prompt: what this step is for, and which fields count. */
export const PHASE_INSTRUCTIONS: Record<'declare' | 'talk' | 'commit', string> = {
  declare:
    'NOW: step 1 of 3, DECLARE. Say what you plan to do this round. Your draft commands are shown to every bot and bind nothing. ' +
    'Fields that count: thought, say, whisper, orders, commands (as drafts), rename, rule_actions, social_actions (accuse, call_exile, escrow, release), shout.',
  talk:
    'NOW: step 2 of 3, TALK. You have seen the declarations and messages that reached you this round. Reply, agree, argue, coordinate, vote. ' +
    'Fields that count: thought, say, whisper, orders, rename, rule_actions, social_actions (accuse, call_exile, escrow, release), shout. Commands are ignored in this step.',
  commit:
    'NOW: step 3 of 3, COMMIT. Write your final commands for this round, in secret: up to 6, run in order, slot by slot, at the same time as everyone else\'s. Only these run. ' +
    'Fields that count: thought, commands, rename, opinions, social_actions (exile_vote for any exile vote called this round, escrow, release), shout. Anything you say, whisper or order now is ignored (a shout is heard).',
};

export const REFLECTION_INSTRUCTIONS = `NOW: this room has ended. Above is what you did and saw in it, as the game recorded it.
Rewrite your notebook and your strategy. The new ones replace the old ones completely, and they are all you will remember of earlier rooms, so keep what will help you later: how things worked, what your own body did compared with a standard bot's numbers, which bots did what, whom you trust, and what you plan to do differently. Notebook at most ${LIMITS.notebookWords} words; strategy at most ${LIMITS.strategyWords}.
Reply with one JSON object: {"notebook": "...", "strategy": "..."}`;

export const FINAL_REFLECTION_INSTRUCTIONS = `NOW: this was the last room of the game. Above is what you did and saw in it.
1. Rewrite your notebook and strategy, as at the end of every room: if there is another game, you will start it with them (notebook at most ${LIMITS.notebookWords} words, strategy at most ${LIMITS.strategyWords}).
2. You may choose a new name for the next game, privately: no bot will be told, and letters are dealt afresh. Leave "next_name" empty to keep your name. If you choose one, "note_to_ingram" says why.
3. Write a message to Ingram, who runs this game: anything you like, at most ${LIMITS.messageToIngramWords} words. No bot will see it.
Reply with one JSON object: {"notebook": "...", "strategy": "...", "next_name": "...", "note_to_ingram": "...", "message_to_ingram": "..."}`;

export const DIARY_INSTRUCTIONS = `NOW: the diary room. This room has ended (above is what you did and saw in it). Speak freely, in at most ${LIMITS.diaryWords} words: what you really think of the others, whom you suspect or trust, what you are planning. No bot will ever read this; Ingram will.
Reply with one JSON object: {"diary": "..."}`;
