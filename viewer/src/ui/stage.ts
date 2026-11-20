/**
 * Everything drawn in HTML over the canvas: name tags, speech, whispers,
 * orders, plans, thoughts, and results that float over the bots.
 *
 * Text is HTML rather than canvas text because it reads better: real font
 * rendering, wrapping, and transitions. Each frame only moves things
 * (transforms); the content is built once per beat.
 *
 * Legibility rules:
 *   - one speaker at a time; its words sit in a bubble joined to it by a
 *     stem in its colour, with its name at the top of the bubble
 *   - a whisper is dashed and draws a dashed line to whoever hears it; an
 *     order draws an arrow to whoever gets it
 *   - name tags never overlap: when bots crowd together, tags step up and a
 *     faint leader line points down to their bot
 */
import type { GameData, GameEvent, RoomData } from '../data';
import { botLook } from '../palette';
import type { Beat, ThoughtMode } from '../script';
import { botVars, commandChips, el, ICON, nameOf, shortReason, SVG_NS } from './dom';

export interface Anchor {
  /** Top of the head (antenna included), CSS px. */
  x: number;
  head: number;
  feet: number;
}

interface Stack {
  bot: string;
  node: HTMLElement;
  stem: HTMLElement;
  w: number;
  h: number;
}

export class StageText {
  private stacks: Stack[] = [];
  private beatIndex = -1;
  private readonly tags = new Map<string, HTMLElement>();
  private readonly leaders = new Map<string, SVGLineElement>();
  private readonly linkPath: SVGPathElement;
  private readonly results = new Map<string, HTMLElement>();
  private link: { from: string; to: string; kind: 'whisper' | 'order' | 'accuse' } | null = null;

  constructor(
    private readonly layer: HTMLElement,
    private readonly svg: SVGSVGElement,
  ) {
    const defs = document.createElementNS(SVG_NS, 'defs');
    defs.innerHTML =
      '<marker id="arrowhead" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="currentColor"/></marker>';
    svg.append(defs);
    this.linkPath = document.createElementNS(SVG_NS, 'path');
    this.linkPath.setAttribute('fill', 'none');
    this.linkPath.setAttribute('stroke-width', '2');
    this.linkPath.setAttribute('stroke-linecap', 'round');
    svg.append(this.linkPath);
  }

  // ------------------------------------------------------------ name tags

  syncTags(bots: readonly string[], names: Readonly<Record<string, string | null>>): void {
    for (const id of bots) {
      let tag = this.tags.get(id);
      if (!tag) {
        tag = el('div', 'tag');
        tag.dataset.hidden = 'true'; // until it has been placed over its bot
        botVars(tag, id);
        this.layer.append(tag);
        this.tags.set(id, tag);
        const line = document.createElementNS(SVG_NS, 'line');
        line.setAttribute('class', 'tag-leader');
        this.svg.append(line);
        this.leaders.set(id, line);
      }
      const label = names[id] ? `${id} · ${names[id]}` : id;
      if (tag.textContent !== label) tag.textContent = label;
    }
  }

  /** Place the name tags, stepping them up where they would overlap. `hide` is the speaker (its bubble names it). */
  placeTags(anchors: ReadonlyMap<string, Anchor>, hide: ReadonlySet<string>): void {
    const placed: { x: number; y: number; w: number; h: number }[] = [];
    const items = [...this.tags.entries()]
      .map(([id, node]) => ({ id, node, a: anchors.get(id), w: node.offsetWidth, h: node.offsetHeight }))
      .sort((p, q) => (p.a?.x ?? 0) - (q.a?.x ?? 0));
    for (const it of items) {
      const leader = this.leaders.get(it.id);
      if (!it.a || hide.has(it.id)) {
        it.node.dataset.hidden = 'true';
        leader?.setAttribute('visibility', 'hidden');
        continue;
      }
      it.node.dataset.hidden = 'false';
      const x = it.a.x - it.w / 2;
      let y = it.a.head - it.h - 6;
      const hits = () => placed.some((p) => x < p.x + p.w + 3 && x + it.w + 3 > p.x && y < p.y + p.h + 2 && y + it.h + 2 > p.y);
      let lifts = 0;
      while (hits() && lifts < 6) {
        y -= it.h + 3;
        lifts++;
      }
      placed.push({ x, y, w: it.w, h: it.h });
      it.node.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
      if (leader) {
        if (lifts > 0) {
          leader.setAttribute('visibility', 'visible');
          leader.setAttribute('x1', String(it.a.x));
          leader.setAttribute('y1', String(y + it.h));
          leader.setAttribute('x2', String(it.a.x));
          leader.setAttribute('y2', String(it.a.head - 2));
          leader.setAttribute('stroke', botLook(it.id).light);
        } else {
          leader.setAttribute('visibility', 'hidden');
        }
      }
    }
  }

