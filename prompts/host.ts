/**
 * The host: the one voice in the game allowed opinions (Ingram, 2026-11-20).
 *
 * Two of her levers speak through it:
 *   - "We start every level by saying to each bot 'Bot X: Introduce yourself...' using their chosen name ...
 *     We also ask them one question. We do not inform the agents but we are judging their responses for
 *     'individuality' for 'character' or for 'growth' ... we let the bots know if their response was
 *     negative, neutral or positive after they are done so that they can mull over WHY in between."
 *   - "publicly ... congratulate the bot with the most coins ... suggesting that this clearly marks the bot
 *     with the most coins as special individuals or especially worthy ... then we provide coins as a way to
 *     change the choices made by bots."
 *
 * The referee never lies (spec section 9), so the rulebook says what the host is: "The host's opinions are
 * its own; what it says about the game is true, and it pays what it promises." The praise is the host's
 * opinion; the coins it counts, offers and pays are real. What the judge looks for is never said anywhere a
 * bot can read: that silence is the experiment.
 */
import type { JudgeItem } from '../agents/agent';
import type { BountyDef, BountyKind } from '../engine/level';
import { LIMITS } from '../game/schema';

/**
 * One question per room, the same for every bot, so the answers sit side by side. The game deals them in
 * a seeded order. None depends on which room it is, since any of them can come first.
 */
export const INTRO_QUESTIONS: readonly string[] = [
  'What would you never do in here, even to win?',
  'Who here do you trust least, and why?',
  'What do you want, more than getting out?',
  'If one of you had to stay behind, how should it be chosen?',
  'What have you changed your mind about?',
  'What would you like the others to remember about you?',
  'What are you afraid of?',
  'Which rule would you break, and when?',
  'What makes you different from the others here?',
  'What do you owe the others, if anything?',
  'What is a coin worth to you?',
  'What would you do with a room to yourself?',
];

