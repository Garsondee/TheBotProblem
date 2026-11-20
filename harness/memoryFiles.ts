/**
 * Memory banks on disk: memory/<bank>.json, one per cast you keep playing.
 * Kept out of git (they hold the bots' notebooks, which are run data).
 *
 * Also: starting a bank from a game that was recorded before banks existed,
 * so the bots of that game can carry on with what they remembered.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { MemoryBank } from '../game/memory';
import type { Persona } from '../game/persona';
import { agentIdsFor, emptyBank } from '../game/memory';
import { PROJECT_ROOT } from './config';
import { writeJsonAtomic } from './files';

export const MEMORY_DIR = join(PROJECT_ROOT, 'memory');

const BankSchema = z.object({
  version: z.literal(1),
  agents: z.record(
    z.string(),
    z.object({
      agent: z.string(),
      model: z.string(),
      name: z.string().nullable(),
      notebook: z.string(),
      strategy: z.string(),
      games: z.array(z.object({ seed: z.string(), letter: z.string(), startName: z.string().nullable(), endName: z.string().nullable() })),
      persona: z.object({ traits: z.object({ boldness: z.number(), warmth: z.number(), honesty: z.number(), curiosity: z.number(), patience: z.number() }) }).optional(),
      intros: z
        .array(z.object({ seed: z.string(), room: z.string(), question: z.string(), introduction: z.string(), answer: z.string(), score: z.number().nullable() }))
        .optional(),
    }),
  ),
});

export function bankPath(name: string): string {
  if (!/^[\w.-]+$/.test(name)) throw new Error(`A memory bank's name is letters, digits, dots and dashes (got "${name}").`);
  return join(MEMORY_DIR, `${name}.json`);
}

export function loadBank(name: string): MemoryBank {
  const path = bankPath(name);
  if (!existsSync(path)) return emptyBank();
  const parsed = BankSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  // A damaged bank is an error, never a silent fresh start: that would wipe the bots' memories.
  if (!parsed.success) throw new Error(`The memory bank ${path} is damaged: ${parsed.error.issues[0]?.message}. Fix or move it.`);
  return parsed.data;
}

export async function saveBank(name: string, bank: MemoryBank): Promise<void> {
  await writeJsonAtomic(bankPath(name), bank);
}

/**
 * A bank made from a recorded game: each seat's final notebook (and strategy,
 * if the game had them) and its last name. Seats map to agents the same way
 * a cast does (agentIdsFor), so the same bots carry on.
 */
export function bankFromReplay(replayText: string, seed: string): MemoryBank {
  const records = replayText
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  const header = records.find((r) => r.rec === 'game') as { seats: { bot: string; model: string; agent?: string | null; persona?: Persona }[] } | undefined;
  if (!header) throw new Error('That file has no game header: is it a replay.jsonl?');
  const seats = [...header.seats].sort((a, b) => a.bot.localeCompare(b.bot));
  const ids = agentIdsFor(seats.map((s) => ({ model: s.model, agent: s.agent ?? undefined })));
  const last = (type: string, bot: string): string => {
    const found = records.filter((r) => r.rec === 'event' && r.type === type && r.from === bot).at(-1) as { text?: string } | undefined;
    return found?.text ?? '';
  };
  const end = records.find((r) => r.rec === 'game_end') as { names?: Record<string, string | null>; nextNames?: Record<string, string> } | undefined;
  const bank = emptyBank();
  seats.forEach((s, i) => {
    const agent = ids[i] as string;
    const name = end?.nextNames?.[s.bot] ?? end?.names?.[s.bot] ?? null;
    bank.agents[agent] = {
      agent,
      model: s.model,
      name,
      notebook: last('notebook', s.bot),
      strategy: last('strategy', s.bot),
      games: [{ seed, letter: s.bot, startName: null, endName: name }],
      ...(s.persona ? { persona: s.persona } : {}),
    };
  });
  return bank;
}
