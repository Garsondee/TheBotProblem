/**
 * The run picker: every recorded game in runs/, newest first. It shows only
 * what kind of game each was and which rooms it had, never how it went, so
 * picking a game doesn't spoil it.
 */
import { el } from './dom';

export interface RunInfo {
  id: string;
  seed: string | null;
  models: string[];
  levels: string[];
  bytes: number;
  playable: boolean;
}

function whenOf(id: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(.*)$/.exec(id);
  if (!m) return id;
  const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  return date.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function kindOf(id: string): 'game' | 'mock' | 'scripted' | 'other' {
  if (/-game(-\d+)?$/.test(id)) return 'game';
  if (/-mock(-\d+)?$/.test(id)) return 'mock';
  if (/-scripted(-\d+)?$/.test(id)) return 'scripted';
  return 'other';
}

export function showPicker(root: HTMLElement, runs: readonly RunInfo[], onPick: (id: string) => void): void {
  const wrap = el('div', 'picker');
  const inner = el('div', 'inner');
  inner.append(el('h1', '', 'The Bot Problem'), el('p', '', 'Pick a recorded game to watch. Watching is free: nothing here calls a model.'));
  const list = el('div', 'runs');
  if (runs.length === 0) {
    list.append(el('p', '', 'No recorded games yet. Run one with npm run game -- --mock (free).'));
  }
  for (const run of runs) {
    const kind = kindOf(run.id);
    const b = el('button', 'run');
    const label = kind === 'game' ? 'real models' : kind === 'mock' ? 'mock players' : kind === 'scripted' ? 'scripted' : 'other';
    const k = el('span', 'kind', label);
    k.dataset.kind = kind;
    const rooms = run.levels.map((l) => l.replace(/^[A-Z]\d+-/, '').replace(/-/g, ' ')).join(' → ');
    const models = kind === 'game' ? run.models.join(', ') : '';
    const note = run.playable ? '' : 'recorded before the viewer existed: it can’t be drawn';
    b.append(el('span', 'when', whenOf(run.id)), k, el('span', 'detail', [rooms, models, note].filter(Boolean).join(' · ')));
    if (run.playable) b.addEventListener('click', () => onPick(run.id));
    else b.disabled = true;
    list.append(b);
  }
  inner.append(list);
  wrap.append(inner);
  root.append(wrap);
}
