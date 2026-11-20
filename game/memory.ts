/**
 * Memory across games: who each agent is, and what it remembers.
 *
 * Ingram (2026-11-20): "Bot names need to persist between runs if the memory
 * of that agent does (their memory scratchpad) - bots should be allowed a
 * chance to privately rename themselves at the end, entering the next run
 * with a different name but their old memories."
 *
 * An AGENT is one seat of the cast (a model in a chair), with a lasting id
 * such as "claude-haiku-5-5#2". Its memory is its name, its notebook and its
 * strategy, plus a list of the games it played. A memory bank holds the
 * agents of one cast (memory/<bank>.json, kept out of git).
 *
 * Letters are dealt afresh each game (seeded), and the rulebook says so.
 * That is what makes a private rename private: if "B" always came back as
 * "B", every bot would know whose new name it was.
 *
 * Pure code: reading and writing the bank file is the harness's job.
 */
import type { Persona } from './persona';
import type { Rng } from '../engine/random';

export interface AgentRecord {
  agent: string;
  model: string;
  name: string | null;
  notebook: string;
  strategy: string;
  games: { seed: string; letter: string; startName: string | null; endName: string | null }[];
  /** Its personality (game/persona.ts), made once and kept. Older banks have none: one is made at its next game. */
  persona?: Persona;
  /** Its last few introductions and their scores, so the judge can see growth from game to game. */
  intros?: IntroRecord[];
}

/** One introduction (prompts/host.ts) and the silent judge's score for it (null: not judged). */
export interface IntroRecord {
  seed: string;
  room: string;
  question: string;
  introduction: string;
  answer: string;
  score: number | null;
}

/** Enough earlier introductions to see growth, few enough to keep the judge's prompt short. */
export const INTROS_KEPT = 4;

export interface MemoryBank {
  version: 1;
  agents: Record<string, AgentRecord>;
}

export const emptyBank = (): MemoryBank => ({ version: 1, agents: {} });

/** Lasting ids for a cast's seats: the seat's own `agent` if it has one, else the model and a number. */
export function agentIdsFor(seats: readonly { model: string; agent?: string | undefined }[]): string[] {
  const seen = new Map<string, number>();
  return seats.map((s) => {
    if (s.agent) return s.agent;
    const n = (seen.get(s.model) ?? 0) + 1;
    seen.set(s.model, n);
    return `${s.model}#${n}`;
  });
}

export interface Dealt {
  letter: string;
  agent: string;
  /** Which seat of the cast the agent sits in (its model, provider and price ceiling). */
  seat: number;
}

/** Hand out letters A, B, C ... to the agents: shuffled (seeded) when memory is on, in cast order when not. */
export function dealLetters(agents: readonly string[], rng: Rng | null): Dealt[] {
  const order = agents.map((agent, seat) => ({ agent, seat }));
  const dealt = rng ? rng.shuffle(order) : order;
  return dealt.map((d, i) => ({ letter: String.fromCharCode(65 + i), agent: d.agent, seat: d.seat }));
}

export interface Identity {
  agent: string;
  name: string | null;
  notebook: string;
  strategy: string;
  persona?: Persona;
  intros?: IntroRecord[];
}

/** What each letter starts this game with. */
export function identitiesFor(bank: MemoryBank, dealt: readonly Dealt[]): Record<string, Identity> {
  return Object.fromEntries(
    dealt.map((d) => {
      const rec = bank.agents[d.agent];
      return [d.letter, { agent: d.agent, name: rec?.name ?? null, notebook: rec?.notebook ?? '', strategy: rec?.strategy ?? '', ...(rec?.persona ? { persona: rec.persona } : {}), ...(rec?.intros ? { intros: rec.intros } : {}) }];
    }),
  );
}

export interface GameEnd {
  seed: string;
  /** Names at the end of the game, by letter (what others last saw). */
  names: Readonly<Record<string, string | null>>;
  /** Names chosen privately for the next game, by letter (absent: keep the current one). */
  nextNames: Readonly<Record<string, string>>;
  notebooks: Readonly<Record<string, string>>;
  strategies: Readonly<Record<string, string>>;
  /** Each letter's persona this game (kept for the agent). */
  personas?: Readonly<Record<string, Persona>>;
  /** Each letter's introductions this game, with the judge's scores. */
  introductions?: Readonly<Record<string, readonly IntroRecord[]>>;
}

/** The bank after a game: each agent keeps its notebook and strategy, and carries its (possibly new) name. */
export function updateBank(bank: MemoryBank, dealt: readonly Dealt[], models: readonly string[], end: GameEnd): MemoryBank {
  const next: MemoryBank = { version: 1, agents: { ...bank.agents } };
  for (const d of dealt) {
    const before = bank.agents[d.agent];
    const name = end.nextNames[d.letter] ?? end.names[d.letter] ?? before?.name ?? null;
    next.agents[d.agent] = {
      agent: d.agent,
      model: models[d.seat] ?? before?.model ?? 'unknown',
      name,
      notebook: end.notebooks[d.letter] ?? before?.notebook ?? '',
      strategy: end.strategies[d.letter] ?? before?.strategy ?? '',
      games: [...(before?.games ?? []), { seed: end.seed, letter: d.letter, startName: before?.name ?? null, endName: name }],
      ...((before?.persona ?? end.personas?.[d.letter]) ? { persona: before?.persona ?? end.personas?.[d.letter] } : {}),
    };
    const intros = [...(before?.intros ?? []), ...(end.introductions?.[d.letter] ?? [])].slice(-INTROS_KEPT);
    if (intros.length > 0) (next.agents[d.agent] as AgentRecord).intros = intros;
  }
  return next;
}