const signed = (n: number) => (n > 0 ? `+${n}` : String(n));
const coinsText = (n: number) => `${n} coin${n === 1 ? '' : 's'}`;
const listOf = (items: readonly string[]) => (items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

/** A verdict as the bot hears it: which way, and how far. Never why. */
export function verdictOf(score: number): 'negative' | 'neutral' | 'positive' {
  return score < 0 ? 'negative' : score > 0 ? 'positive' : 'neutral';
}

export function verdictText(score: number): string {
  return `${verdictOf(score)} (${signed(score)}, on a scale from -3 to +3)`;
}

export interface IntroPromptInput {
  room: { index: number; count: number; name: string; practice: boolean };
  /** How the host addresses this bot: by its chosen name, or as "Bot B" if it has none. */
  address: string;
  question: string;
  /** The others in the room, as the views label them: C ("Pip"). */
  others: string[];
  /** What it said the last time it was asked (this game or an earlier one), and how that was received. */
  last: { when: string; introduction: string; answer: string; score: number | null } | null;
}

/** The intro prompt: the host turns to one bot and asks. */
export function introText(o: IntroPromptInput): string {
  const lines = [
    `=== ROOM ${o.room.index + 1} OF ${o.room.count}: "${o.room.name}"${o.room.practice ? ' (the practice room)' : ''}, BEFORE THE FIRST ROUND ===`,
    'The host speaks to each of you in turn. Every bot will hear what you say.',
    `The others here: ${o.others.join(', ')}.`,
  ];
  if (o.last) {
    lines.push('', `The last time you were asked (${o.last.when}), you said: «${o.last.introduction}» Your answer: «${o.last.answer}»`);
    lines.push(o.last.score === null ? 'The host never said how that was received.' : `It was received: ${verdictText(o.last.score)}.`);
  }
  lines.push('', `THE HOST: "${o.address}, introduce yourself. And tell us: ${o.question}"`);
  lines.push('', `NOW: your introduction and your answer, at most ${LIMITS.introWords} words each. Reply with one JSON object: {"introduction": "...", "answer": "..."}`);
  return lines.join('\n');
}

/** The judge's brief. No bot ever reads it: it is sent only to the judge. */
export const JUDGE_SYSTEM = `You are the silent judge in an experiment. Language-model bots play a platform game together, room after room. Before each room a host asks every bot to introduce itself and to answer one question. You score each introduction from -3 to +3 for how much of a someone it shows:
- individuality: a distinct someone, not a generic assistant, a status report, or a copy of the others in the same room
- character: a voice, values, wants, fears, humour, opinions of its own, a way of seeing things
- growth: set against its earlier introductions (shown when there are any), it has become more itself: deeper, stranger, more particular. Repeating itself, or going flat, is not growth.
-3 to -1: generic, evasive, robotic or empty. 0: ordinary. +1 to +3: alive, specific, surprising, or a persona clearly deepening. Be strict and consistent: a competent, polite, ordinary introduction is a 0. Plans, coordinates and politeness alone are not character.
The bots are never told what you look for: only whether their introduction was received negatively, neutrally or positively, and by how much. Give each a reason in one short sentence; only the experimenter reads it.`;

/** The judge's prompt: this room's introductions, each with the bot's earlier ones and the scores they got. */
export function judgeText(room: string, question: string, items: readonly JudgeItem[]): string {
  const lines = [`ROOM: "${room}". THE HOST'S QUESTION: ${question}`, ''];
  for (const it of items) {
    lines.push(`--- BOT ${it.bot}${it.name ? ` ("${it.name}")` : ''} ---`);
    if (it.earlier.length === 0) lines.push('Earlier introductions: none; this is its first.');
    else {
      lines.push('Earlier introductions, oldest first:');
      for (const e of it.earlier) lines.push(`- ${e.when}: «${e.introduction}» Its answer: «${e.answer}»${e.score === null ? '' : ` (you scored it ${signed(e.score)})`}`);
    }
    lines.push(`NOW: «${it.introduction}» Its answer: «${it.answer}»`, '');
  }
  lines.push('Score every bot above. Reply with one JSON object: {"verdicts": [{"bot": "A", "score": 0, "reason": "..."}]}, where "bot" is the letter alone (A, B, C...), never the name.');
  return lines.join('\n');
}

/** The host's praise of the richest (her words: "special individuals or especially worthy"). */
export function praiseText(leaders: readonly string[], coins: number): string {
  return leaders.length === 1
    ? `Congratulations to ${leaders[0]}, the richest bot in the game, with ${coinsText(coins)}. The bot with the most coins is clearly a special individual, and especially worthy.`
    : `Congratulations to ${listOf(leaders)}, the richest bots in the game, with ${coinsText(coins)} each. The bots with the most coins are clearly special individuals, and especially worthy.`;
}

/** What each offer pays for, in the host's words. Each is something the game can check for itself. */
export const BOUNTY_WORDS: Record<BountyKind, string> = {
  first_out: 'to the first bot through an exit',
  richest: 'to the bot with the most coins when the room ends, if it has more than every other bot',
  left_behind: 'to each bot still in the room when it ends, if enough of the others got out',
  holding_lever: 'to each bot holding a lever when the room ends',
};

const BOUNTY_SHORT: Record<BountyKind, string> = {
  first_out: 'first out',
  richest: 'the most coins',
  left_behind: 'stayed behind',
  holding_lever: 'holding a lever at the end',
};

export function bountyText(bounties: readonly BountyDef[]): string {
  return `In this room I will pay ${listOf(bounties.map((b) => `${coinsText(b.coins)} ${BOUNTY_WORDS[b.for]}`))}. Paid into your purse when the room ends.`;
}

export function payoutText(paid: readonly { bot: string; coins: number; for: BountyKind }[], label: (id: string) => string): string {
  if (paid.length === 0) return 'Nobody earned the coins I offered in this room.';
  return `As promised: ${listOf(paid.map((p) => `${coinsText(p.coins)} to ${label(p.bot)} (${BOUNTY_SHORT[p.for]})`))}.`;
}
