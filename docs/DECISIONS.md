# Decisions and verified facts

Newest first within each date. Each entry says what was decided or found, and why. The tiebreaker for anything the spec doesn't cover is the spec's own: "choose the option that keeps the experiment honest".

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
