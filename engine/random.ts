/**
 * Seeded randomness, split into named streams.
 *
 * The spec: "All randomness comes from one seeded PRNG per run, split into
 * named streams (level, stats, roles, rumours, poisoning)."
 *
 * Why streams? So that randomness used in one place can't shift it anywhere
 * else. If roles and stats drew from one shared sequence, giving the role deck
 * one extra shuffle would change every bot's hidden stats too, and a fork
 * would stop matching its parent. Each stream's seed is a hash of the run
 * seed plus the stream's name, so the streams are independent of each other.
 *
 * The generator is sfc32, seeded through the cyrb128 hash. Both are small,
 * well tested, and use only 32-bit integer arithmetic, so they give the same
 * numbers on every machine (unlike Math.random, which can't be seeded).
 */

export type StreamName = 'level' | 'stats' | 'roles' | 'rumours' | 'poisoning' | 'mock' | 'guard' | 'persona' | 'host';

/** cyrb128: turns any text into four 32-bit seeds. */
export function cyrb128(text: string): [number, number, number, number] {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < text.length; i++) {
    const k = text.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

/** One stream of random numbers. */
export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seedText: string) {
    [this.a, this.b, this.c, this.d] = cyrb128(seedText);
    // The first few outputs of sfc32 still echo the seed; throw them away.
    for (let i = 0; i < 12; i++) this.next();
  }

  /** A number from 0 (included) to 1 (excluded). */
  next(): number {
    // sfc32 ("small fast counting" generator), all in 32-bit integers.
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return (t >>> 0) / 4294967296;
  }

  /** A whole number from min to max, both included. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** A number from -1 to 1. */
  signed(): number {
    return this.next() * 2 - 1;
  }

  pick<T>(items: readonly T[]): T {
    const item = items[this.int(0, items.length - 1)];
    if (item === undefined) throw new Error('Rng.pick needs at least one item.');
    return item;
  }

  /** A shuffled copy (Fisher-Yates). */
  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [out[i], out[j]] = [out[j] as T, out[i] as T];
    }
    return out;
  }
}

/** All the randomness for one run: one independent stream per name. */
export class RunRandom {
  private readonly streams = new Map<string, Rng>();

  constructor(readonly seed: string) {}

  stream(name: StreamName): Rng {
    let rng = this.streams.get(name);
    if (!rng) {
      rng = new Rng(`${this.seed}::${name}`);
      this.streams.set(name, rng);
    }
    return rng;
  }
}
