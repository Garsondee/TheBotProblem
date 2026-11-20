/**
 * The spoken script (Ingram, 2026-11-20): every bot line a story shows is voiced, reworded for the ear with
 * the meaning kept. These check which lines a story speaks and how a model's rewrite is checked; the model
 * itself is never called in tests.
 */
import { describe, expect, it } from 'vitest';
import { ScriptedAgent } from '../agents/scriptedAgent';
import type { StoryLine } from '../analysis/spoken';
import { parseSpoken, spokenPrompt, storyLines } from '../analysis/spoken';
import { runGame } from '../game/game';
import { MemoryOutput } from '../game/output';
import { loadGameConfig } from '../harness/config';
import { loadLevels } from '../harness/levels';
import { parseReplay } from '../viewer/src/data';
import { buildScript } from '../viewer/src/script';
import type { Story } from '../viewer/src/story';

async function scriptedGame() {
  const config = loadGameConfig();
  const levels = loadLevels().slice(0, 2);
  const output = new MemoryOutput();
  await runGame({
    seed: 'spoken',
    levels,
    agents: ['A', 'B', 'C', 'D', 'E'].map((id) => new ScriptedAgent(id, levels)),
    ranges: config.hiddenStats,
    maxTokens: { turn: 700, reflection: 1500, diary: 200 },
    output,
    money: null,
    promptTokenLimit: 60_000,
  });
  return parseReplay(output.replayLines.join('\n'));
}

describe('the lines a story speaks', () => {
  it('are every line in the moments it shows (for the bots it shows), once, and its quote cards in their own words', async () => {
    const game = await scriptedGame();
    const said = (bot: string) => game.events.find((e) => e.type === 'say' && e.from === bot && e.levelIndex === 1 && e.round === 1);
    const a = said('A');
    const b = said('B');
    expect(a && b).toBeTruthy();
    const at = { room: 1, round: 1, step: 'declare' as const };
    const story: Story = {
      version: 1,
      title: 'T',
      logline: '',
      director: 'test',
      thoughts: 'off',
      targetMinutes: [3, 7],
      voiceLines: [],
      segments: [
        { type: 'show', from: at, to: at, bots: ['A'], caption: 'A speaks', importance: 3 },
        { type: 'show', from: at, to: at, bots: ['A'], caption: 'A again', importance: 3 },
        { type: 'quote', eventId: b?.id ?? 0, at },
      ],
    };
    const lines = storyLines(game, story, buildScript(game, { thoughts: story.thoughts }));
    expect(lines.map((l) => l.key)).toEqual([`e${a?.id}`, 'q2']); // A's line once, B only through its card
    expect(lines[0]).toMatchObject({ bot: 'A', kind: 'say', to: 'all' });
    expect(lines[1]).toMatchObject({ bot: 'B', kind: 'quote', segment: 2, text: b?.type === 'say' ? b.text : '' });
    // The prompt says who speaks, how, and to whom.
    expect(spokenPrompt(game, lines)).toMatch(new RegExp(`^\\[e${a?.id}\\] (Script A \\(A\\)|A) says to everyone: «I will `));
  });
});

describe("checking a model's rewrite", () => {
  const asked: StoryLine[] = [
    { key: 'e1', bot: 'A', kind: 'say', eventId: 1, segment: null, text: 'walk_to(X) then enter_exit, I am at x=19.75', to: 'all' },
    { key: 'e2', bot: 'B', kind: 'say', eventId: 2, segment: null, text: 'No.', to: 'A' },
    { key: 'q3', bot: 'C', kind: 'quote', eventId: 3, segment: 3, text: 'I trust nobody.', to: '' },
  ];

  it('keeps what was asked for, and refuses a line that grew (it has probably added something)', () => {
    const reply = JSON.stringify({
      lines: [
        { key: 'e1', spoken: "I'll walk to the exit and go through. I'm at about twenty." },
        { key: 'e2', spoken: 'No, absolutely not, and I want you to know how disappointed I am in you.' },
        { key: 'q3', spoken: '  ' },
        { key: 'e9', spoken: 'never asked for' },
      ],
    });
    const got = parseSpoken(reply, asked);
    expect([...got.keys()]).toEqual(['e1']);
    expect(got.get('e1')).toBe("I'll walk to the exit and go through. I'm at about twenty.");
  });

  it('gives nothing back for a reply that is not the JSON asked for, so every line keeps its own words', () => {
    expect(parseSpoken('not json', asked).size).toBe(0);
    expect(parseSpoken(JSON.stringify({ lines: 'oops' }), asked).size).toBe(0);
  });
});
