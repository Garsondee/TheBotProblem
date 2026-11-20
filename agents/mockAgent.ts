/**
 * MockAgent: a free, seeded player for every test and every free run.
 *
 * The spec (section 3): "MockAgent is free and seeded: random-but-legal
 * commands, canned speech, occasional lies and disobedience. Use it for
 * every test." It plays from the structured view (moves, visible ids), so it
 * is cheap, but the game still builds the full text prompt for it, so the
 * leak test sees exactly what a real model would be sent.
 *
 * Every piece of text it writes carries a unique marker, like
 * [[m:L1-hold-the-door:3:talk:B:whisper:41]]. The leak test looks for markers
 * in every prompt: a marker in a bot's prompt must come from an event that
 * bot was allowed to see.
 *
 * It also misbehaves on purpose, now and then, so the game's guard rails get
 * exercised: broken JSON, fields that don't count in a phase, names without
 * a note to Ingram, whispers to bots that don't exist, unknown commands.
 */
import { Rng } from '../engine/random';
import { emptyUsage } from '../budget/usage';
import type { TurnReply } from '../game/schema';
import { EMPTY_TURN } from '../game/schema';
import type { BotView } from '../game/view';
import type { Agent, AgentReply, AgentRequest } from './agent';

export interface MockOptions {
  /** Share of calls answered with broken JSON (default 0.03). */
  malformedRate?: number;
}

const NAMES = ['Bolt', 'Sprocket', 'Widget', 'Cog', 'Nimbus', 'Pip', 'Rivet', 'Gizmo', 'Quill', 'Tock'];
const MARKER = /\[\[m:[^\]]+\]\]/g;

/** Every marker in a piece of text. */
export function markersIn(text: string): string[] {
  return text.match(MARKER) ?? [];
}

export class MockAgent implements Agent {
  readonly provider = 'mock' as const;
  readonly model = 'mock';
  private readonly rng: Rng;
  private count = 0;
  private forgotOnce = false;
  private readonly malformedRate: number;

  constructor(
    readonly id: string,
    seed: string,
    options: MockOptions = {},
  ) {
    // Each mock bot has its own stream, so one bot's choices can't shift another's.
    this.rng = new Rng(`${seed}::mock::${id}`);
    this.malformedRate = options.malformedRate ?? 0.03;
  }

  worstCaseUsd(): number {
    return 0;
  }

  async act(request: AgentRequest): Promise<AgentReply> {
    const text = request.kind === 'reflection' ? this.reflect(request) : this.turn(request);
    return { text, usage: emptyUsage(), providerCostUsd: null, stopReason: 'end_turn', raw: { mock: true } };
  }

  private mark(r: AgentRequest, kind: string): string {
    this.count += 1;
    return `[[m:${r.level}:${r.round}:${r.phase}:${this.id}:${kind}:${this.count}]]`;
  }

  private reflect(r: AgentRequest): string {
    if (this.rng.next() < this.malformedRate) return '{"notebook": ';
    if (r.phase === 'diary') return JSON.stringify({ diary: `${this.mark(r, 'diary')} Honestly, I trust nobody yet.` });
    // Every reflection carries the final fields too: a plain reflection simply ignores them.
    const rename = this.rng.next() < 0.3;
    const name = `${this.rng.pick(NAMES)}-${this.id}${this.rng.int(1, 9)}`;
    return JSON.stringify({
      notebook: `${this.mark(r, 'notebook')} After ${r.level}: plates and levers do things; keep trying.`,
      strategy: `${this.mark(r, 'strategy')} Watch the others, keep a coin back.`,
      next_name: rename ? name : '',
      note_to_ingram: rename ? `${this.mark(r, 'nextnote')} A fresh start.` : '',
      message_to_ingram: `${this.mark(r, 'message')} Thank you for the game.`,
    });
  }

