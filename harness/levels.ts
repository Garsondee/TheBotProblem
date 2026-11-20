/** Loading levels from config/levels/. (The engine itself never touches files, so the viewer can use it.) */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Level } from '../engine/level';
import { LevelFileSchema, parseLevel } from '../engine/level';
import { PROJECT_ROOT } from './config';
import { readJsonFile } from './files';

export const LEVELS_DIR = join(PROJECT_ROOT, 'config', 'levels');

export function loadLevel(path: string): Level {
  try {
    return parseLevel(readJsonFile(path, LevelFileSchema));
  } catch (err) {
    throw new Error(`${path}: ${(err as Error).message}`);
  }
}

/** Every level in the folder, in file-name order (so 01-..., 02-... play in sequence). */
export function loadLevels(dir = LEVELS_DIR): Level[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => loadLevel(join(dir, name)));
}
