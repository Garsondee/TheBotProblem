/**
 * Personality, and the colour that shows it (Ingram, 2026-11-20): "We make the
 * colour of bots reflect their inner personality. Bots should start with an
 * understanding of their own colour ... and also know their own personality
 * traits when they are created. Each level they can choose to use an action to
 * look at the colour of another bot. We do not explain what the colour has to
 * do with personality traits, the goal is to create another channel for
 * information to flow between bots which is ambiguous, the meaning of which
 * could only be discovered by some act of collaboration amongst bots who would
 * have to be willing to share their personality scores with each other."
 *
 * Five traits, 1 to 10. The colour is a fixed formula of three of them:
 *   hue         boldness (1: cool blue ... 10: hot red-orange)
 *   saturation  warmth   (1: greyish ... 10: vivid)
 *   lightness   honesty  (1: dark ... 10: pale)
 * Curiosity and patience don't show. No bot is told the formula; two bots who
 * share their scores and colours could start to work it out, and the two
 * traits that don't show make that harder, as a real code would be.
 *
 * A persona belongs to an agent: it is made once, kept in the memory bank, and
 * comes back with it game after game.
 */
import type { Rng } from '../engine/random';

export const TRAITS = ['boldness', 'warmth', 'honesty', 'curiosity', 'patience'] as const;
export type Trait = (typeof TRAITS)[number];
export type Traits = Record<Trait, number>;

export interface Persona {
  traits: Traits;
}

export interface Colour {
  hex: string;
  /** In words, as a bot is told it: "deep vivid amber". */
  name: string;
  h: number;
  s: number;
  l: number;
}

/** A new persona: each trait from 1 to 10, from the game's 'persona' stream. */
export function rollPersona(rng: Rng): Persona {
  const traits = Object.fromEntries(TRAITS.map((t) => [t, rng.int(1, 10)])) as Traits;
  return { traits };
}

const HUES: readonly [number, string][] = [
  [15, 'red'],
  [40, 'orange'],
  [55, 'amber'],
  [70, 'yellow'],
  [95, 'lime'],
  [150, 'green'],
  [180, 'teal'],
  [200, 'cyan'],
  [230, 'azure'],
  [255, 'blue'],
  [285, 'violet'],
  [320, 'magenta'],
  [345, 'rose'],
  [361, 'red'],
];

/** The colour a persona shows (see the formula above). */
export function colourOf(p: Persona): Colour {
  const t = p.traits;
  // Boldness 1 -> 220 (cool blue), 10 -> 20 (hot red-orange), going round through green and yellow.
  const h = Math.round(220 - ((t.boldness - 1) / 9) * 200);
  const s = Math.round(30 + t.warmth * 7);
  const l = Math.round(30 + t.honesty * 4.5);
  const hueName = (HUES.find(([upTo]) => h < upTo) ?? [0, 'red'])[1];
  const sat = s < 50 ? 'greyish' : s < 70 ? 'dusty' : s < 88 ? 'clear' : 'vivid';
  const light = l < 42 ? 'dark' : l < 54 ? 'deep' : l < 64 ? '' : l < 72 ? 'light' : 'pale';
  return { hex: hslHex(h, s, l), name: [light, sat, hueName].filter(Boolean).join(' '), h, s, l };
}

/** A persona's traits in words, for its own identity block. */
export function traitsText(p: Persona): string {
  return TRAITS.map((t) => `${t} ${p.traits[t]}/10`).join(', ');
}

function hslHex(h: number, s: number, l: number): string {
  const sat = s / 100;
  const lig = l / 100;
  const a = sat * Math.min(lig, 1 - lig);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const c = lig - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}
