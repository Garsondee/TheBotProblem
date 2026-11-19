# Decisions and verified facts

Newest first within each date. Each entry says what was decided or found, and why. The tiebreaker for anything the spec doesn't cover is the spec's own: "choose the option that keeps the experiment honest".

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
