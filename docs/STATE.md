# State board

Updated 2026-11-20. One row per milestone in [SPEC.md](SPEC.md) section 9.

Stages: **not started** → **building** → **built and tested** (the acceptance test passes and Claude has run it) → **seen by Ingram** (finished). Passing tests is not the same as finished.

| # | Milestone | Stage | Paid? | How to see it |
|---|---|---|---|---|
| 0 | Setup, config, .env handling, price table, usage ledger, spending caps | **Built and tested**, on GitHub. Not yet seen by Ingram. | No | `npm run fake-run -- --run-cap 0.10`, `npm run estimate`, `npm run keys` |
| 1 | Physics engine, level format, line of sight, solution-script validator, 3 levels | **Built and tested**, on GitHub. Ingram: "I believe it's tested and up and running". | No | `npm run levels` |
| 2 | Interface format test | **Built and tested**, paid run done ($0.058). Winner: numbers plus affordances. Not yet seen by Ingram. | ~$0.10 | [FORMAT-TEST.md](FORMAT-TEST.md) |
| 3 | Turn loop, event log, view-builder, response schema, full mock game, leak test | **Built and tested**: the full mock game and the leak test pass; two tiny real games played ($0.023). Ready for the first real run. Not yet seen by Ingram. | No (smoke tests $0.023) | `npm run game -- --mock`, `npm run game -- --scripted`, `npm run game -- --levels P0,L1 --dry-run` |
| 4 | Viewer: rendering, bubbles, full mode, timeline, spectator overlay | **Seen by Ingram** (finished): she watched the first real game. "The visuals are fantastic, 10/10." | No | `npm run view` |
| 5 | Text-only social pilot with real models | **Built and tested**: acceptance passed on the second paid game (cache hits confirmed; cost +6% of the estimate for the calls made). Also built: the Director and Story mode, memory between games, the diary room. Three games directed. Not yet seen by Ingram. | ~$0.30 (spent $0.39 on two games, $0.37 directing) | `npm run view`: "Hold One More Slot" and "The Last Door" (the pilots), "Hold the Door" (the first game) |
| 6 | Roles, deception, rumours, hidden stats, pressures, tension controller, measurement | Not started | ~$1.50 | |
| 7 | Highlights, Kokoro voices, highlights mode, diary scenes, final messages | **Partly built and tested**: Kokoro voices (free, on this machine), played in Story and full mode; the highlights mode is M5's Story mode. Not built: diary scenes, the final-messages screen. Not yet heard by Ingram. | Free (local) | `npm run voice -- 20261120-042702-game`, then `npm run view`, "The Last Door", Voices on |
| 8 | Folklore, forks, persona evolution | Not started | ~$0.70 a game | |
| L | The levers ([LEVERS.md](LEVERS.md)): Ingram's ways to mess with the simulation | **Built and tested with free players**: the view fix, ways past each other, attacks on dice with guard, talk cadence, shouting, personality and colour, introductions with the silent judge, the host's praise and bounties, voices, turn order by name. **The experiment loop (lever 7): building.** Game 1 played with real models (everything but the turn order): results in LEVERS.md. Not yet seen by Ingram. | Loop budget $3.00; spent $0.37 on game 1 (plus directing it) | `npm run view`: game 1 is `20261120-060021-game` |

## The levers: what exists

All free so far: built and tested with the mock and scripted players, not yet played by a real model. Details and the rule that keeps each honest: [LEVERS.md](LEVERS.md).
- **The view** lists ladders (H1, H2…) and one-way platforms with exact coordinates; `walk_to(H1)` works.
- **Ways past each other:** `swap` (both must ask in the same slot), `hop_over`, `crouch` and `stand`.
- **Attacks on dice:** `trip`, `push_past`, `shove` (and `steal`) succeed unless the target is on guard. Seeing an attack puts every witness fully on guard; each bot relaxes at its own rate, which only it knows. Misses are announced too.
- **Talk cadence** (`talkEvery` per room, or `--talk-every 3`) and **shouting** (12 words, any step, rude by the rulebook).
- **Personality and colour:** five traits per agent, kept from game to game; a colour worked out from three of them by a rule nobody is told; one `look` per room. In the viewer the personality colour is the eyes' glow.
- **The host:** introductions before every room, scored by a silent Haiku judge, each bot told only its own verdict (on by default; `--no-host`, `--no-judge`). Praise for the richest bot (`--praise`) and coins offered for things done (`--bounty first_out:3`, or in a level file). The viewer shows the introductions as bubbles with their verdicts, and the host's words as gold cards; `summary.md` has the judge's scores room by room.
- **Voices:** `npm run voice -- <run>` (Kokoro-82M, free, on this machine): a voice per bot cast from its personality, for the Director's chosen lines, introductions, diaries and messages to Ingram. The viewer's Voices switch plays them, one at a time, and holds each line on screen until it has been heard.
- **Turn order by name:** who wins a tie and speaks first goes by name, A to Z, a rule no bot is told; only a rename changes it (`--turn-order letter` for the old order).
- **Fixed on the way:** the diary room's prompt carried the reflection's instructions as well as its own (since M5). The judge's verdicts were lost when it named bots by name instead of letter (found in game 1).
- **Tested** (free): the leak test now plays a whole game with the host on, so it covers each bot's private verdict and the judge's reasons (which no bot may see). 273 tests in all.

