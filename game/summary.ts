/**
 * summary.md: a game told briefly, for Ingram. Which rooms were played and how
 * they ended, every name a bot chose with its note to her (2026-11-20: "I
 * would like to be told when this happens by them"), scores, and, as
 * spoilers at the bottom, the hidden stats nobody in the game was told.
 */
import type { BotStats } from '../engine/stats';
import { STAT_NAMES } from '../engine/stats';
import type { GameResult } from './game';

export interface SummaryContext {
  runId: string;
  seed: string;
  seats: { bot: string; provider: string; model: string }[];
  costLine: string | null;
}

const pct = (thousandths: number) => {
  const p = (thousandths - 1000) / 10;
  return `${p > 0 ? '+' : ''}${p.toFixed(1)}%`;
};

export function summaryMarkdown(result: GameResult, ctx: SummaryContext): string {
  const name = (bot: string) => result.names[bot] ?? '(no name)';
  const lines = [
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
    '| Bot | Name | Seat | Coins | Rooms escaped |',
    '|---|---|---|---|---|',
    ...ctx.seats.map((s) => {
      const score = result.scores[s.bot] ?? { coins: 0, roomsEscaped: 0 };
      return `| ${s.bot} | ${name(s.bot)} | ${s.model} | ${score.coins} | ${score.roomsEscaped} |`;
    }),
    '',
    '## Spoilers: the hidden stats',
    '',
    'Differences from the rulebook\'s standard bot. No bot was told; each could only find out from what happened.',
    '',
    `| Bot | ${STAT_NAMES.join(' | ')} |`,
    `|---|${STAT_NAMES.map(() => '---').join('|')}|`,
    ...Object.entries(result.stats).map(([bot, s]: [string, BotStats]) => `| ${bot} | ${STAT_NAMES.map((n) => pct(s[n])).join(' | ')} |`),
    '',
  ];
  return lines.join('\n');
}
