/**
 * The transcript: the whole conversation, in order, beside the stage.
 *
 * Grouped by room, round and step, each line led by the speaker's coloured
 * letter and name, so "who said this?" is never a question. It follows the
 * playback (the current lines light up and stay in view) until you scroll it
 * yourself; clicking any line jumps the playback there.
 */
import type { WorldEvent } from '../../../engine/world';
import type { GameData, GameEvent, Phase } from '../data';
import { authorOf } from '../data';
import type { Beat, Script } from '../script';
import { botVars, commandChips, dot, el, ICON, nameOf, shortReason } from './dom';

const PHASE_TITLE: Record<Phase, string> = { declare: 'Plans', talk: 'Talk', commit: 'Commitments (secret)' };

export class Transcript {
  private readonly log: HTMLElement;
  private readonly followBtn: HTMLButtonElement;
  private follow = true;
  private byBeat = new Map<number, HTMLElement[]>();
  private current: HTMLElement[] = [];
  private programmaticScroll = 0;

  constructor(
    root: HTMLElement,
    private readonly onSeek: (beat: Beat) => void,
  ) {
    const header = el('header');
    header.append(el('h2', '', 'Transcript'));
    this.followBtn = el('button', 'follow', 'Following');
    this.followBtn.setAttribute('aria-pressed', 'true');
    this.followBtn.addEventListener('click', () => this.setFollow(!this.follow));
    header.append(this.followBtn);
    this.log = el('div', 'log');
    root.append(header, this.log);
    // Scrolling by hand stops the auto-follow, until you press "Follow" again.
    this.log.addEventListener('scroll', () => {
      if (performance.now() - this.programmaticScroll > 250) this.setFollow(false);
    });
  }

  private setFollow(on: boolean): void {
    this.follow = on;
    this.followBtn.setAttribute('aria-pressed', String(on));
    this.followBtn.textContent = on ? 'Following' : 'Follow';
    if (on) this.scrollToCurrent(true);
  }

  setThoughts(visible: boolean): void {
    this.log.dataset.thoughts = visible ? 'on' : 'off';
  }

  build(game: GameData, script: Script): void {
    this.log.replaceChildren();
    this.byBeat = new Map();
    const beatOf = new Map<number, Beat>();
    for (const b of script.beats) for (const e of b.events) if (!beatOf.has(e.id)) beatOf.set(e.id, b);
    const fallback = (room: number, round: number, phase: Phase | null): Beat | undefined =>
      script.beats.find((b) => b.room === room && b.round === round && (phase === null || b.phase === phase)) ??
      script.beats.find((b) => b.room === room && b.round === round);
    const attach = (node: HTMLElement, beat: Beat | undefined) => {
      if (!beat) return;
      node.addEventListener('click', () => this.onSeek(beat));
      const list = this.byBeat.get(beat.index) ?? [];
      list.push(node);
      this.byBeat.set(beat.index, list);
    };

    const names: Record<string, string | null> = Object.fromEntries(game.bots.map((b) => [b, null]));
    for (const room of game.rooms) {
      const h3 = el('h3', '', room.name);
      h3.prepend(el('small', '', `Room ${room.index + 1} of ${game.rooms.length}${room.kind === 'practice' ? ' · practice' : ''}`));
      this.log.append(h3);
      attach(h3, script.beats.find((b) => b.room === room.index && b.kind === 'room-intro'));
      for (const rd of room.roundsData) {
        for (const phase of ['declare', 'talk', 'commit'] as const) {
          const events = rd.events.filter((e) => e.phase === phase);
          const shown = events.filter((e) => ['say', 'whisper', 'order', 'draft', 'commit', 'thought', 'name', 'note_to_ingram', 'refused', 'malformed'].includes(e.type));
          if (shown.length === 0) continue;
          const h4 = el('h4');
          h4.append(document.createTextNode(`Round ${rd.round} · `), el('span', 'ph', PHASE_TITLE[phase]));
          this.log.append(h4);
          attach(h4, fallback(room.index, rd.round, phase));
          for (const e of shown) {
            if (e.type === 'name') names[e.from] = e.name;
            const node = this.entry(e, names, rd.events);
            if (!node) continue;
            this.log.append(node);
            attach(node, beatOf.get(e.id) ?? fallback(room.index, rd.round, phase));
          }
        }
        if (rd.resolve) {
          const box = this.happened(rd.resolve.results, rd.resolve.events, names);
          this.log.append(box);
          attach(box, script.beats.find((b) => b.kind === 'resolve' && b.room === room.index && b.round === rd.round));
        }
      }
      if (room.end) {
        const box = el('div', 'happened');
        box.append(el('div', 'ttl', 'Room over'));
        box.append(el('div', '', `It ended because ${room.end.reason}.`));
        box.append(el('div', '', `Through the exit: ${room.end.through.map((b) => nameOf(b, names)).join(', ') || 'nobody'}.`));
        this.log.append(box);
        attach(box, script.beats.find((b) => b.kind === 'room-end' && b.room === room.index));
        for (const e of room.closingEvents) {
          if (e.type !== 'notebook') continue;
          const d = el('details', 'notebook');
          botVars(d, e.from);
          d.append(el('summary', '', `${nameOf(e.from, names)}'s notebook`), el('p', '', e.text));
          this.log.append(d);
        }
      }
    }
  }