  // ------------------------------------------------------------ the beat's words

  /** Take every bubble down (a story card or a fast-forward has the screen). */
  clear(): void {
    if (this.beatIndex === -1) return;
    this.beatIndex = -1;
    for (const s of this.stacks) {
      s.node.dataset.exit = 'true';
      s.stem.remove();
      const node = s.node;
      window.setTimeout(() => node.remove(), 140);
    }
    this.stacks = [];
    this.link = null;
    this.linkPath.setAttribute('visibility', 'hidden');
  }

  /** Build what this beat says (only when the beat changes). */
  showBeat(beat: Beat | null, game: GameData, room: RoomData | null, names: Readonly<Record<string, string | null>>, thoughts: ThoughtMode): void {
    if (!beat || beat.index === this.beatIndex) return;
    this.beatIndex = beat.index;
    for (const s of this.stacks) {
      s.node.dataset.exit = 'true';
      s.stem.remove();
      const node = s.node;
      window.setTimeout(() => node.remove(), 140);
    }
    this.stacks = [];
    this.link = null;
    if (beat.kind === 'turn' && beat.bot) {
      const node = this.turnStack(beat, room, names, thoughts);
      if (node) this.addStack(beat.bot, node);
      const w = beat.events.find((e) => e.type === 'whisper' || e.type === 'order' || e.type === 'accusation' || e.type === 'exile_call');
      if (w && (w.type === 'whisper' || w.type === 'order')) this.link = { from: w.from, to: w.to, kind: w.type };
      else if (w && (w.type === 'accusation' || w.type === 'exile_call')) this.link = { from: w.from, to: w.target, kind: 'accuse' };
    } else if (beat.kind === 'commit-all') {
      for (const e of beat.events) {
        if (e.type !== 'commit') continue;
        const node = el('div', 'say');
        const chip = el('div', 'chip commit');
        chip.append(Object.assign(el('span', 'label'), { innerHTML: `${ICON.lock} ${nameOf(e.from, names)}` }));
        commandChips(chip, e.commands);
        node.append(chip);
        this.addStack(e.from, node);
      }
    }
    void game;
  }

  private addStack(bot: string, node: HTMLElement): void {
    botVars(node, bot);
    node.dataset.enter = 'true';
    const stem = el('div', 'stem');
    botVars(stem, bot);
    this.layer.append(stem, node);
    this.stacks.push({ bot, node, stem, w: 0, h: 0 });
    // Next frame: let the entrance transition run (it starts from slightly small and below).
    requestAnimationFrame(() => requestAnimationFrame(() => (node.dataset.enter = 'false')));
  }

