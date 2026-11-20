# State board

Updated 2026-11-20. One row per milestone in [SPEC.md](SPEC.md) section 9.

Stages: **not started** → **building** → **built and tested** (the acceptance test passes and Claude has run it) → **seen by Ingram** (finished). Passing tests is not the same as finished.

| # | Milestone | Stage | Paid? | How to see it |
|---|---|---|---|---|
| 0 | Setup, config, .env handling, price table, usage ledger, spending caps | **Built and tested**, on GitHub. Not yet seen by Ingram. | No | `npm run fake-run -- --run-cap 0.10`, `npm run estimate`, `npm run keys` |
| 1 | Physics engine, level format, line of sight, solution-script validator, 3 levels | **Built and tested**, on GitHub. Ingram: "I believe it's tested and up and running". | No | `npm run levels` |
| 2 | Interface format test | **Built and tested**, paid run done ($0.058). Winner: numbers plus affordances. Not yet seen by Ingram. | ~$0.10 | [FORMAT-TEST.md](FORMAT-TEST.md) |
| 3 | Turn loop, event log, view-builder, response schema, full mock game, leak test | **Built and tested**: the full mock game and the leak test pass; two tiny real games played ($0.023). Ready for the first real run. Not yet seen by Ingram. | No (smoke tests $0.023) | `npm run game -- --mock`, `npm run game -- --scripted`, `npm run game -- --levels P0,L1 --dry-run` |
| 4 | Viewer: rendering, bubbles, full mode, timeline, spectator overlay | Not started | No | |
| 5 | Text-only social pilot with real models | Not started | ~$0.30 | |
| 6 | Roles, deception, rumours, hidden stats, pressures, tension controller, measurement | Not started | ~$1.50 | |
| 7 | Highlights, Kokoro voices, highlights mode, diary scenes, final messages | Not started | ~$0.10 | |
| 8 | Folklore, forks, persona evolution | Not started | ~$0.70 a game | |

## Milestone 3: what exists

- **The practice room** (config/levels/00-practice-room.json): one room with every element the engine has (a step, a ledge, a one-way platform, a ladder, a light and a heavy crate, a plate that counts bots and one that weighs, two doors, a toggle and a hold lever, coins, a shallow pit, the exit). Nothing in it can hurt a bot and nothing counts. It lasts 4 rounds. The rulebook names the elements but never says how they work.
- **Three more levels**, so the game has the spec's six: *Counterweight* (a plate that needs two bots, a hold lever on the far side), *The Shaft* (a ladder that starts out of reach; push the heavy crate under it, or stand on someone and strand the last bot), *The Last Door* (a door open only while someone far away holds a lever: the finale's sacrifice, with an unplanned way out for all five). All pass the validator.
- **The move menu** ([engine/moves.ts](../engine/moves.ts)): each round, each single move from where a bot stands and where it would end, predicted with standard stats from only what the bot can see. Chaining moves is left to the bots.
- **The turn loop** ([game/game.ts](../game/game.ts)): declare, talk, commit, resolve; a reflection at each room's end rewrites each bot's notebook. Names (with notes to Ingram), notebooks and scores carry from room to room. One retry for an unusable reply, then the bot waits.
- **Event log with audiences** ([game/events.ts](../game/events.ts)) and the **view-builder** ([game/view.ts](../game/view.ts)), which only ever reads a bot's own share of the log. Witnesses see actions in their line of sight ([game/witness.ts](../game/witness.ts)).
- **Players** ([agents/](../agents)): MockAgent (seeded, misbehaves on purpose), ScriptedAgent (plays each level's solution), ReplayAgent (replays a recorded game for free), LlmAgent (Claude and OpenRouter seats).
- **`npm run game`**: free mock or scripted games; paid games print an estimate from real prompts and wait for a yes. Every run folder holds summary.md, replay.jsonl, responses.jsonl, prompts.jsonl, state/ and, for paid games, ledger.json.
- **Tested**: the full mock game (practice room plus six puzzles); the leak test (every event behind every prompt was visible to that bot, and every marked text in a prompt traces back to an event that bot may see); determinism (same seed, same replay, byte for byte); a replay from recorded responses alone; a game stopped cleanly by its cap.
- **Seen with real models**: two small practice-room games (1 and 2 rounds). The bots split up the testing between them, whispered, chained moves, and measured their own jump heights from the results to within 0.01 of their true hidden values.
- **Spent so far, lifetime:** about $0.03 of Claude credit and $0.05 of OpenRouter credit.

## Milestone 2: what exists

- **Model clients** ([agents/models.ts](../agents/models.ts)). One shape for Claude and for OpenRouter. Each call sets explicitly:
  - the key and the API address
  - thinking and reasoning off
  - a hard output cap
  - a JSON schema the provider enforces
  - prompt caching
  - for OpenRouter, the seat's price ceiling
- **Affordances** ([engine/affordances.ts](../engine/affordances.ts)): what a bot can reach alone, with nominal stats, as exact plans. The validator's solo check now uses the same search.
- **The format test** (`npm run format-test`) and its results ([FORMAT-TEST.md](FORMAT-TEST.md)). It runs a dry-run estimate first, reserves every call against the caps, records every raw reply, and can re-score recorded runs for free.
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

- Level elements not built yet: keys and items, springs, moving platforms, seesaws, cracking bridges, conveyors, power-ups. They arrive with milestone 6 (pressures and hidden mechanics) or when a level needs them. The spec suggests about 8 levels; there are 6 and the practice room.
- Not in the turn loop yet (spec section 7, milestones 5 and 6): rules and votes, predictions, opinions, roles, rumours, pressures, the diary room and the final message to Ingram. Orders are delivered but obedience isn't measured yet.
- The view doesn't say "you landed 0.38 tiles further than predicted". It gives the exact result next to the move menu's prediction, and the bots do the comparison themselves (in the smoke tests, they did).
- DeepSeek's prompts aren't cached (0% in the smoke tests): OpenRouter spreads its calls over providers. Milestone 5 can try OpenRouter's `session_id` for sticky routing.
- The solo search treats positions within a quarter tile as the same place, and tries a fixed set of commands. A solo route needing finer positioning could be missed. That's fine for these levels, whose cooperation rests on hard limits (a 3-tile ledge, a 1.40 crate, a door far from its plate, a plate that needs two bots).
- Closed in milestone 2: the keys work (`npm run check-env -- --online`), and OpenRouter's usage fields, price ceilings and reasoning switch are verified against real responses.
