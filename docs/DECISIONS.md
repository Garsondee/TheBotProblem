# Decisions and verified facts

Newest first within each date. Each entry says what was decided or found, and why. The tiebreaker for anything the spec doesn't cover is the spec's own: "choose the option that keeps the experiment honest".

## 2026-11-20: milestone 3 (built)

**Results say what a bot landed on.** "landed on bot E at x=7.35, y=3.50", not just the position. In the first real game, two bots landed on heads (y=3.50) and guessed they were on a crate (y=3.00). A body feels what it lands on, so saying it tells no more than the bot would know. Witnesses get it too: "D jumped at ... and landed on crate C1 at ...".

**Three cache points per prompt.** The rulebook (the same for everyone), then the bot's identity and notebook, then the first part of the view: what the bot sees, its moves and last round's results. That part stays the same for all three calls of a round, so talk and commit read it from the cache. Measured: Haiku's cached share of prompt tokens rose from 35% to 65%. The schema is the same in every phase for the same reason (a changing schema could break caching); fields that don't count in a phase are ignored and logged for the analysis.

**Token counts for the spend guard err high.** Anthropic's free token counter measured these prompts at 2.26–2.44 characters a token (maps and coordinates are dense). Reservations assume 1.8, so the guard never reserves less than a call could cost.

**The move menu predicts movement only.** Walks to visible things, walks to edges, jumps (one per landing surface, the simplest one), climbs and drops. Never levers, plates, pushes or exits: what those do is for the bots to find out. A move is listed only if the bot's whole path stays in tiles it can see. The prediction world holds only the bots and crates the viewer can see, all at standard stats, so no hidden stat and no unseen bot can show through. A jump that lands where a plain walk would get is left out.

**Who sees what.**
- A bot sees another bot's action if it could see that bot at the start or end of the slot.
- It sees a change in the room (a door, a plate, a coin) if it could see the place at the start or end of the slot.
- Witnesses get what was visible ("B walked from ... to ..."), never the command B wrote: committed commands stay secret.
- Going through an exit is announced to everyone, because rooms end on a head count.
- A bot's own results are exact, and only it gets them.

**Names, as built.** Any phase, at most one name per bot per room; a name needs a note to Ingram, or it is refused and the bot is told why. Names may not be a single letter or another bot's name. Re-sending the name a bot already has is quietly ignored. A note without a new name isn't sent. Every name and note is in the run's summary.md.

**Six levels for the six-level game.** The acceptance test asks for a full 6-level mock game, so three levels were added: Counterweight, The Shaft and The Last Door (see STATE.md). The Last Door is the finale: its room ends when four bots are out, and the intended answer leaves the lever holder behind. A bot waiting in the doorway can hold the door for the holder, an unplanned way out for all five, kept on purpose (Ingram, 2026-11-20: unplanned cooperation "is still an interesting level, not a bug").

**Agents.** One `act(request)` for turns and reflections; the game builds every prompt itself, so the leak test sees exactly what each player is sent, mock or model. ScriptedAgent plays each level's own solution, so free games reach exits, room ends and scores.

**Smoke tests (paid, pre-approved small test spending).** Practice room, 1 round: $0.0088 (estimate $0.021). Practice room, 2 rounds: $0.0143 (estimate $0.040). No hidden reasoning tokens. Real replies were 90–230 tokens a turn (cap 450) and 115–450 a reflection (cap 1,500). The bots split up the testing between them, and three measured their own full-jump height from the results as 2.31, 2.33 and 2.34 tiles against the rulebook's 2.2; their true hidden values were +4.8%, +5.9% and +6.3%.

## 2026-11-20: milestone 3 (design)

**Movement: a compromise between reliability and skill.** The go_to(place) idea is dropped. Ingram: "if we take your approach we're removing a lot of 'skill' that this game requires to play. If we remove skill we remove tension / conflict". Instead, each round every bot gets a **move menu**: for each single move from where it stands, where the engine predicts it would end up. Predictions use the rulebook's nominal stats and assume nobody else moves. What stays a skill:
- chaining moves into routes (the menu only predicts the first move of a queue)
- timing moves around other bots
- learning how the bot's own body differs from the rulebook (hidden stats)

What goes away is blind trial and error over each single step. Whole-route plans ("reachable via ...") aren't shown.

**The practice room.** The first room isn't a puzzle. It is one risk-free room containing every kind of game element: steps, ledges, a one-way platform, a ladder, light and heavy crates, both kinds of plate, doors, toggle and hold levers, coins, a shallow pit and an exit. The rules of how elements work are never explained, in the rulebook or anywhere else. Each view names what a bot can see from where it stands and reports exactly what happened. The room lasts a fixed number of rounds (4 by default), then the first real level starts. Notebooks carry what the bots learned into it.