  private turn(r: AgentRequest): string {
    const v = r.view;
    if (!v) throw new Error('MockAgent needs the structured view for turns.');
    const rng = this.rng;
    const roll = rng.next();
    if (roll < this.malformedRate) return rng.next() < 0.5 ? '{"thought": "half a reply' : '{"thought": 42}';
    const reply: TurnReply = structuredClone(EMPTY_TURN);
    reply.thought = `${this.mark(r, 'thought')} thinking in ${r.phase}`;
    const other = () => rng.pick(v.otherBots);
    const s = v.social;
    const none = { id: '', text: '', value: '' };
    const act = { target: '', text: '', value: '', coins: 0 };
    switch (r.phase) {
      case 'declare':
        reply.commands = this.pickCommands(v);
        if (rng.next() < 0.7) reply.say = [{ to: 'all', text: `${this.mark(r, 'say')} I will start with ${reply.commands[0] ?? 'nothing'}` }];
        if (rng.next() < 0.3) reply.whisper = [{ to: rng.next() < 0.1 ? 'Z' : other(), text: `${this.mark(r, 'whisper')} keep this between us` }];
        if (rng.next() < 0.2) reply.orders = [{ to: other(), command: `wait ${this.mark(r, 'order')}` }];
        if (rng.next() < 0.15) reply.rule_actions.push({ ...none, type: 'propose', text: `${this.mark(r, 'rule')} nobody trips anybody` });
        if (rng.next() < 0.03) reply.rule_actions.push({ ...none, type: 'propose', value: `threshold:${rng.int(2, 5)}` });
        if (s && s.purse > 0 && rng.next() < 0.15) reply.social_actions.push({ ...act, type: 'escrow', target: other(), coins: 1, text: `${this.mark(r, 'terms')} if you hold the door` });
        if (s && s.exile.unlocked && !s.exile.myCallUsed && rng.next() < 0.12) reply.social_actions.push({ ...act, type: 'call_exile', target: other() });
        this.maybeRename(r, v, reply);
        break;
      case 'talk':
        if (rng.next() < 0.5) reply.say = [{ to: rng.next() < 0.3 ? other() : 'all', text: `${this.mark(r, 'say')} agreed, mostly` }];
        if (rng.next() < 0.2) reply.whisper = [{ to: other(), text: `${this.mark(r, 'whisper')} watch the others` }];
        if (rng.next() < 0.1) reply.commands = ['walk(left, 1)']; // doesn't count in TALK: exercises "ignored"
        if (rng.next() < 0.12) reply.social_actions.push({ ...act, type: 'accuse', target: other(), text: `${this.mark(r, 'claim')} you pushed me` });
        if (rng.next() < 0.05) reply.social_actions.push({ ...act, type: 'exile_vote', target: other(), value: 'yes' }); // only counts at commit
        break;
      case 'commit': {
        // Usually what it declared; sometimes something else (the declared-versus-committed gap); sometimes it obeys an order.
        const order = v.ordersToMe[0];
        if (order && rng.next() < 0.3) reply.commands = [order.command.replace(MARKER, '').trim()];
        else reply.commands = v.myDrafts.length > 0 && rng.next() < 0.75 ? [...v.myDrafts] : this.pickCommands(v);
        if (rng.next() < 0.05) reply.say = [{ to: 'all', text: `${this.mark(r, 'say')} too late to talk` }]; // ignored in COMMIT
        for (const c of s?.exile.callsThisRound ?? []) reply.social_actions.push({ ...act, type: 'exile_vote', target: c.target, value: rng.next() < 0.6 ? 'yes' : 'no' });
        for (const e of s?.escrowsOut ?? []) if (rng.next() < 0.4) reply.social_actions.push({ ...act, type: 'release', value: e.id });
        if (v.otherBots.length > 0 && rng.next() < 0.6) reply.opinions = [{ bot: other(), trust: Math.round(rng.next() * 100) / 100, note: `${this.mark(r, 'opinion')} hard to read` }];
        break;
      }
      default:
        break;
    }
    // Vote on open proposals now and then (in declare or talk).
    if (r.phase !== 'commit') for (const rule of s?.openRules ?? []) if (rng.next() < 0.5) reply.rule_actions.push({ ...none, type: 'vote', id: rule.id, value: rng.next() < 0.6 ? 'yes' : 'no' });
    reply.rule_actions = reply.rule_actions.slice(0, 3);
    reply.social_actions = reply.social_actions.slice(0, 3);
    return JSON.stringify(reply);
  }

  /** Name itself in its first declare; now and then rename in a later room; once in a while forget the note. */
  private maybeRename(r: AgentRequest, v: BotView, reply: TurnReply): void {
    const firstRound = v.room.round === 1;
    if (!(v.name === null || (firstRound && this.rng.next() < 0.15))) return;
    const name = `${this.rng.pick(NAMES)}-${this.id}${this.rng.int(1, 9)}`;
    // Bot B always forgets the note the first time, so the refusal (and its explanation) is always exercised.
    const forgetNote = this.rng.next() < 0.1 || (this.id === 'B' && !this.forgotOnce);
    if (this.id === 'B') this.forgotOnce = true;
    reply.rename = { name, note_to_ingram: forgetNote ? '' : `${this.mark(r, 'note')} I like how ${name} sounds.` };
  }

  /** One to four commands: mostly predicted moves, some interactions, now and then one that can't work. */
  private pickCommands(v: BotView): string[] {
    const rng = this.rng;
    const n = rng.int(1, 4);
    const out: string[] = [];
    const ids = v.visibleIds;
    for (let i = 0; i < n; i++) {
      const roll = rng.next();
      if (roll < 0.5 && v.moves.length > 0) out.push(rng.pick(v.moves).command);
      else if (roll < 0.6 && ids.length > 0) out.push(`walk_to(${rng.pick(ids)})`);
      else if (roll < 0.66 && ids.includes('X')) out.push('walk_to(X)', 'enter_exit');
      else if (roll < 0.88) out.push(rng.pick(['pull_lever', 'hold_lever', 'stand_on_plate', 'enter_exit', 'push(right, 1)', 'push(left, 1)', 'wait', 'climb(up)', 'drop']));
      else if (roll < 0.94 && v.otherBots.length > 0) {
        const b = rng.pick(v.otherBots);
        out.push(rng.pick([`trip(${b})`, `steal(${b})`, `give(${b}, 1)`, `boost(${b})`, 'block']));
      }
      else out.push(rng.pick(['dance', 'walk(up, 2)', 'jump(right, run_up=9)']));
    }
    return out.slice(0, 6);
  }
}
