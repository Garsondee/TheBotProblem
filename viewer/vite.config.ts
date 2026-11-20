/**
 * The viewer's dev server (npm run view).
 *
 * The viewer is a static page; the only thing it needs from the machine is
 * the recorded games. This plugin serves them, read-only:
 *   GET /api/runs                 the runs that have a replay, newest first
 *   GET /api/runs/<id>/replay.jsonl
 * Nothing else under runs/ is served (responses.jsonl and prompts.jsonl stay
 * on disk), and run ids are checked so a request can't climb out of runs/.
 */
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { defineConfig } from 'vite';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const RUNS = join(ROOT, 'runs');
const SAFE_ID = /^[\w.-]+$/;

/** The first two lines of a file, without reading the whole thing (replays can be megabytes). */
function firstLines(path: string): string[] {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(256 * 1024);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString('utf8').split('\n').slice(0, 2);
  } finally {
    closeSync(fd);
  }
}

function describeRun(id: string): Record<string, unknown> {
  const path = join(RUNS, id, 'replay.jsonl');
  try {
    const [first = '', second = ''] = firstLines(path);
    const header = JSON.parse(first) as { seed?: string; seats?: { bot: string; model: string }[]; levels?: string[] };
    return {
      id,
      seed: header.seed ?? null,
      models: [...new Set((header.seats ?? []).map((s) => s.model))],
      levels: header.levels ?? [],
      bytes: statSync(path).size,
      // Replays from before the viewer existed don't carry their rooms' definitions, so they can't be drawn.
      playable: second.includes('"file":'),
    };
  } catch {
    return { id, seed: null, models: [], levels: [], bytes: 0, playable: false };
  }
}

function runsApi(): Plugin {
  return {
    name: 'bot-problem-runs',
    configureServer(server) {
      server.middlewares.use('/api/runs', (req, res) => {
        const parts = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/')
          .split('/')
          .filter(Boolean);
        if (parts.length === 0) {
          const ids = existsSync(RUNS) ? readdirSync(RUNS).filter((d) => SAFE_ID.test(d) && existsSync(join(RUNS, d, 'replay.jsonl'))) : [];
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(ids.sort().reverse().map(describeRun)));
          return;
        }
        const [id, file] = parts;
        if (parts.length !== 2 || !id || !SAFE_ID.test(id) || file !== 'replay.jsonl' || !existsSync(join(RUNS, id, file))) {
          res.statusCode = 404;
          res.end('not found');
          return;
        }
        res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
        res.setHeader('cache-control', 'no-store');
        res.end(readFileSync(join(RUNS, id, file)));
      });
    },
  };
}

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  // The viewer imports the engine from the folder above (it is pure code, made to be shared).
  server: { port: 5199, fs: { allow: [ROOT] } },
  plugins: [runsApi()],
});