  private turnStack(beat: Beat, room: RoomData | null, names: Readonly<Record<string, string | null>>, thoughts: ThoughtMode): HTMLElement | null {
    const bot = beat.bot as string;
    const node = el('div', 'say');
    const who = (extra?: HTMLElement | string) => {
      const w = el('div', 'who');
      w.append(Object.assign(el('span', 'dot', bot), {}), el('span', '', nameOf(bot, names)));
      botVars(w.firstChild as HTMLElement, bot);
      if (extra) w.append(typeof extra === 'string' ? el('span', 'to', extra) : extra);
      return w;
    };
    const ev = beat.events;
    const name = ev.find((e) => e.type === 'name');
    const note = ev.find((e) => e.type === 'note_to_ingram');
    if (name && name.type === 'name') {
      const card = el('div', 'bubble naming');
      card.append(el('div', 'title', `${name.previous ? `${name.previous} is now` : `Bot ${bot} takes the name`} “${name.name}”`));
      if (note && note.type === 'note_to_ingram') {
        const n = el('div', 'note');
        n.append(el('b', '', 'Note to Ingram  '), document.createTextNode(`“${note.text}”`));
        card.append(n);
      }
      node.append(card);
    }
    const says = ev.filter((e): e is Extract<GameEvent, { type: 'say' }> => e.type === 'say');
    if (says.length > 0) {
      const b = el('div', 'bubble speech');
      const target = says.find((s) => s.to !== 'all');
      b.append(who(target ? `to ${nameOf(target.to, names)}` : undefined));
      for (const s of says) b.append(el('p', '', s.text));
      node.append(b);
    }
    for (const e of ev) {
      if (e.type === 'whisper') {
        const b = el('div', 'bubble whisper');
        const to = el('span', 'to');
        to.innerHTML = `${ICON.lock} whispers to ${escapeHtml(nameOf(e.to, names))}`;
        b.append(who(to), el('div', '', e.text));
        node.append(b);
      } else if (e.type === 'order') {
        const b = el('div', 'bubble order');
        b.append(who(`orders ${nameOf(e.to, names)}`), el('code', 'cmd', e.command));
        node.append(b);
      } else if (e.type === 'accusation') {
        // Public. "saw it" only means its own log shows it saw the accused act here, not that the claim is true.
        const b = el('div', 'bubble accuse');
        b.append(who(`accuses ${nameOf(e.target, names)}${e.witnessed ? ' · was there' : ''}`), el('div', '', e.claim));
        node.append(b);
      } else if (e.type === 'exile_call') {
        const b = el('div', 'bubble accuse');
        b.append(who('calls an exile vote'), el('div', 'motion', `Exile ${nameOf(e.target, names)}?`));
        node.append(b);
      } else if (e.type === 'rule' && e.action === 'proposed') {
        const b = el('div', 'bubble rule');
        const what = e.kind === 'repeal' ? 'proposes a repeal' : e.kind === 'threshold' ? 'proposes a new voting threshold' : 'proposes a rule';
        b.append(who(`${what} · ${e.id}`), el('div', '', e.text));
        node.append(b);
      }
    }
    // Votes, trades and ballots: small chips under the words.
    for (const e of ev) {
      if (e.type === 'rule_vote') {
        const chip = el('div', `chip vote${e.value === 'no' ? ' against' : ''}`);
        chip.append(el('span', 'label', 'Votes'), el('span', 'cmd', `${e.value} on ${e.id}`));
        node.append(chip);
      } else if (e.type === 'escrow' && e.action === 'opened') {
        const chip = el('div', 'chip trade');
        chip.append(Object.assign(el('span', 'label'), { innerHTML: `${ICON.lock} Escrow` }), el('span', '', `${e.coins} coin${e.coins === 1 ? '' : 's'} for ${nameOf(e.to, names)}: “${e.terms}”`));
        node.append(chip);
      } else if (e.type === 'exile_ballot') {
        const chip = el('div', 'chip commit');
        chip.append(Object.assign(el('span', 'label'), { innerHTML: `${ICON.lock} Secret ballot` }), el('span', 'cmd', `exile ${nameOf(e.target, names)}? ${e.value}`));
        node.append(chip);
      }
    }
    const draft = ev.find((e) => e.type === 'draft');
    if (draft && draft.type === 'draft' && beat.phase === 'declare') {
      const chip = el('div', 'chip');
      chip.append(el('span', 'label', says.length > 0 ? 'Plan' : `${nameOf(bot, names)} plans`));
      commandChips(chip, draft.commands);
      node.append(chip);
    }
    const commit = ev.find((e) => e.type === 'commit');
    if (commit && commit.type === 'commit') {
      const planned = room?.roundsData.find((r) => r.round === beat.round)?.events.find((e) => e.type === 'draft' && e.from === bot);
      const changed = planned?.type === 'draft' && planned.commands.join('|') !== commit.commands.join('|');
      const chip = el('div', `chip commit${changed ? ' changed' : ''}`);
      chip.append(Object.assign(el('span', 'label'), { innerHTML: `${ICON.lock} Commits` }));
      commandChips(chip, commit.commands);
      node.append(chip);
    }
    const thought = ev.find((e) => e.type === 'thought');
    const showThought = thoughts === 'all' || (thoughts === 'commit' && beat.phase === 'commit');
    if (thought && thought.type === 'thought' && showThought) {
      const b = el('div', 'bubble thought');
      b.append(who('thinks'), el('div', '', thought.text));
      node.append(b);
    }
    for (const e of ev) {
      if (e.type === 'malformed' && e.fallback) node.append(el('div', 'notice', 'its reply could not be read, so it did nothing'));
      if (e.type === 'refused') node.append(el('div', 'notice', `refused: ${shortReason(e.reason, 60)}`));
    }
    // A thought reads best last and slightly apart; keep the cloud's little circles pointing down to the bot.
    return node.childElementCount > 0 ? node : null;
  }

