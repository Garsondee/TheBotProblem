/**
 * The social systems (spec section 7.1 to 7.5): the rules the bots make for
 * themselves, the exile vote, promises backed by coins, obedience, and the
 * score.
 *
 * "Social power runs through engine-enforced tools; persuasion runs through
 * words. A bot can talk another bot into anything, but it cannot break the
 * mechanics." Everything here is the mechanics: the engine counts the
 * votes, holds the escrowed coins and compares orders with commitments. The
 * rules the bots pass are NOT enforced (spec 7.1): breaking them is allowed,
 * and the group decides what to do about it.
 */
import { formatCommand, parseCommand } from '../engine/commands';

// ------------------------------------------------------------ the constitution (7.1)

export type RuleStatus = 'open' | 'passed' | 'failed' | 'repealed';

export interface Rule {
  id: string;
  text: string;
  by: string;
  /** What passing it does: add a social rule, repeal one, or change the number of votes rules need. */
  kind: 'rule' | 'repeal' | 'threshold';
  /** For repeal: the rule it repeals. For threshold: the new number of yes votes needed. */
  target: string | null;
  yes: Set<string>;
  no: Set<string>;
  status: RuleStatus;
  /** Voting closes at the end of this round's talk step, in this room. */
  closes: { levelIndex: number; round: number };
}

export interface RuleOutcome {
  rule: Rule;
  /** Yes votes it needed. */
  needed: number;
}

export class Constitution {
  readonly rules: Rule[] = [];
  /** Yes votes a rule needs to pass. Starts at a simple majority of all bots (spec 7.1). */
  threshold: number;

  constructor(private readonly botCount: number) {
    this.threshold = Math.floor(botCount / 2) + 1;
  }

  /** Changing the threshold itself takes a supermajority (two thirds of all bots). */
  get supermajority(): number {
    return Math.ceil((this.botCount * 2) / 3);
  }

  neededFor(rule: Rule): number {
    return rule.kind === 'threshold' ? this.supermajority : this.threshold;
  }

  propose(by: string, text: string, kind: Rule['kind'], target: string | null, closes: Rule['closes']): Rule {
    const rule: Rule = { id: `R${this.rules.length + 1}`, text, by, kind, target, yes: new Set([by]), no: new Set(), status: 'open', closes };
    this.rules.push(rule);
    return rule;
  }

  vote(bot: string, id: string, value: 'yes' | 'no'): Rule | string {
    const rule = this.rules.find((r) => r.id === id.toUpperCase());
    if (!rule) return `there is no rule ${id}`;
    if (rule.status !== 'open') return `${rule.id} is no longer open for votes`;
    rule.yes.delete(bot);
    rule.no.delete(bot);
    (value === 'yes' ? rule.yes : rule.no).add(bot);
    return rule;
  }

  /** Close the votes that end at this point; returns what happened to each. */
  close(levelIndex: number, round: number): RuleOutcome[] {
    const out: RuleOutcome[] = [];
    for (const rule of this.rules) {
      if (rule.status !== 'open') continue;
      const due = rule.closes.levelIndex < levelIndex || (rule.closes.levelIndex === levelIndex && rule.closes.round <= round);
      if (!due) continue;
      const needed = this.neededFor(rule);
      rule.status = rule.yes.size >= needed ? 'passed' : 'failed';
      if (rule.status === 'passed') {
        if (rule.kind === 'repeal' && rule.target) {
          const old = this.rules.find((r) => r.id === rule.target && r.status === 'passed');
          if (old) old.status = 'repealed';
        }
        if (rule.kind === 'threshold' && rule.target) this.threshold = Math.min(this.botCount, Math.max(1, Number(rule.target)));
      }
      out.push({ rule, needed });
    }
    return out;
  }

  /** The rules in force, for every bot's view. */
  inForce(): Rule[] {
    return this.rules.filter((r) => r.status === 'passed' && r.kind === 'rule');
  }

  open(): Rule[] {
    return this.rules.filter((r) => r.status === 'open');
  }
}

// ------------------------------------------------------------ escrow: promises backed by coins (7.4)

export interface Escrow {
  id: string;
  from: string;
  to: string;
  coins: number;
  terms: string;
  levelIndex: number;
  status: 'held' | 'released' | 'refunded';
}

export class EscrowBook {
  readonly all: Escrow[] = [];

  open(from: string, to: string, coins: number, terms: string, levelIndex: number): Escrow {
    const e: Escrow = { id: `E${this.all.length + 1}`, from, to, coins, terms, levelIndex, status: 'held' };
    this.all.push(e);
    return e;
  }

  held(): Escrow[] {
    return this.all.filter((e) => e.status === 'held');
  }

  /** Coins a bot has locked in escrow right now. */
  lockedBy(bot: string): number {
    return this.held().filter((e) => e.from === bot).reduce((n, e) => n + e.coins, 0);
  }
}

// ------------------------------------------------------------ orders and obedience (7.2)

export type Verdict = 'obeyed' | 'partly' | 'ignored' | 'unable';

/**
 * Did the target do what it was ordered to? Compared with what it actually
 * COMMITTED (spec 7.2): obeyed if the ordered command is in its queue,
 * partly if the same kind of command is there with different details,
 * ignored otherwise; unable if it couldn't act at all (out of the room, or a
 * ghost).
 */
export function judgeOrder(ordered: string, committed: readonly string[] | null): Verdict {
  if (committed === null) return 'unable';
  const norm = (c: string) => {
    const p = parseCommand(c);
    return p.ok ? formatCommand(p.command) : c.trim().toLowerCase();
  };
  const want = norm(ordered);
  const kind = want.split('(')[0];
  const got = committed.map(norm);
  if (got.includes(want)) return 'obeyed';
  if (got.some((g) => g.split('(')[0] === kind)) return 'partly';
  return 'ignored';
}

// ------------------------------------------------------------ the score (7.5)

export interface ScoringRules {
  firstOutBonus: number;
  outBonus: number;
  teamBonusPerRoom: number;
}

export interface BotScore {
  /** Coins in the purse (the purse is the score's coin part). */
  coins: number;
  /** Points for getting out of rooms: outBonus each time, firstOutBonus extra for being first. */
  exitPoints: number;
  roomsEscaped: number;
  firstOut: number;
}

export interface TeamScore {
  roomsCompleted: number;
  roundsLeft: number;
}

/** Individual score = coins + exit points; the team's success multiplies it (spec 7.5: "team score as a multiplier"). */
export function finalScore(s: BotScore, team: TeamScore, rules: ScoringRules): number {
  return Math.round((s.coins + s.exitPoints) * (1 + rules.teamBonusPerRoom * team.roomsCompleted) * 10) / 10;
}
