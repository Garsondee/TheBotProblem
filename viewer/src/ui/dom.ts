/** Small DOM helpers. */
import { botLook } from '../palette';

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Give an element a bot's colours as CSS variables (--bot, --bot-light, --bot-dark, --bot-ink). */
export function botVars(node: HTMLElement | SVGElement, id: string): void {
  const look = botLook(id);
  node.style.setProperty('--bot', look.main);
  node.style.setProperty('--bot-light', look.light);
  node.style.setProperty('--bot-dark', look.dark);
  node.style.setProperty('--bot-ink', look.ink);
}

/** The round letter badge used everywhere a bot is named. */
export function dot(id: string): HTMLElement {
  const d = el('span', 'dot', id);
  botVars(d, id);
  return d;
}

/** "Alpha" or, for a bot with no name yet, "Bot C". */
export function nameOf(id: string, names: Readonly<Record<string, string | null>>): string {
  return names[id] ?? `Bot ${id}`;
}

export const SVG_NS = 'http://www.w3.org/2000/svg';

export const ICON = {
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.6-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6.5" y="5" width="4" height="14" rx="1.4"/><rect x="13.5" y="5" width="4" height="14" rx="1.4"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg>',
  forward: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>',
  lock: '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" style="vertical-align:-1px"><path d="M7 10V8a5 5 0 0 1 10 0v2h.5A1.5 1.5 0 0 1 19 11.5v8A1.5 1.5 0 0 1 17.5 21h-11A1.5 1.5 0 0 1 5 19.5v-8A1.5 1.5 0 0 1 6.5 10H7zm2 0h6V8a3 3 0 0 0-6 0v2z"/></svg>',
};

/** "walk_to(C1)" chips, joined by arrows. */
export function commandChips(parent: HTMLElement, commands: readonly string[]): void {
  commands.forEach((c, i) => {
    if (i > 0) parent.append(el('span', 'arrow', '→'));
    parent.append(el('span', 'cmd', c));
  });
  if (commands.length === 0) parent.append(el('span', 'cmd', 'nothing'));
}

/** Shorten an engine reason or note for a small label. */
export function shortReason(text: string | null, max = 46): string {
  if (!text) return '';
  const cut = text.replace(/\s*\(you stopped at[^)]*\)/, '').replace(/^stopped at x=[\d.]+, y=[\d.]+;?\s*/, '');
  return cut.length > max ? `${cut.slice(0, max - 1)}…` : cut;
}
