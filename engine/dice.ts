/**
 * The dice for attacks (Ingram, 2026-11-20: violent moves that "roll dice to
 * decide if it works or not").
 *
 * The whole state of the dice is one number kept in the world, so a resolved
 * round is exactly repeatable, a cloned world (the move menu's prediction)
 * never uses up the real dice, and a game's seed decides every roll.
 * Mulberry32: small, fast, and good enough for a game.
 */
import type { World } from './world';

/** A roll from 0 to 999, advancing the world's dice. */
export function rollDice(world: World): number {
  world.dice = (world.dice + 0x6d2b79f5) | 0;
  let t = world.dice;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * 1000);
}

/** A starting state for the dice from any text (the game's seed and the room). */
export function diceSeed(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h | 0;
}