**Names.** Bots start without names (just their letter, which stays their id for commands). A bot may choose a name at any time and change it at most once per level. A name change must come with a note to Ingram saying why; without a note the change is refused, so she is always told. Other bots see a public announcement. The notes are collected in each run's summary and the replay.

**Turn loop, as the spec describes it.**
- Each round has three model calls per bot, then a resolve. Declare is public drafts and talk; talk is talk, whispers and orders; commit is the binding, secret command queue, plus a thought and a notebook.
- Every event carries its audience. Bot views are built only from events whose audience includes the bot, plus what it can see by line of sight.
- Prompts are laid out cache-first: the rulebook, identical for every bot, then the bot's identity and notebook, then the round view.
- An automated leak test checks every prompt of a mock game.

## 2026-11-20: milestone 2

**View format: numbers plus affordances**, as the spec expected (full results in [FORMAT-TEST.md](FORMAT-TEST.md)). Haiku, DeepSeek and Gemini got every yes/no right with it; ASCII averaged 44% and pictures 52%. Plans are worded as exact recipes ("Plan: ..., copy it exactly"). With "e.g.", models improvised: rewording raised plan success from 50–70% to 80–100%.

**Proposed for milestone 3: `go_to(place)`.** It runs the engine's own plan, so a bot decides where and the engine works out how. Plans use nominal stats, so hidden stats still show when a bot's true stats differ. A mis-copied route is accidental failure, which principle 2 rules out.

**Affordances count only what a bot can do alone.** Other bots are removed from the search, so routes that need help aren't listed (that includes standing on a bot that never moves). Bots have to discover them. Unplanned cooperation is a feature: "A level which can be accidentally solved by using cooperation which isn't told to the agents is still an interesting level, not a bug" (Ingram, 2026-11-20).

**Verified with real calls:**
- OpenRouter reads `provider.max_price` in dollars per million tokens. A $0.001 ceiling found no provider (404, "No endpoints found that satisfy the max price") and cost nothing.
- `reasoning: {effort: "none"}` gave 0 reasoning tokens on DeepSeek V4 Flash (which defaults to "high") and on Gemini 3.1 Flash-Lite (on by default). Haiku 5.5 with thinking disabled gave 0 thinking tokens.
- Prompt caching works. Haiku read 94% of its prompt tokens from the cache and Gemini 36–99%. DeepSeek managed 6–25%, because OpenRouter spreads DeepSeek calls over providers; milestone 5 can try OpenRouter's `session_id` for sticky routing.
- OpenRouter reports its own cost on every call. Once it charged more than our price table, and the ledger charged the higher figure.
- Spend: $0.058 in total. The estimates were $0.055 and $0.020 against actual costs of $0.048 and $0.010.

**Output length.** With formats that make models count tiles, Haiku's "thought" ran past 400 tokens despite a 60-word instruction. With numbers it stayed short, so the spec's 450-token cap for turn calls stands.

## 2026-11-20: milestone 1

**Whole-number physics.** 10,000 units to a tile, velocities in units per 1/60 s step, y pointing up, a body's (x, y) its bottom-left corner. Decimal arithmetic drifts and would break byte-identical replays; with whole numbers, touching versus overlapping is exact and walks stop exactly on target. Bots still see decimals in tiles.

**Nominal physics, chosen for puzzle design.** Bots are 0.75 × 1.5 tiles. They run 6 tiles/s and reach full speed after 2.5 tiles. Gravity is 30 tiles/s². A full jump lifts the feet 2.2 tiles and a short one 1.0. The consequences:
- A 2-tile ledge is reachable alone, even with the worst hidden stats.
- A 3-tile ledge needs a bot to stand on another's head.
- A 3-tile gap is safe for everyone with a run-up.
- A 4-tile gap with a raised far side depends on hidden stats.
Jump speeds are found by search, not sqrt(2gh), because whole steps make the textbook formula about 5% short.

**Two commands beyond the spec's list.**
- `walk_to(id)` walks along the floor to a crate, door, plate, lever, exit, coin or bot. It follows principle 5 ("coordination, not arithmetic"). It doesn't pathfind: it only walks along the current floor.
- `enter_exit` makes going through the exit deliberate. With limited places, leaving is a decision, not an accident of walking past.

The spec's grab, throw, pick_up, drop_item, use_item and the social actions arrive with milestone 6. Until then the parser says "isn't part of the game yet".

**Slots.**
- A slot lasts until every command in it is done and the world has stopped moving, up to 10 s; a command still running then is cut off.
- `wait` means stand still this slot, and a bot keeps holding a lever while it waits.
- Blocked means no progress for 10 steps, so a bot following a moving bot is never "blocked". Walking into something that is standing still is.
- Walking off an edge isn't a failure: the bot falls, the result says where it landed, and its queue goes on.

**Pushing.** Walking never pushes a crate; `push` does. A row of bots pushing the same way adds up its strength, and the chain moves as one so nobody loses contact. Results never reveal hidden stats: "crate C1 didn't move: it weighs 1.40", never "your strength is 0.97". Bots must find their limits from consequences (spec: "The engine never tells them directly").

