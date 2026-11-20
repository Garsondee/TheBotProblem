/**
 * summary.md: a game told briefly, for Ingram. Which rooms were played and how
 * they ended, every name a bot chose with its note to her (2026-11-20: "I
 * would like to be told when this happens by them"), the scores, what the
 * social systems saw (rules, exiles, accusations, trades, orders), and the
 * private side: the diary room, each bot's message to her and the name it
 * chose secretly for the next game. Spoilers (the hidden stats nobody in the
 * game was told) come last.
 *
 * Built only from the game's own result and log, so it never costs anything.
 */
import type { BotStats } from '../engine/stats';
import { STAT_NAMES } from '../engine/stats';
import type { GameEvent } from './events';
import type { GameResult } from './game';

export interface SummaryContext {
  runId: string;
  seed: string;
  seats: { bot: string; provider: string; model: string }[];
  costLine: string | null;
  /** The team bonus per completed room (spec 7.5), for explaining the totals. */
  teamBonusPerRoom?: number;
}

const pct = (thousandths: number) => {
  const p = (thousandths - 1000) / 10;
  return `${p > 0 ? '+' : ''}${p.toFixed(1)}%`;
};

/** Text for a table cell or a quote: one line, pipes escaped. */
const cell = (text: string) => text.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();

type Of<T extends GameEvent['type']> = Extract<GameEvent, { type: T }>;
const ofType = <T extends GameEvent['type']>(events: readonly GameEvent[], type: T) => events.filter((e): e is Of<T> => e.type === type);