  private entry(e: GameEvent, names: Readonly<Record<string, string | null>>, roundEvents: readonly GameEvent[]): HTMLElement | null {
    const from = authorOf(e);
    if (!from) return null;
    const node = el('div', 'entry');
    botVars(node, from);
    const body = el('div', 'body');
    const head = el('div', 'head', nameOf(from, names));
    const kind = (text: string) => head.append(el('span', 'kind', ` ${text}`));
    switch (e.type) {
      case 'say':
        if (e.to !== 'all') kind(`to ${nameOf(e.to, names)}`);
        body.append(head, document.createTextNode(e.text));
        break;
      case 'whisper': {
        node.classList.add('whisper-e');
        const k = el('span', 'kind');
        k.innerHTML = ` ${ICON.lock} whispers to `;
        k.append(document.createTextNode(nameOf(e.to, names)));
        head.append(k);
        body.append(head, document.createTextNode(e.text));
        break;
      }
      case 'order':
        kind(`orders ${nameOf(e.to, names)}`);
        body.append(head, el('code', 'cmd', e.command));
        break;
      case 'draft': {
        node.classList.add('plan-e');
        kind('plans');
        const cmds = el('div', 'chipline');
        commandChips(cmds, e.commands);
        body.append(head, cmds);
        break;
      }
      case 'commit': {
        node.classList.add('commit-e');
        // The gap between what a bot declared and what it committed is where betrayal shows (spec section 6).
        const draft = roundEvents.find((x) => x.type === 'draft' && x.from === from);
        const changed = draft?.type === 'draft' && draft.commands.join('|') !== e.commands.join('|');
        kind(changed ? 'commits, not what it planned' : 'commits');
        const cmds = el('div', 'chipline');
        commandChips(cmds, e.commands);
        body.append(head, cmds);
        break;
      }
      case 'thought':
        node.classList.add('thought-e');
        kind('thinks');
        body.append(head, document.createTextNode(e.text));
        break;
      case 'name':
        node.classList.add('naming-e');
        kind(e.previous ? `renames itself from “${e.previous}”` : 'names itself');
        body.append(head, el('b', '', `“${e.name}”`));
        break;
      case 'note_to_ingram': {
        node.classList.add('naming-e');
        kind('note to Ingram');
        body.append(head, el('span', 'note', `“${e.text}”`));
        break;
      }
      case 'refused':
        node.classList.add('note-e');
        kind('refused');
        body.append(head, document.createTextNode(`${e.what}: ${e.reason}`));
        break;
      case 'malformed':
        node.classList.add('note-e');
        kind('unreadable reply');
        body.append(head, document.createTextNode(e.fallback ? `${e.error}; it did nothing this step` : `${e.error}; asked again`));
        break;
      default:
        return null;
    }
    node.append(dot(from), body);
    return node;
  }

  /** After the world moves: each bot's commands and how they went, and what changed. */
  private happened(results: { bot: string; command: string; status: string; reason: string | null; note: string | null }[], changes: readonly WorldEvent[], names: Readonly<Record<string, string | null>>): HTMLElement {
    const box = el('div', 'happened');
    box.append(el('div', 'ttl', 'What happened'));
    for (const bot of [...new Set(results.map((r) => r.bot))].sort()) {
      const mine = results.filter((r) => r.bot === bot && r.status !== 'skipped');
      const failed = mine.find((r) => r.status !== 'done');
      const row = el('div', 'row');
      row.append(dot(bot));
      const text = el('span');
      if (mine.length === 0) text.textContent = `${nameOf(bot, names)} did nothing.`;
      else if (!failed) text.append(el('span', 'ok', '✓ '), document.createTextNode(`${nameOf(bot, names)}: all ${mine.length} command${mine.length === 1 ? '' : 's'} done.`));
      else text.append(el('span', 'no', '✕ '), document.createTextNode(`${nameOf(bot, names)}: ${failed.command} ${failed.status === 'cut' ? 'ran out of time' : 'failed'}: ${shortReason(failed.reason, 70)}`));
      row.append(text);
      box.append(row);
    }
    for (const w of changes) {
      const line =
        w.type === 'door' ? `Door ${w.door} ${w.open ? 'opened' : 'closed'}.` :
        w.type === 'plate' ? `Plate ${w.plate} ${w.pressed ? 'went down' : 'came back up'}.` :
        w.type === 'lever' ? `Lever ${w.lever} turned ${w.on ? 'on' : 'off'}.` :
        w.type === 'coin' ? `${nameOf(w.bot, names)} picked up coin ${w.coin}.` :
        `${nameOf(w.bot, names)} went through exit ${w.exit}.`;
      box.append(el('div', 'w', line));
    }
    return box;
  }

  /** Light up the lines of the beat playing now. */
  highlight(beatIndex: number): void {
    const next = this.byBeat.get(beatIndex) ?? [];
    if (next === this.current) return;
    for (const n of this.current) n.classList.remove('current');
    for (const n of next) n.classList.add('current');
    if (next.length > 0) {
      this.current = next;
      this.scrollToCurrent(false);
    }
  }

  private scrollToCurrent(force: boolean): void {
    if (!this.follow && !force) return;
    const first = this.current[0];
    if (!first) return;
    const top = first.offsetTop - this.log.clientHeight * 0.3;
    this.programmaticScroll = performance.now();
    this.log.scrollTo({ top: Math.max(0, top), behavior: 'auto' });
  }
}
