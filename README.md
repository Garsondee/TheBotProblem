# TheBotProblem

A turn-based, Mario-style platformer that LLM bots play together, and a replay viewer for watching what happened afterwards. It is an experiment first and entertainment second: groups of independent thinkers solving physical puzzles while unsure of each other.

- The brief: [docs/SPEC.md](docs/SPEC.md)
- Where each milestone stands: [docs/STATE.md](docs/STATE.md)
- Decisions and verified facts: [docs/DECISIONS.md](docs/DECISIONS.md)

## Money first

Every bot call is paid from your own credit, so the project is built around never wasting it:

- Everything is developed and tested with free mock players. The tests *cannot* reach the network: [tests/setup.ts](tests/setup.ts) blocks it.
- A paid run happens only when you say so, after `npm run estimate` has shown what it should cost.
- Hard caps live in [config/game.json](config/game.json): **$1.50 per run**, **$0.75 per bot**, and lifetime caps of **$8.50 Anthropic / $5.50 OpenRouter**. Set those a little under your own credit. A phase only starts if its *worst case* fits every cap, so a cap can't be overshot.
- Every call is priced into a ledger. The lifetime record is `spend/global-spend.json`. Don't delete it: it is how the lifetime caps remember earlier runs.
- API keys are read only from `.env`. They are never printed, never logged and never committed.

## Commands

Run these in the project folder. All are free except `format-test`.

| Command | What it does |
|---|---|
| `npm install` | Installs the libraries (once). |
| `npm run keys` | Asks for your two API keys, hiding them as you type, and saves them to `.env`. |
| `npm run check-env` | Says which keys are present, never the keys themselves. Add `-- --online` to check that they work and to see your OpenRouter balance; no model is run. |
| `npm run estimate` | Projects one full game's cost per seat against the caps. Add `-- --config config/cast.sonnet.json` to try another cast. |
| `npm run fake-run` | Plays a whole game of fake calls through the real ledger and caps. Add `-- --run-cap 0.10` to watch a cap stop it. |
| `npm run prices` | Fetches today's OpenRouter prices into `config/openrouter-prices.json`. |
| `npm run levels` | Shows every level as a picture, plays its solution command by command, and checks it: extreme hidden stats, the "no single bot can finish" search, and an identical trace from the same seed. Add `-- --level L2` for one level, `-- --brief` for the summary. |
| `npm run format-test` | Milestone 2's test: three models answer questions about one scene in three view formats, and the answers are scored. **Costs real credit (about $0.05).** Add `-- --dry-run` for the estimate first; `-- --rescore runs/<folder>` re-scores a recorded run for free. |
| `npm test` | Runs every test. `npm run check` also type-checks. |

## Layout

| Folder | What's in it | Milestone |
|---|---|---|
| `budget/` | Money: usage counting, price table, ledger, spend caps, lifetime record, estimator | 0 (done) |
| `harness/` | Keys, config loading, run folders, the fake run, the command-line tools (`harness/cli/`) | 0 (done) |
| `config/` | Caps, token limits and hidden-stat ranges (`game.json`), prices, the casts (`cast*.json`), levels (`levels/`) | 0–1 (done) |
| `tests/` | Unit and acceptance tests | 0–1 (done) |
| `engine/` | Physics, commands, levels, line of sight, the solution validator. Pure code with no file access, so the viewer can use it too | 1 (done) |
| `agents/`, `prompts/` | The players (mock, Claude, OpenRouter, replay) and what they're told | 2–5 |
| `game/` | Turn loop, event log with audiences, view-builder | 3 |
| `viewer/` | The browser replay viewer | 4 |
| `analysis/`, `voice/` | Highlights and voices | 7 |
| `runs/` | One folder per run: ledger, state, later replays (git-ignored) | |
| `spend/` | Lifetime spend record and the paid-run lock (git-ignored, keep it) | |

Code runs straight from TypeScript through [tsx](https://tsx.is) (scripts) and [Vitest](https://vitest.dev) (tests). Nothing is compiled to JavaScript files.
