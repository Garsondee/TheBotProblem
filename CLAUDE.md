# TheBotProblem: notes for Claude

Read first: [docs/SPEC.md](docs/SPEC.md) (Ingram's brief), [docs/STATE.md](docs/STATE.md) (where each milestone stands), [docs/DECISIONS.md](docs/DECISIONS.md) (verified facts and choices since).

## Working rules

- Build milestones in order (SPEC section 9). When a milestone's acceptance test passes, stop and report: what was built, what was tested, the projected cost of the next step. Update docs/STATE.md, and keep "built and tested" separate from "seen by Ingram".
- Money: the bots' credit is small, and the lifetime caps in config/game.json sit just under it. Never make a paid model call to test code. A paid run happens only on Ingram's explicit yes, after `npm run estimate`.
- The repo may be public: keep personal details (balances, accounts, emails, machine paths) out of every committed file.
- Never open, print or log `.env`. Ingram enters keys herself (`npm run keys`). Only code that sends a request may call `KeyRing.reveal()`.
- Tests must not touch the network: tests/setup.ts blocks `fetch`. Pass a fake `fetch` instead.
- Write comments that explain why: Ingram learns from this code.
- When the spec doesn't settle a question, choose the option that keeps the experiment honest.

## Commands

`npm run check` (type-check and tests), `npm run levels` (every level: picture, solution, validity), `npm run view` (the browser viewer; `?mode=full` skips the story, `?zoom=3&focus=5,3` enlarges a spot, `window.botViewer` jumps to beats and story items), `npm run game -- --mock` / `--scripted` (free games), `npm run game -- --dry-run` (a paid game's estimate, from real prompts), `npm run direct -- <run> --dry-run` / `--free` (the Director's estimate / the free Director), `npm run voice -- <run>` (Kokoro voices, free, local), `npm run estimate`, `npm run fake-run -- --run-cap 0.10`, `npm run prices`, `npm run check-env`. Game flags for the levers (docs/LEVERS.md): `--talk-every`, `--praise`, `--bounty`, `--no-host`, `--no-judge`, `--turn-order`, `--exile-from`.
- Turn order (game/order.ts) is by name and never told to the bots: keep it out of the rulebook and every prompt. Sort with plain character order, never `localeCompare` (machine-dependent).

## The Director and memory

- The Director's story (runs/<id>/story.json) points at moments, not times; viewer/src/story.ts times it, for the viewer and the Director alike. Quotes are event ids: the words always come from the recording, and an excerpt must be in the line word for word.
- `npm run direct` records every reply in runs/<id>/director/calls.jsonl and answers a repeated request from it for free. It is a paid run like a game: estimate first, a yes, its own cap (config/game.json "director").
- Memory banks (memory/*.json) update only when a game completes. A damaged bank stops the game rather than starting the bots afresh.
- The silent judge (prompts/host.ts) is a seat of its own (`~judge`, agents/agent.ts JUDGE_ID): its calls go through the same caps, recording and retries as a bot's. What it scores must never reach a bot's prompt; the leak test plays a hosted game to prove it.
- The browser pane may report the page as hidden, which throttles animation frames to ~2 a second: check playback with `window.botViewer.seek(t)` and screenshots, not real-time play.

## Code layout rules

- engine/ is pure and deterministic: no file access, no clocks, no Math.random. All randomness comes from engine/random.ts streams. The viewer will import it.
- Physics works in whole-number units (engine/constants.ts). Anything a bot reads is converted to tiles with two decimals.
- Result reasons must never reveal hidden stats. State the world's facts, never the bot's numbers.
- Authoring a level: draw it in config/levels/*.json, give it a solution, run `npm run levels`. Watch the ceiling height: a jump in a low room ends at the ceiling. Rooms for experiments go in config/levels/experiments/: validated the same way, played only when a game names them (`--levels P0,L7`).
- Unplanned solutions are features, not bugs. A level that bots can solve through cooperation nobody told them about is interesting (Ingram, 2026-11-20); never redesign a level to remove one. The validator only rejects a cooperative-tagged level that ONE bot can finish entirely alone.

## Gotchas

- Windows and PowerShell; the project path contains spaces.
- Give the Anthropic SDK `apiKey` and `baseURL` explicitly: the desktop app sets `ANTHROPIC_BASE_URL` in Claude Code's environment.
- Haiku 5.5 thinks unless sent `thinking: {type: "disabled"}`; Sonnet 5.5 needs `{type: "between_tools"}`. Neither takes `temperature`.
- OpenRouter seats: send `provider.max_price` from the seat's `priceCeiling`, and switch reasoning off.
