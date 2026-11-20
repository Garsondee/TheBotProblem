/**
 * summary.md (milestone 5): the scores with the team multiplier, what the
 * social systems saw, and the private side for Ingram (the diary room, each
 * bot's message to her, the names chosen in secret for the next game).
 */
import { describe, expect, it } from 'vitest';
import { MockAgent } from '../agents/mockAgent';
import { runGame } from '../game/game';
import { MemoryOutput } from '../game/output';
import { DEFAULT_SOCIAL } from '../game/game';
import { summaryMarkdown } from '../game/summary';
import { loadGameConfig } from '../harness/config';
import { loadLevels } from '../harness/levels';

const config = loadGameConfig();
const levels = loadLevels();

describe('summary.md', () => {
  it('tells the social side and the private side of a game', async () => {
    const seed = 'summary-1';
    const result = await runGame({
      seed,
      levels: [levels.find((l) => l.kind === 'practice'), levels.find((l) => l.id.startsWith('L1'))].filter((l) => l !== undefined),
      agents: ['A', 'B', 'C', 'D', 'E'].map((id) => new MockAgent(id, seed)),
      ranges: config.hiddenStats,
      maxTokens: { turn: 450, reflection: 1500, diary: 200 },
      output: new MemoryOutput(),
      money: null,
      promptTokenLimit: 60_000,
      // Exile from the second room, so a two-room game can show it.
      social: { ...DEFAULT_SOCIAL, exileFromRoom: 1 },
    });
    const md = summaryMarkdown(result, {
      runId: 'test',
      seed,
      seats: ['A', 'B', 'C', 'D', 'E'].map((bot) => ({ bot, provider: 'mock', model: 'mock' })),
      costLine: null,
      teamBonusPerRoom: DEFAULT_SOCIAL.teamBonusPerRoom,
    });
    for (const heading of ['## Scores', '## The social side', '## The diary room', '## Messages to Ingram', '## Spoilers: the hidden stats']) expect(md).toContain(heading);
    expect(md).toMatch(/\*\*Constitution:\*\* \d+ proposal/);
    expect(md).toContain('**Exile votes:**');
    // Every bot's total is in the table, as the game scored it.
    for (const [bot, s] of Object.entries(result.scores)) expect(md).toMatch(new RegExp(`\\| ${bot} \\|.*\\*\\*${s.total}\\*\\* \\|`));
    // The private names for next time, when any were chosen.
    if (Object.keys(result.nextNames).length > 0) expect(md).toContain('## Names for the next game (chosen in secret)');
    // A bold heading never runs straight on from the line before it (markdown would fold it in).
    expect(md).not.toMatch(/[^\n]\n\*\*(Exile votes|Accusations|Trades|Orders|Bodies)/);
  });
});