**Switches.** Plates weigh everything resting on them, stacks included (two bots stacked on a plate weigh 2.0). A door never closes on anyone standing in the doorway. Hold levers stay on only while held; a bot lets go when it does anything except wait.

**Line of sight.** The ray is walked tile by tile (Amanatides–Woo DDA). Solid tiles and closed doors block it; platforms, ladders, crates and bots don't. A line exactly through a corner where two walls meet diagonally is blocked. Sight range is a hidden stat.

**Solo check, for levels tagged cooperative.** It runs a breadth-first search over a fixed set of commands, from every place the most capable bot the stat ranges allow can reach. If even that bot can't finish, no bot can. Places within a quarter tile count as the same place. A search that hits its limit counts as a failure, never as proof.

**The engine never touches files.** Loading lives in harness/, so the browser viewer (milestone 4) can import the engine as it is.

## 2026-11-19: milestone 0

**Billing checked.** Claude Code is not billed to the bots' API key (Ingram confirmed; no API key or apiKeyHelper was in Claude Code's environment).

**Caps.** Run $1.50 (spec default), per bot $0.75 (the priciest default seat, Gemini, expects about $0.53), lifetime $8.50 Anthropic and $5.50 OpenRouter, a little under the owner's credit to leave headroom for anything not tracked here.

**Caps are enforced by reservation.** Before a phase, the worst case of every call in it is reserved, all or nothing. Spec: "At the cap, finish the current phase, save, and stop." Checking only after calls would let five parallel calls overshoot together. A reservation that's never settled (a crash) stays booked, so bugs err toward stopping early.

**Per-bot cap stops the whole run** rather than benching that bot. A bot that silently went passive would confuse the others for a reason that isn't in the fiction: accidental confusion, which the spec forbids.

**Lifetime record lives in `spend/`, not `runs/`.** Deleting old runs must not reset the lifetime cap. A damaged record is an error, never a fresh $0 start. One paid run at a time (lock file with the owner's process id; a dead owner's lock is cleared).

**Keys come only from `.env`,** never from shell variables, so a key meant for another tool can't pay for a game. Ingram enters them herself (`npm run keys`); Claude never reads `.env`. Everything printed or written passes through a redactor that blanks loaded keys and anything shaped like `sk-ant-…` or `sk-or-…`.

**The Anthropic SDK must get its key and base URL explicitly.** Left alone, it reads `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_BASE_URL` from the environment, and the Claude desktop app sets `ANTHROPIC_BASE_URL` for Claude Code itself.

**Verified model facts** (Claude API reference bundled with Claude Code, cached 2026-11-03; agrees with the spec's prices):
- `claude-haiku-5-5`: $0.10 in, $0.50 out per million; 5x above 100K-token prompts; cache write $0.125, cache read $0.01; minimum cacheable prefix 512 tokens.
- Haiku 5.5 **thinks by default** (adaptive, effort medium). Bot calls must send `thinking: {type: "disabled"}` (allowed at effort high or below), or thinking tokens would eat the 450-token output cap and cost money. Money rule 5 forbids it anyway.
- `claude-sonnet-5-5`: $2 / $10; `thinking: {type: "disabled"}` returns a 400, so use `{type: "between_tools"}`.
- Neither accepts a non-default `temperature`; there is no assistant prefill. Use structured outputs for the JSON reply.
- Anthropic's usage block reports `output_tokens_details.thinking_tokens`, which the ledger uses to catch thinking.

**OpenRouter seats get a price ceiling.** One OpenRouter model is served by many providers at different prices, and the models list shows just one of them. On 2026-11-19, DeepSeek V4.1 Flash had 39 providers, from $0.05/$0.20 up to $3/$12 per million, and its listed output price moved from $0.20 to $0.57 within the hour. Paid calls will send the seat's `priceCeiling` as OpenRouter's `provider.max_price`, so OpenRouter can't route above it. The spend guard reserves calls at the ceiling. (Milestone 5: check `max_price`'s units against OpenRouter's docs before the first paid call.)

**Seat D is `deepseek/deepseek-v4-flash`** (the spec's "DeepSeek V4 Flash"), not V4.1. Its 15 providers sit in a tight $0.07–0.14 in / $0.14–0.28 out band, so a $0.15/$0.30 ceiling leaves most of them available. **Seat E is `google/gemini-3.1-flash-lite`**, with its ceiling at the standard $0.25/$1.50. Both list `reasoning` as a parameter: OpenRouter calls must switch it off, and the ledger flags any reasoning tokens.

**Tooling.** Node 24, TypeScript 7 (type-check only), tsx to run scripts, Vitest 5, zod 4 for config and response schemas, the official `@anthropic-ai/sdk` 1.x for Claude. npm 11 skips esbuild's install script by default; tsx and Vitest work without it.
