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

`npm run check` (type-check and tests), `npm run estimate`, `npm run fake-run -- --run-cap 0.10`, `npm run prices`, `npm run check-env`.

## Gotchas

- Windows and PowerShell; the project path contains spaces.
- Give the Anthropic SDK `apiKey` and `baseURL` explicitly: the desktop app sets `ANTHROPIC_BASE_URL` in Claude Code's environment.
- Haiku 5.5 thinks unless sent `thinking: {type: "disabled"}`; Sonnet 5.5 needs `{type: "between_tools"}`. Neither takes `temperature`.
- OpenRouter seats: send `provider.max_price` from the seat's `priceCeiling`, and switch reasoning off.
