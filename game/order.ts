/**
 * Who acts first (Ingram, 2026-11-20): "Turn order is bot name alphabetic but we don't have to explain that
 * rule in advance. Bots with some names will act before others and the only way to change order is to change
 * name."
 *
 * Everything in a round happens at once, so order only decides ties, but ties are where it matters: when two
 * bots reach the same coin, the last place in an exit or the same gap in the same step, the one first in the
 * order gets it; its shove lands before the other's command starts; its words come first in everyone's view
 * of the talk (the spec expects bots to "defer to the first confident voice"); and of two bots claiming the
 * same name at once, it gets the name.
 *
 * The rulebook says nothing about it: the bots can only find it out, by noticing who keeps winning ties and
 * whose words always come first, and change it only by renaming (once per room). Nothing the game says is
 * made false by it: the rulebook's "play out at the same time" still holds; the order breaks ties within it.
 * Ingram and the Director see it (a "precedence" event whenever it changes).
 */

/** "letter": by bot letter, the order the game always had. "name": by name, A to Z. */
export type TurnOrder = 'letter' | 'name';

/**
 * The bots in the order they act. By name: case aside, A to Z; a bot without a name goes by "Bot B", as the
 * host calls it. Names are unique, so there are no ties (the letter would settle one). Plain character
 * order, not the machine's locale, so every machine sorts the same.
 */
export function actingOrder(bots: readonly string[], names: Readonly<Record<string, string | null>>, rule: TurnOrder): string[] {
  if (rule === 'letter') return [...bots].sort();
  const key = (id: string) => (names[id] ?? `Bot ${id}`).toLowerCase();
  return [...bots].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    return ka < kb ? -1 : ka > kb ? 1 : a < b ? -1 : a > b ? 1 : 0;
  });
}