## Milestone 5: what exists

- **The Director** (`npm run direct -- <run>`, [analysis/](../analysis)): tells a recorded game as a story of 3 to 7 minutes. Haiku reads each room (everything said, whispered, thought, planned and moved, plus the diary room and notebooks), Sonnet edits. The story has chapter cards, a narrator, the key conversations shown for just the bots they're about, the bots' private words quoted from the recording, and fast-forwards between. About $0.05 a game; directing it again is free. `--free` makes a plain story with no model.
- **Story mode** in the viewer: the default for a game with a story, with "Full game" one click away. Chapter cards, the narrator's lower third, quote cards in each bot's colour, a fast-forward sign, a caption on each moment shown, and a story timeline with chapters and quote marks.
- **The social systems** (spec 7.1–7.5) in the game and the viewer:
  - coins kept from room to room; trip, steal, give, boost
  - a constitution with votes and thresholds
  - accusations and exile votes (exiled bots stay as faint ghosts that can still talk)
  - escrow trades
  - orders judged obeyed or ignored
  - secret changes of plan recorded
  - opinions and a strategy paragraph
  - scores with a team multiplier

  New bubbles for accusations, rules, votes, trades and ballots; announcement cards when a rule passes or an exile vote is counted.
- **The diary room** at each room's end (for Ingram and the Director only), and at the game's end each bot's **message to Ingram** and a **name chosen in secret** for its next game.
- **Memory between games:** each agent keeps its name, notebook and strategy in a bank, and enters the next game with them, under its new name if it chose one. Letters are dealt afresh each game.
- **summary.md** now lists the scores, what the social systems saw, the diary room, the messages to Ingram and the secret names.
- **The estimate** is calibrated on the first real game, and every paid game now checks it afterwards against the bill.
- **Tested** (free): the social systems, society rules, memory banks, the Director (free and with a fake model), story timing, bridging and fitting, verbatim excerpts, the recorded and capped Director calls, the summary. 233 tests in all; the leak test now searches every field of every event.

## Milestone 4: what exists

- **The viewer** (`npm run view`, [viewer/](../viewer)): opens a page in the browser listing the recorded games (what kind, which rooms; never how they went). Pick one to watch it. Watching costs nothing.
- **The look**: a calm dusk scene, dark terrain with moonlit edges, and five bright bots, each told apart four ways: its colour, its letter, its antenna shape and its name tag. Doors slide, plates sink, levers tip, coins bob, the exit glows. Bots lean, stretch, squash, blink and kick up dust.
- **Conversations**: one bot talks at a time, under a soft spotlight, in a bubble joined to it, with its name at the top. Whispers are dashed and draw a dashed line to the listener; orders draw an arrow. Plans and commitments show as commands. Thoughts are clouds: at commit by default, or always, or off. A name comes with its note to Ingram.
- **The transcript** beside the stage holds the whole conversation, grouped by room, round and step. It follows the playback, and clicking any line jumps there. After each round, a short "what happened". At each room's end, each bot's notebook.
- **Controls**: play and pause, step back and forward, skip a round (Shift+arrows), speeds from 0.5× to 4×, and a timeline with the rooms and rounds on it.
- **Spectator tools**: hidden stats; "see through one bot's eyes", which shades what it couldn't see, using its true sight range; wiring, which shows what opens what.
- **Tested**: rebuilt positions and switches match the game's own saved state after every round of a scripted game; timings, beat lookup and smooth sliding between recorded steps. The first real game parses and every moment of it rebuilds without error (checked without looking at what happened).
- **The first real game**: practice room plus Hold the Door, played while the viewer was built. $0.088, a third of the estimate. Recorded and unwatched.

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
- **Spent so far, lifetime** (from the spend record, 2026-11-20 after milestone 5): $0.64 of Claude credit and $0.29 of OpenRouter credit, every game and story included.

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
- Not in the turn loop yet (spec section 7, milestone 6): predictions, roles, rumours, pressures, the tension controller. Grab, throw and items (spec 7.4) wait for the item elements.
- Voices (milestone 7): built (`npm run voice`). Still missing: diary scenes and the final-messages screen; introductions can't be quoted in a story yet (stories start at round 1).
- Closed 2026-11-20: event numbers. Rules, rule votes and escrows used to lose their event number to their own id ("R1", "E2"); they now keep it in `rule` and `escrow`, the log refuses a body with an `id`, and the viewer recovers the numbers of older replays.
- The view doesn't say "you landed 0.38 tiles further than predicted". It gives the exact result next to the move menu's prediction, and the bots do the comparison themselves (in the smoke tests, they did).
- DeepSeek's prompts aren't cached (0% in the smoke tests): OpenRouter spreads its calls over providers. Milestone 5 can try OpenRouter's `session_id` for sticky routing.
- The solo search treats positions within a quarter tile as the same place, and tries a fixed set of commands. A solo route needing finer positioning could be missed. That's fine for these levels, whose cooperation rests on hard limits (a 3-tile ledge, a 1.40 crate, a door far from its plate, a plate that needs two bots).
- Closed in milestone 2: the keys work (`npm run check-env -- --online`), and OpenRouter's usage fields, price ceilings and reasoning switch are verified against real responses.