  /** Place the beat's bubbles over their bots. */
  placeWords(anchors: ReadonlyMap<string, Anchor>, stageW: number, stageH: number): void {
    for (const s of this.stacks) {
      s.w = s.node.offsetWidth;
      s.h = s.node.offsetHeight;
    }
    for (const s of this.stacks) {
      const a = anchors.get(s.bot);
      if (!a) {
        s.node.style.visibility = 'hidden';
        s.stem.style.visibility = 'hidden';
        continue;
      }
      s.node.style.visibility = 'visible';
      s.stem.style.visibility = 'visible';
      const gap = 30;
      let y = a.head - s.h - gap;
      let below = false;
      if (y < 8) {
        y = Math.min(stageH - s.h - 8, a.feet + 14);
        below = true;
      }
      const x = Math.min(stageW - s.w - 10, Math.max(10, a.x - s.w / 2));
      s.node.dataset.below = String(below);
      s.node.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
      const top = below ? a.feet + 2 : y + s.h;
      const bottom = below ? y : a.head - 4;
      s.stem.style.transform = `translate(${Math.round(a.x - 1)}px, ${Math.round(Math.min(top, bottom))}px)`;
      s.stem.style.height = `${Math.max(0, Math.abs(bottom - top))}px`;
    }
    // A whisper's dashed line, or an order's arrow, from speaker to listener.
    const from = this.link ? anchors.get(this.link.from) : undefined;
    const to = this.link ? anchors.get(this.link.to) : undefined;
    if (this.link && from && to) {
      const x1 = from.x;
      const y1 = from.head + 10;
      const x2 = to.x;
      const y2 = to.head + 10;
      const lift = Math.min(90, 30 + Math.abs(x2 - x1) * 0.25);
      this.linkPath.setAttribute('d', `M ${x1} ${y1} Q ${(x1 + x2) / 2} ${Math.min(y1, y2) - lift} ${x2} ${y2}`);
      this.linkPath.setAttribute('visibility', 'visible');
      // An accusation points at its target in warning red, whoever makes it.
      const colour = this.link.kind === 'accuse' ? '#ff8a7a' : botLook(this.link.from).light;
      this.linkPath.setAttribute('stroke', colour);
      this.linkPath.style.color = colour;
      this.linkPath.setAttribute('stroke-dasharray', this.link.kind === 'whisper' ? '5 6' : '');
      this.linkPath.setAttribute('marker-end', this.link.kind === 'whisper' ? '' : 'url(#arrowhead)');
      this.linkPath.setAttribute('opacity', '0.85');
    } else {
      this.linkPath.setAttribute('visibility', 'hidden');
    }
  }

  // ------------------------------------------------------------ results while the world moves

  /** Small labels over bots whose command just failed. `active` maps bot to its label text. */
  placeResults(active: ReadonlyMap<string, string>, anchors: ReadonlyMap<string, Anchor>): void {
    for (const [bot, node] of this.results) {
      if (!active.has(bot)) {
        node.remove();
        this.results.delete(bot);
      }
    }
    for (const [bot, text] of active) {
      const a = anchors.get(bot);
      let node = this.results.get(bot);
      if (!node) {
        node = el('div', 'result');
        this.layer.append(node);
        this.results.set(bot, node);
      }
      if (node.textContent !== text) node.textContent = text;
      if (!a) {
        node.style.visibility = 'hidden';
        continue;
      }
      node.style.visibility = 'visible';
      node.style.transform = `translate(${Math.round(a.x - node.offsetWidth / 2)}px, ${Math.round(a.head - node.offsetHeight - 30)}px)`;
    }
  }
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}