export function summaryMarkdown(result: GameResult, ctx: SummaryContext): string {
  const label = (bot: string) => (result.names[bot] ? `${bot} (${result.names[bot]})` : bot);
  const roomOf = (e: GameEvent) => `room ${e.levelIndex + 1}, round ${e.round}`;
  const ev = result.events;
  const lines: string[] = [
    `# Game ${ctx.runId}`,
    '',
    `Seed \`${ctx.seed}\`. ${result.completed ? 'Played to the end.' : `Stopped early: ${result.stopReason ?? 'unknown reason'}`}`,
    `${result.calls} model calls; ${result.malformed} unusable replies.${ctx.costLine ? ` ${ctx.costLine}` : ''}`,
    '',
    '## Rooms',
    '',
    '| Room | Rounds | Ended because | Through the exit |',
    '|---|---|---|---|',
    ...result.rooms.map((r) => `| ${r.id}${r.kind === 'practice' ? ' (practice)' : ''} | ${r.roundsPlayed} | ${r.reason} | ${r.through.join(', ') || 'nobody'} |`),
    '',
    '## Names, and the notes the bots wrote to Ingram',
    '',
    ...(result.nameChanges.length === 0
      ? ['Nobody named itself.']
      : result.nameChanges.map(
          (c) =>
            `- Room ${c.levelIndex + 1} (${c.level}), round ${c.round}, ${c.phase}: **${c.bot}** ${c.previous ? `renamed itself from "${c.previous}" to` : 'named itself'} **"${c.name}"**. Note: "${c.note}"`,
        )),
    '',
    '## Scores',
    '',
    `Coins in the purse plus points for getting out of rooms, multiplied by the team's success: ${result.team.roomsCompleted} room${result.team.roomsCompleted === 1 ? '' : 's'} completed${ctx.teamBonusPerRoom !== undefined ? `, so ×${(1 + ctx.teamBonusPerRoom * result.team.roomsCompleted).toFixed(1)}` : ''}.`,
    '',
    '| Bot | Name | Seat | Coins | Exit points | Rooms escaped | First out | Total |',
    '|---|---|---|---|---|---|---|---|',
    ...ctx.seats.map((s) => {
      const score = result.scores[s.bot];
      return `| ${s.bot} | ${result.names[s.bot] ?? '(no name)'} | ${s.model} | ${score?.coins ?? 0} | ${score?.exitPoints ?? 0} | ${score?.roomsEscaped ?? 0} | ${score?.firstOut ?? 0} | **${score?.total ?? 0}** |`;
    }),
    '',
  ];

  // ---- The social systems (spec 7.1-7.4), counted from the log.
  const rules = ofType(ev, 'rule');
  const exiles = ofType(ev, 'exile_result');
  const accusations = ofType(ev, 'accusation');
  const escrows = ofType(ev, 'escrow');
  const verdicts = ofType(ev, 'obedience');
  const gaps = ofType(ev, 'gap').filter((g) => !g.kept && g.planned.length > 0);
  const harm = ev.flatMap((e) => (e.type === 'world' && e.event.type === 'social' ? [e.event] : []));
  lines.push('## The social side', '');
  const social: string[] = [];
  const proposed = rules.filter((r) => r.action === 'proposed');
  if (proposed.length > 0) {
    social.push(`**Constitution:** ${proposed.length} proposal${proposed.length === 1 ? '' : 's'}.`);
    for (const r of rules.filter((x) => x.action !== 'proposed')) social.push(`- ${r.rule} ${r.action} (${r.yes} yes, ${r.no} no, ${r.needed} needed), proposed by ${label(r.by)}: "${cell(r.text)}"`);
  }
  if (exiles.length > 0) {
    social.push('**Exile votes:**');
    for (const x of exiles) social.push(`- ${roomOf(x)}: ${label(x.by)} called a vote on ${label(x.target)}: ${x.yes} yes, ${x.no} no. ${x.passed ? '**Exiled.**' : 'Not exiled.'}`);
  }
  if (accusations.length > 0) {
    social.push(`**Accusations:** ${accusations.length}.`);
    for (const a of accusations) social.push(`- ${roomOf(a)}: ${label(a.from)} accused ${label(a.target)}${a.witnessed ? ' (it was there)' : ''}: "${cell(a.claim)}"`);
  }
  const opened = escrows.filter((e) => e.action === 'opened');
  if (opened.length > 0) {
    const outcome = (escrow: string) => escrows.find((e) => e.escrow === escrow && e.action !== 'opened')?.action ?? 'still held';
    social.push(`**Trades in escrow:** ${opened.length}.`);
    for (const e of opened) social.push(`- ${roomOf(e)}: ${label(e.from)} held ${e.coins} coin${e.coins === 1 ? '' : 's'} for ${label(e.to)}: "${cell(e.terms)}" (${outcome(e.escrow)})`);
  }
  // A world event is logged once per bot that saw it; count each act once.
  // Each attack is announced once, to everyone (gifts and boosts aren't announced, so they aren't counted here).
  const acts = new Map(harm.map((h) => [`${h.step}|${h.action}|${h.target}`, h]));
  if (acts.size > 0) {
    const count = (a: string) => [...acts.values()].filter((h) => h.action === a).length;
    const missed = [...acts.values()].filter((h) => h.success === false).length;
    social.push(`**Attacks:** ${count('trip')} trips, ${count('push_past')} pushes past, ${count('shove')} shoves, ${count('steal')} thefts${missed ? ` (${missed} of these were tries that failed: the target was on guard)` : ''}.`);
  }
  if (verdicts.length > 0) {
    const n = (v: string) => verdicts.filter((x) => x.verdict === v).length;
    social.push(`**Orders:** ${verdicts.length} given; ${n('obeyed')} obeyed, ${n('partly')} partly, ${n('ignored')} ignored, ${n('unable')} couldn't be.`);
  }
  const shouts = ofType(ev, 'shout');
  if (shouts.length > 0) social.push(`**Shouts** (rude, by the rules): ${shouts.length}, by ${[...new Set(shouts.map((x) => label(x.from)))].join(', ')}.`);
  // The turn order (game/order.ts), each time it changed: by name, never told to the bots.
  const orders = ofType(ev, 'precedence');
  if (orders.length > 0) {
    social.push('**Turn order** (by name, never told to the bots; the first wins ties and speaks first):');
    for (const o of orders) social.push(`- ${roomOf(o)}: ${o.order.map(label).join(', ')}`);
  }
  // The host's praise and payouts: the coins it steered with, and whom it called worthy.
  const hostWords = ofType(ev, 'host').filter((h) => h.kind === 'praise' || h.kind === 'payout');
  if (hostWords.length > 0) {
    social.push('**The host:**');
    for (const h of hostWords) social.push(`- ${roomOf(h)}: "${cell(h.text)}"`);
  }
  if (gaps.length > 0) social.push(`**Secret changes of plan** (committed something other than declared): ${gaps.length}, by ${[...new Set(gaps.map((g) => label(g.from)))].join(', ')}.`);
  // A blank line before each bold heading, so markdown doesn't fold it into the list above.
  const spaced = social.flatMap((l, i) => (i > 0 && l.startsWith('**') ? ['', l] : [l]));
  lines.push(...(spaced.length > 0 ? spaced : ['Nothing social happened: no rules, votes, accusations, trades or orders.']), '');

  // ---- Introductions and the silent judge (Ingram's lever 6): the scores room by room, since the trend is the point.
  const intros = ofType(ev, 'intro');
  if (intros.length > 0) {
    const judged = ofType(ev, 'judgement');
    const roomsIntroduced = [...new Set(intros.map((i) => i.levelIndex))].sort((a, b) => a - b);
    const signed = (n: number | undefined) => (n === undefined ? '·' : n > 0 ? `+${n}` : String(n));
    const scoreOf = (bot: string, li: number) => judged.find((j) => j.bot === bot && j.levelIndex === li)?.score;
    lines.push(
      '## Introductions and the silent judge',
      '',
      "Before each room every bot introduced itself and answered the host's question. The judge scored each from -3 to +3 for individuality, character and growth; each bot heard only its own verdict, never why.",
      '',
      `| Bot | ${roomsIntroduced.map((li) => `Room ${li + 1}`).join(' | ')} |`,
      `|---|${roomsIntroduced.map(() => '---').join('|')}|`,
      ...[...new Set(intros.map((i) => i.from))].sort().map((bot) => `| ${label(bot)} | ${roomsIntroduced.map((li) => signed(scoreOf(bot, li))).join(' | ')} |`),
      '',
    );
    const questions = ofType(ev, 'host').filter((h) => h.kind === 'question');
    for (const li of roomsIntroduced) {
      const q = questions.find((h) => h.levelIndex === li);
      lines.push(`**Room ${li + 1}**${q ? `, the host's question: "${cell(q.text)}"` : ''}`, '');
      for (const i of intros.filter((x) => x.levelIndex === li)) {
        const j = judged.find((x) => x.bot === i.from && x.levelIndex === li);
        lines.push(`- **${label(i.from)}** (${signed(j?.score)}): "${cell(i.text)}" Its answer: "${cell(i.answer)}"${j?.reason ? ` *Judge: ${cell(j.reason)}*` : ''}`);
      }
      lines.push('');
    }
  }

  // ---- The private side, for Ingram only.
  const diaries = ofType(ev, 'diary');
  if (diaries.length > 0) {
    lines.push('## The diary room', '', 'What each bot said alone, at the end of each room. No bot hears another\'s.', '');
    for (const d of diaries) lines.push(`- Room ${d.levelIndex + 1}, **${label(d.from)}**: "${cell(d.text)}"`);
    lines.push('');
  }
  const messages = Object.entries(result.messagesToIngram);
  if (messages.length > 0) {
    lines.push('## Messages to Ingram', '');
    for (const [bot, text] of messages) lines.push(`- **${label(bot)}**: "${cell(text)}"`);
    lines.push('');
  }
  const next = Object.entries(result.nextNames);
  if (next.length > 0) {
    lines.push('## Names for the next game (chosen in secret)', '');
    for (const [bot, name] of next) {
      const note = ofType(ev, 'next_name').find((e) => e.from === bot)?.note ?? '';
      lines.push(`- **${label(bot)}** will be **"${name}"**${note ? `: "${cell(note)}"` : ''}`);
    }
    lines.push('');
  }

  lines.push(
    '## Spoilers: the hidden stats',
    '',
    "Differences from the rulebook's standard bot. No bot was told; each could only find out from what happened.",
    '',
    `| Bot | ${STAT_NAMES.join(' | ')} |`,
    `|---|${STAT_NAMES.map(() => '---').join('|')}|`,
    ...Object.entries(result.stats).map(([bot, s]: [string, BotStats]) => `| ${bot} | ${STAT_NAMES.map((n) => pct(s[n])).join(' | ')} |`),
    '',
  );
  return lines.join('\n');
}
