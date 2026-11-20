# State board

Updated 2026-11-20. One row per milestone in [SPEC.md](SPEC.md) section 9.

Stages: **not started** → **building** → **built and tested** (the acceptance test passes and Claude has run it) → **seen by Ingram** (finished). Passing tests is not the same as finished.

| # | Milestone | Stage | Paid? | How to see it |
|---|---|---|---|---|
| 0 | Setup, config, .env handling, price table, usage ledger, spending caps | **Built and tested**, committed and on GitHub. Not yet seen by Ingram. | No | `npm run fake-run -- --run-cap 0.10`, `npm run estimate`, `npm run keys` |
| 1 | Physics engine, level format, line of sight, solution-script validator, 3 levels | **Built and tested** (141 tests; Claude ran every level). Not yet committed. Not yet seen by Ingram. | No | `npm run levels` |
| 2 | Interface format test | Not started | ~$0.10 | |
| 3 | Turn loop, event log, view-builder, response schema, full mock game, leak test | Not started | No | |
| 4 | Viewer: rendering, bubbles, full mode, timeline, spectator overlay | Not started | No | |
| 5 | Text-only social pilot with real models | Not started | ~$0.30 | |
| 6 | Roles, deception, rumours, hidden stats, pressures, tension controller, measurement | Not started | ~$1.50 | |
| 7 | Highlights, Kokoro voices, highlights mode, diary scenes, final messages | Not started | ~$0.10 | |
| 8 | Folklore, forks, persona evolution | Not started | ~$0.70 a game | |

## Milestone 1: what exists

- **Physics** ([engine/physics.ts](../engine/physics.ts), [engine/collision.ts](../engine/collision.ts)): 60 steps a second, whole-number units (10,000 to a tile), gravity, acceleration, air control, coyote time, one-way platforms, ladders, axis-separated box collision. Bots stand on each other, block each other, and push crates; a row of bots pushing together adds up its strength.
- **Commands** ([engine/commands.ts](../engine/commands.ts), [engine/controllers.ts](../engine/controllers.ts)): walk, walk_to, walk_to_edge, creep, jump, drop, climb, wait, push, pull_lever, hold_lever, stand_on_plate, enter_exit. Up to 6 slots per bot, played in lockstep ([engine/resolve.ts](../engine/resolve.ts)). Impossible commands come back with an exact reason and stop that bot's queue.
- **Hidden stats** ([engine/stats.ts](../engine/stats.ts)): rolled per bot within the ranges in config/game.json. Results report exact outcomes but never the stats themselves.
- **Switches**: pressure plates (by weight, stacks included, or by bot count), doors that never close on anyone in the doorway, toggle and hold levers, coins, exits with limited places.
- **Line of sight** ([engine/sight.ts](../engine/sight.ts)): tile-by-tile ray casting within each bot's hidden sight range.
- **Levels** (config/levels): *Hold the Door* (plate, door, lever), *Up and Over* (standing on a bot's head to reach a 3-tile ledge, a ladder behind a door), *Heavy Lifting* (two bots push a heavy crate into a hole to hold a plate down, then jump a gap).
- **Validator** ([engine/validate.ts](../engine/validate.ts)): every solution finishes its level with nominal stats, all 64 extreme stat combinations and 40 random rolls. For cooperative levels, a search over every place the most capable possible bot can reach proves no single bot can finish alone. Stats are re-rolled when a solution fails, with a log.
- **Determinism**: the same seed gives a byte-identical trace; checked in the tests and in `npm run levels`.
- **CI**: GitHub Actions runs the type-check, the tests and the level check on every push.

## Known gaps, to close in later milestones

- Level elements not built yet: keys and items, springs, moving platforms, seesaws, cracking bridges, conveyors, power-ups. They arrive with milestone 6 (pressures and hidden mechanics) or when a level needs them. The spec suggests about 8 levels; there are 3 so far.
- Affordances ("reachable: ledge L3 (jump run_up=2)") and "you landed 0.38 tiles further than predicted" messages belong to the view-builder (milestone 3). The engine can already predict by re-running a command with nominal stats.
- The solo search treats positions within a quarter tile as the same place, and tries a fixed set of commands. A solo route needing finer positioning could be missed. That's fine for these three levels, whose cooperation rests on hard limits (a 3-tile ledge, a 1.40 crate, a door 19 tiles from its plate).
- Not yet run live: `npm run check-env -- --online` (needs your keys), and the first CI run on GitHub (after the milestone 1 push).
- OpenRouter usage field names are checked against real responses in the first paid OpenRouter run (milestone 5).
