# TheBotProblem

A turn-based, Mario-style platformer that LLM bots play together, and a replay viewer for watching what happened afterwards. It is an experiment first and entertainment second: groups of independent thinkers solving physical puzzles while unsure of each other.

- The brief: [docs/SPEC.md](docs/SPEC.md)
- Where each milestone stands: [docs/STATE.md](docs/STATE.md)
- Decisions and verified facts: [docs/DECISIONS.md](docs/DECISIONS.md)

## Money first

Every bot call is paid from your own credit, so the project is built around never wasting it:

- Everything is developed and tested with free mock players. The tests *cannot* reach the network: [tests/setup.ts](tests/setup.ts) blocks it.
- A paid run happens only when you say so, after an estimate has shown what it should cost. `npm run game` prints its estimate from real prompts and waits for you to type yes.
- Hard caps live in [config/game.json](config/game.json): **$1.50 per run**, **$0.75 per bot**, and lifetime caps of **$8.50 Anthropic / $5.50 OpenRouter**. Set those a little under your own credit. A phase only starts if its *worst case* fits every cap, so a cap can't be overshot.
- Every call is priced into a ledger. The lifetime record is `spend/global-spend.json`. Don't delete it: it is how the lifetime caps remember earlier runs.
- API keys are read only from `.env`. They are never printed, never logged and never committed.

## Commands

Run these in the project folder. All are free except `format-test`, a paid `game` and a paid `direct`.

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
| `npm run view` | **Watch recorded games** in your browser: pick one from the list. Free. A game with a story opens in **Story** mode (a few minutes, told by the Director); **Full game** plays every moment. Space plays and pauses, the arrows step (in a story, by segment), Shift+arrows skip a round, T cycles the thoughts, W shows the wiring. Clicking a line in the transcript opens that moment in the full game. |
| `npm run direct -- <run>` | **The Director** tells a recorded game as a story of 3 to 7 minutes: chapters, narration, the key conversations, quotes from the bots' private writing, fast-forwards between. Haiku reads each room, Sonnet edits. **Costs a little (about $0.05 a game)**; it prints the estimate and waits for `yes`. `-- --dry-run` for the estimate only, `-- --free` for the free Director (no model, plain narration). Replies are recorded, so directing the same game again is free. Writes `runs/<run>/story.json`. |
| `npm run voice -- <run>` | **Gives a recorded game's bots their voices**, free, on this machine (Kokoro-82M; the first time it downloads the model, about 90 MB). Each bot gets its own voice from its personality. It voices the Director's chosen lines and its narration (in a narrator's voice of its own), the introductions, the diary room and the messages to you; `-- --all` voices every line said aloud (slower, still free). In `npm run view`, the **Voices** switch plays them. Writes `runs/<run>/voice/`; the cast in its `index.json` can be edited, then voiced again. |
| `npm run game -- --mock` | A whole free game, every bot played by the seeded mock player. `-- --scripted` instead plays each level's own solution, so everyone gets out. |
| `npm run game` | **A paid game** with the cast in `config/cast.json`. It plays a free mock game first to measure the prompts, prints the estimate, and waits for you to type `yes`. `-- --dry-run` stops after the estimate. `-- --levels P0,L1` picks rooms, `-- --max-rounds 2` shortens them, `-- --run-cap 0.50` sets this run's cap, `-- --exile-from 1` lets exile votes start in an earlier room. The levers ([docs/LEVERS.md](docs/LEVERS.md)), for one game: `-- --talk-every 3` (talk only every third round), `-- --praise` (the host congratulates the richest bot), `-- --bounty first_out:3,left_behind:2` (coins the host offers in every room), `-- --no-host` or `-- --no-judge` (no introductions, or no judging of them), `-- --turn-order letter` (ties go by letter instead of by name, the default, which the bots are never told). Rooms made for experiments (`config/levels/experiments/`) play only when named: `-- --levels P0,L6,L7`. Afterwards it checks its own estimate against the bill. Results go to `runs/<time>-game/`; start with `summary.md`. |
| Memory between games | Paid games remember: each agent keeps its name, notebook and strategy in `memory/default.json`, and may privately pick a new name for its next game. `-- --memory <bank>` uses another bank, `-- --fresh` plays without memory, `-- --continue-from runs/<run>` starts an empty bank from the bots of a recorded game. Letters are dealt afresh each game, so a private rename stays private. |
| `npm test` | Runs every test. `npm run check` also type-checks. |

## Layout

| Folder | What's in it | Milestone |
|---|---|---|
| `budget/` | Money: usage counting, price table, ledger, spend caps, lifetime record, estimator | 0 (done) |
| `harness/` | Keys, config loading, run folders, the fake run, the command-line tools (`harness/cli/`) | 0 (done) |
| `config/` | Caps, token limits and hidden-stat ranges (`game.json`), prices, the casts (`cast*.json`), levels (`levels/`) | 0–1 (done) |
| `tests/` | Unit and acceptance tests, including the leak test | 0–3 (done) |
| `engine/` | Physics, commands, levels, line of sight, the move menu, the solution validator. Pure code with no file access, so the viewer can use it too | 1–3 (done) |
| `agents/`, `prompts/` | The players (mock, scripted, replay, Claude and OpenRouter) and the rulebook they're given | 2–3 (done) |
| `game/` | Turn loop, event log with audiences, view-builder, witnesses, reply checking, the social systems (constitution, justice, trade, scores), memory between games, run summary | 3, 5 |
| `viewer/` | The browser replay viewer (Vite, canvas for the world, HTML for the words), with Story mode | 4, 5 |
| `analysis/` | The Director: what it reads (`material.ts`) and how it tells a game (`director.ts`) | 5 |
| `voice/` | Voices | 7 |
| `runs/` | One folder per run: summary, replay, every prompt and reply, state, ledger, and the story if directed (git-ignored) | |
| `memory/` | The agents' memory banks: names, notebooks, strategies (git-ignored) | |
| `spend/` | Lifetime spend record and the paid-run lock (git-ignored, keep it) | |

Code runs straight from TypeScript through [tsx](https://tsx.is) (scripts) and [Vitest](https://vitest.dev) (tests). Nothing is compiled to JavaScript files.
