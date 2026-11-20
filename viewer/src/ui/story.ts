/**
 * The story's own layer over the scene (Story mode): chapter cards, the
 * narrator's words, quote cards in a bot's own words, the fast-forward sign,
 * and the caption of the moment being shown.
 *
 * Who is speaking must always be clear (Ingram, 2026-11-20), so the three
 * voices look different:
 *   - the narrator: a calm lower third, labelled "Narrator", in white on glass
 *   - a bot: a card in its own colour, with its face and name, and what kind
 *     of words these are (diary room, a private thought, a whisper to...)
 *   - the bots in the moment shown: their usual bubbles, untouched
 * Cards come and go rarely (a few times a minute), so they get a short
 * entrance: a fade and a small rise, never from nothing.
 */
import type { GameData, GameEvent } from '../data';
import { botLook } from '../palette';
import type { Story, StoryItem } from '../story';
import { botVars, el, nameOf } from './dom';

/** What kind of words a quote is, as its card says it. */
function quoteKind(e: GameEvent, names: Readonly<Record<string, string | null>>): string {
  switch (e.type) {
    case 'diary':
      return 'in the diary room · only Ingram hears this';
    case 'thought':
      return 'thinks, privately';
    case 'whisper':
      return `whispers to ${nameOf(e.to, names)}`;
    case 'say':
      return e.to === 'all' ? 'says' : `says to ${nameOf(e.to, names)}`;
    case 'note_to_ingram':
      return 'note to Ingram';
    case 'message_to_ingram':
      return 'message to Ingram';
    case 'notebook':
      return 'private notebook';
    case 'strategy':
      return 'private strategy';
    case 'next_name':
      return `will secretly be “${e.name}” next game`;
    case 'accusation':
      return `accuses ${nameOf(e.target, names)}`;
    case 'opinion':
      return `privately, about ${nameOf(e.about, names)}`;
    default:
      return '';
  }
}

export class StoryLayer {
  private readonly scrim: HTMLElement;
  private readonly chapter: HTMLElement;
  private readonly narration: HTMLElement;
  private readonly quote: HTMLElement;
  private readonly zip: HTMLElement;
  private readonly zipFill: HTMLElement;
  private readonly zipRate: HTMLElement;
  private readonly caption: HTMLElement;
  private shown = -1;
  private chapters = new Map<number, number>();

  constructor(root: HTMLElement) {
    this.scrim = el('div', 'st-scrim');
    this.chapter = el('div', 'st-chapter');
    this.narration = el('div', 'st-narration');
    this.quote = el('div', 'st-quote');
    this.zip = el('div', 'st-zip');
    this.zipRate = el('span', 'rate');
    const bar = el('div', 'bar');
    this.zipFill = el('div', 'fill');
    bar.append(this.zipFill);
    this.zip.append(el('span', 'icon', '⏩'), el('span', '', 'Fast-forward'), this.zipRate, bar);
    this.caption = el('div', 'st-caption');
    for (const n of [this.scrim, this.chapter, this.narration, this.quote, this.zip, this.caption]) n.dataset.show = 'false';
    root.append(this.scrim, this.chapter, this.quote, this.zip, this.caption, this.narration);
  }

  /** Number the chapters once, for their kickers. */
  setStory(story: Story): void {
    this.chapters = new Map();
    let n = 0;
    story.segments.forEach((s, i) => {
      if (s.type === 'chapter') this.chapters.set(i, n++);
    });
    this.shown = -1;
  }

  hide(): void {
    for (const n of [this.scrim, this.chapter, this.narration, this.quote, this.zip, this.caption]) n.dataset.show = 'false';
    this.shown = -1;
  }

  update(index: number, item: StoryItem, local: number, story: Story, game: GameData, names: Readonly<Record<string, string | null>>): void {
    const first = index !== this.shown;
    this.shown = index;
    const card = item.kind === 'card' ? item.card : null;
    this.scrim.dataset.show = String(card === 'chapter' || card === 'quote');
    this.scrim.dataset.strong = String(card === 'chapter');

    // Chapter card.
    this.chapter.dataset.show = String(card === 'chapter');
    if (first && item.kind === 'card' && item.card === 'chapter') {
      const n = this.chapters.get(item.segment) ?? 0;
      this.chapter.replaceChildren(el('div', 'kicker', n === 0 ? story.title : `Chapter ${n}`), el('h1', '', item.text));
      if (n === 0 && story.logline) this.chapter.append(el('p', '', story.logline));
    }

    // The narrator: over a held scene, or over a fast-forward.
    const words = item.kind === 'card' && item.card === 'narrate' ? item.text : item.kind === 'zip' ? item.text : '';
    const narrating = this.narration.dataset.show === 'true';
    this.narration.dataset.show = String(words !== '');
    if (first && words !== '') {
      this.swap(this.narration, narrating, () => this.narration.replaceChildren(el('div', 'who', 'Narrator'), el('p', '', words)));
    }

    // A bot's own words.
    const quoting = this.quote.dataset.show === 'true';
    this.quote.dataset.show = String(card === 'quote');
    if (first && item.kind === 'card' && item.card === 'quote' && item.eventId !== null) {
      const e = game.events.find((x) => x.id === item.eventId);
      const bot = e && 'from' in e && typeof e.from === 'string' ? e.from : null;
      if (e && bot) {
        const text = item.text;
        this.swap(this.quote, quoting, () => {
          this.quote.replaceChildren();
          botVars(this.quote, bot);
          const head = el('div', 'head');
          const dot = el('span', 'dot', bot);
          botVars(dot, bot);
          head.append(dot, el('span', 'name', nameOf(bot, names)), el('span', 'kind', quoteKind(e, names)));
          this.quote.append(head, el('blockquote', '', text));
          this.quote.style.setProperty('--glow', botLook(bot).main);
        });
      }
    }

    // The fast-forward sign: how much faster than real time, and how far through.
    this.zip.dataset.show = String(item.kind === 'zip');
    if (item.kind === 'zip') {
      const rate = item.physics > 0 ? Math.max(2, Math.round(item.physics / item.dur)) : 0;
      const label = rate > 0 ? `${rate}×` : '';
      if (this.zipRate.textContent !== label) this.zipRate.textContent = label;
      this.zipFill.style.transform = `scaleX(${Math.min(1, local / Math.max(0.001, item.dur))})`;
    }

    // The caption of the moment being shown.
    const caption = item.kind === 'beat' ? item.caption : '';
    this.caption.dataset.show = String(caption !== '');
    if (caption !== '' && this.caption.dataset.text !== caption) {
      this.caption.dataset.text = caption;
      this.caption.replaceChildren(el('span', 'mark'), el('span', '', caption));
    }
  }

  /**
   * New words for a card. A hidden card just takes them (its show transition
   * reveals them). A card already up dips out for a moment first, so a new
   * line reads as new; a CSS transition does it, which a later change can
   * interrupt cleanly (a script animation would keep forcing its own opacity).
   */
  private swap(node: HTMLElement, wasUp: boolean, fill: () => void): void {
    if (!wasUp) {
      fill();
      return;
    }
    const token = String(Number(node.dataset.swapToken ?? '0') + 1);
    node.dataset.swapToken = token;
    node.dataset.swap = 'true';
    window.setTimeout(() => {
      if (node.dataset.swapToken !== token) return; // a newer line replaced this one
      fill();
      node.dataset.swap = 'false';
    }, 130);
  }
}
