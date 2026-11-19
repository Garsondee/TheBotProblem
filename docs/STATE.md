# State board

Updated 2026-11-19. One row per milestone in [SPEC.md](SPEC.md) section 9.

Stages: **not started** → **building** → **built and tested** (the acceptance test passes and Claude has run it) → **seen by Ingram** (finished). Passing tests is not the same as finished.

| # | Milestone | Stage | Paid? | How to see it |
|---|---|---|---|---|
| 0 | Setup, config, .env handling, price table, usage ledger, spending caps | **Built and tested.** 83 tests pass; Claude ran every command. Not yet seen by Ingram. | No | `npm run fake-run -- --run-cap 0.10`, `npm run estimate`, `npm run keys` |
| 1 | Physics engine, level format, line of sight, solution-script validator, 3 levels | Not started | No | |
| 2 | Interface format test | Not started | ~$0.10 | |
| 3 | Turn loop, event log, view-builder, response schema, full mock game, leak test | Not started | No | |
| 4 | Viewer: rendering, bubbles, full mode, timeline, spectator overlay | Not started | No | |
| 5 | Text-only social pilot with real models | Not started | ~$0.30 | |
| 6 | Roles, deception, rumours, hidden stats, pressures, tension controller, measurement | Not started | ~$1.50 | |
| 7 | Highlights, Kokoro voices, highlights mode, diary scenes, final messages | Not started | ~$0.10 | |
| 8 | Folklore, forks, persona evolution | Not started | ~$0.70 a game | |

## Milestone 0: what exists

- **Usage ledger** ([budget/ledger.ts](../budget/ledger.ts)): prices every call from its usage block (cache reads and writes included) and keeps totals per bot, phase, provider, model and run. For OpenRouter it charges the larger of our price and OpenRouter's own reported cost. It flags hidden reasoning tokens and 1-hour cache writes.
- **Spend caps** ([budget/spendGuard.ts](../budget/spendGuard.ts)): per run, per bot (a seat can have its own), and lifetime per provider, on disk in `spend/` behind a one-paid-run-at-a-time lock. A phase is reserved at its worst case before it starts, so a cap can never be overshot and a phase that starts always finishes.
- **Price table**: Anthropic in [config/prices.json](../config/prices.json); OpenRouter fetched live by `npm run prices` and the estimator. OpenRouter seats carry a price ceiling (see DECISIONS.md).
- **Estimator** (`npm run estimate`): the default cast is expected to cost **$1.00 a game** (worst case $1.56; the run cap catches that). OpenRouter credit is the binding limit at about 8 games.
- **Keys** (`npm run keys`, `npm run check-env`): read only from `.env`, never printed; seats without a key fall back to mock mode.
- **Fake run** (`npm run fake-run`): milestone 0's acceptance test, also used as a demo.

## Known gaps, to close in later milestones

- `npm run check-env -- --online` hasn't been run yet: it needs your keys in `.env`. It runs no model and spends nothing.
- OpenRouter's usage field names (`cost`, `cached_tokens`, `cache_write_tokens`) are taken from its docs and checked against real responses only in the first paid OpenRouter run (milestone 5).
- The estimator uses the spec's token assumptions until milestone 3 can measure real prompts.
- "Fail loudly if cache hit rates are near zero": the ledger already measures hit rates per bot; the rule that stops a run arrives with the first paid run (milestone 2 or 5).
- No CI yet (the spec wants level-validity tests in CI). Set it up when the repo has a GitHub remote.
