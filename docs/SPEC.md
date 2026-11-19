# TheBotProblem — build spec

> Pasted by Ingram on 2026-11-19 as the brief for this project. The wording is unchanged; only the layout was turned into Markdown (headings, lists, tables, code blocks) so it reads well in the repo. Decisions and verified facts made since are in [DECISIONS.md](DECISIONS.md); progress is in [STATE.md](STATE.md).

You are building a turn-based, Mario-style platformer that LLM bots play together, plus a replay viewer so a human can watch what happened afterwards. The owner (Ingram) watches recordings later; she does not watch generation live.

**Your role.** You are the sole engineer. Build in the milestone order in section 9. Finish each milestone's acceptance tests before starting the next. Prefer simple, readable code with comments that explain why, because the owner wants to learn from the codebase.

**Money rules (read twice).** The owner has under $10 of Claude API credit and a separate OpenRouter balance. Every paid call must be deliberate.

1. Develop and test everything with the free MockAgent (section 3). Never call a paid API to test code.
2. A paid run happens only when the owner says so. Before it, print an estimated cost from the price table and a token dry-run, then wait for a yes.
3. Every paid run has a hard spending cap (default $1.50). The harness stops cleanly and saves state when it is reached.
4. Record every model response. Replaying, re-rendering, re-analysing and re-voicing a recorded game must cost nothing.
5. Do not use extended thinking. Bot "thoughts" are a capped JSON field (section 6).

**Check this first.** If Claude Code itself is billed to the same API key as the bots, coding will burn the $10 quickly. Tell the owner and ask her to confirm Claude Code runs on her subscription, not the API key.

**Keys.** Read ANTHROPIC_API_KEY and OPENROUTER_API_KEY from a .env file. Add .env to .gitignore. Never print, log or commit keys. If a key is missing, keep working in mock mode and say what is missing.

**Verify, don't assume.** Prices, model IDs, prompt-caching minimum lengths and OpenRouter model slugs change. Check the official docs and the OpenRouter models API before the first paid run, and update config/prices.json.

## 1. Vision and design philosophy

The goal is to watch groups of independent thinkers solve physical puzzles while unsure of each other. It is an experiment first and entertainment second. It is not a machine for laughing at bots that were given bad data by accident.

The design rests on six principles.

1. **The engine owns the truth.** A bot can only know what is in its prompt, so secrecy works by absence. Each bot's prompt is built from an audience-filtered event log. Never rely on "don't reveal X".
2. **Confusion must be designed, not accidental.** Bots should disagree because their views genuinely differ (line of sight, hidden stats, poisoned sensors), never because a view was badly formatted. Every disagreement must be explainable from the omniscient log.
3. **One honest layer.** The referee (engine messages and the rulebook) never lies. The rulebook openly says that hidden mechanics exist, that observations can be faulty or tampered with, and that other players may lie. Deception happens in the fiction: rumours, notes on walls, corrupted sensors, lying bots.
4. **Conflict comes from structure, not personality.** Claude-family models are agreeable and default to polite committees. Scarcity, hidden divergent goals, unequal abilities and time pressure create the tension. Personas only add flavour.
5. **Physics difficulty comes from coordination, not arithmetic.** The simulation is continuous and exact, but bots get exact numbers, engine-computed affordances and quantised commands. Hard puzzles need several bots, not perfect pixel estimates.
6. **Measure everything.** Predictions, diary entries, declared-versus-committed actions and forkable replays turn each run into data you can learn from.

**Expected baseline behaviour.** Without pressure, a cast of Claude bots will likely form roles and protocols quickly, defer to the first confident voice, write due-process rules that neuter the exile weapon, and settle into routine by level 3 or 4. Published social-deduction studies also found LLMs produce deception much better than they detect it, and favour vague, low-risk lies. The systems below exist to keep the game out of that equilibrium without scripting outcomes.

## 2. Budget, model roster and cost controls

The default cast should cost about $1–1.50 per full game: under $0.70 of Claude credit plus under $0.80 of OpenRouter credit. That leaves room for roughly 8–10 games plus analysis on the current budget. These are estimates from prices checked on 19 Nov 2026; verify before the first paid run.

**Default cast (5 bots).** Mixing vendors gives real temperament differences, which a single model family cannot.

| Seat | Model | Provider | Est. cost per game |
|---|---|---|---|
| 1–3 | Claude Haiku 5.5 (claude-haiku-5-5) | Anthropic API | ~$0.12 each |
| 4 | DeepSeek V4 Flash class | OpenRouter | ~$0.20 |
| 5 | Gemini 3.1 Flash-Lite | OpenRouter | ~$0.50 |
| Optional upgrade | Claude Sonnet 5.5 (claude-sonnet-5-5) in one seat | Anthropic API | ~$2.25 |

The estimates assume about 72 rounds per game (6 levels of 12), 3 calls per bot per round, about 6,800 input tokens per call (5,000 cacheable) and 400 output tokens. The whole cast must be configurable in config/cast.json.

**Price table.** Store prices in config/prices.json, in USD per million tokens. Values checked on 19 Nov 2026 from Anthropic's pricing page:

| Model | Input | Output | Cache write (5 min) | Cache read |
|---|---|---|---|---|
| Haiku 5.5 (prompts up to 100K) | 0.10 | 0.50 | 0.125 | 0.01 |
| Sonnet 5.5 | 2.00 | 10.00 | 2.50 | 0.10 |

Haiku 5.5 prices rise 5× for prompts over 100K tokens. Keep every prompt far below that, and assert it in code. Fetch OpenRouter prices from its models API at run start.

**Cost controls.**

- **Usage ledger.** After every call, read the usage block (including cache read and write tokens), price it and add it to a running ledger per bot, per phase and per run. Show it live in the console and save it in the replay.
- **Hard caps.** Per-run cap (default $1.50), per-bot cap, and a global cap across runs stored on disk. At the cap, finish the current phase, save, and stop.
- **Dry-run estimator.** `npm run estimate -- --config <file>` builds real prompts with mock state, counts tokens, and prints a projected cost before any paid run.
- **Prompt caching.** Put the stable prefix first and mark it cacheable (section 6). Verify cache hits with the usage fields during the first paid run, and fail loudly if hit rates are near zero. Check each model's minimum cacheable prompt length. On OpenRouter, check which providers cache automatically.
- **Output caps.** Set max_tokens on every call: about 450 for turn calls, 1,500 for reflections.
- **Cheap analysis.** Post-game analysis runs mostly on Haiku, with a small final pass on Sonnet (section 8).
- **Free voices by default.** Kokoro runs locally at no cost (section 8).
- **Headless mode.** Large experiments (persona evolution, forks) run on the Haiku cast with no voice or visuals, and you watch only the interesting runs.

## 3. Architecture and tech stack

The system is two separate programs that share one file format. A headless generator (Node + TypeScript) runs the game and writes a replay. A browser viewer (Vite + TypeScript + Canvas 2D) plays the replay back. Generation never depends on the viewer, so games can run unattended overnight.

**Pipeline.**

1. generate: run a game and write runs/<run-id>/replay.jsonl, responses.jsonl (every raw model response), ledger.json and state/round-NNN.json snapshots.
2. analyse: read the replay, find highlights and write highlights.json (section 8).
3. voice: synthesise audio for highlighted lines only, and write audio/*.wav and a manifest.
4. view: open the viewer on a run folder.

Each step can be re-run on its own without paying for earlier steps.

**Suggested repo layout.**

```
/engine      physics, levels, validator, line of sight, pressures (pure, deterministic)
/game        turn loop, event log, view-builder, rules/constitution, scoring, roles
/agents      Agent interface + ClaudeAgent, OpenRouterAgent, MockAgent (HumanAgent later)
/prompts     rulebook text, persona templates, tool schema, prompt assembler
/analysis    highlight finder, metrics, calibration scores
/voice       Kokoro wrapper, OpenRouter TTS fallback, voice casting
/viewer      browser replay viewer
/config      cast.json, prices.json, game.json, levels/
/runs        outputs (git-ignored)
/tests       unit + determinism + level-validity tests
```

**Agent interface.** Every player is behind one interface, so the game never knows what kind of player it is talking to.

```ts
interface Agent {
  id: string;
  act(phase: Phase, view: BotView): Promise<AgentResponse>; // validated JSON
  reflect(summary: LevelSummary): Promise<MemoryUpdate>;
}
```

- ClaudeAgent uses the Anthropic Messages API with prompt caching and tool use or strict JSON output.
- OpenRouterAgent uses OpenRouter's OpenAI-compatible chat endpoint.
- MockAgent is free and seeded: random-but-legal commands, canned speech, occasional lies and disobedience. Use it for every test.
- ReplayAgent returns recorded responses so a run can be re-simulated exactly.
- HumanAgent is deferred (section 9), but the interface must allow it.

**Determinism.** All randomness comes from one seeded PRNG per run, split into named streams (level, stats, roles, rumours, poisoning). The same seed and the same recorded responses must reproduce an identical replay, byte for byte. This is what makes forks possible.

**Robust model calls.** Validate every response against a JSON schema. On a malformed response, retry once with the validation error appended. On a second failure, the bot does wait and says nothing, and the engine logs a malformed event the viewer can show. Use timeouts, backoff on rate limits, and run all bots in a phase in parallel.

## 4. World simulation

The world runs continuous physics at a fixed timestep. Bots act through quantised commands, and the engine reports results as exact numbers. Rendering resolution and decision resolution are separate, so pixel-precise puzzles stay possible without asking LLMs to estimate pixels.

**Physics.**

- A single screen, no scrolling, about 40 × 22 tiles. Positions and velocities are floats in tile units.
- Fixed timestep (for example 60 Hz) with gravity, run speed, acceleration, jump impulse, air control, coyote time and one-way platforms. Use axis-separated AABB collision.
- Bots collide with each other. They can stand on each other's heads, push, and block corridors.
- Record the full physics trace (position, velocity and animation state for every entity at every sim step). The viewer interpolates from it, so playback is smooth and exact.

**Commands.** One resolve phase executes up to 6 command slots per bot. All bots resolve slot 1 at the same time, then slot 2, and so on.

- Movement: walk(dir, tiles) with quarter-tile steps, walk_to_edge(dir), creep(dir, 0.25), jump(dir, run_up=0|1|2|3, hold=short|full), drop (through a one-way platform), climb(up|down), wait.
- Interaction: push, grab, throw, pull_lever, hold_lever, stand_on_plate, pick_up, drop_item, use_item.
- Social actions (trip, steal, give, boost) are listed in section 7.
- A command that is blocked or impossible stops that bot's remaining queue for the turn. The engine reports the exact reason. Invalid commands are never punished; they return a reason.

**Hidden per-bot stats.** Each bot gets small, secret differences from the nominal stats in the rulebook. Nobody is told they are different. They have to discover it.

| Stat | Range around nominal | What it changes |
|---|---|---|
| Run speed | ±6% | Who arrives first; timing puzzles |
| Jump height | ±8% | Which ledges a bot can reach alone |
| Jump distance | ±8% | Which gaps a bot can clear |
| Weight | ±15% | Pressure plates, seesaws, cracking bridges |
| Strength | ±15% | Pushing crates, carrying, throwing |
| Sight range | ±10% | Line-of-sight radius |

The stat ranges live in config. Optional chaos stats such as slipperiness or stamina are off by default.

**Discovery by design.** Affordances (section 6) are computed with the nominal rulebook stats, not the true ones. Outcomes then use the true stats and are reported exactly, for example "you landed at x=17.62, 0.38 tiles further than the jump arc predicted". Bots can notice the differences and compare notes. The engine never tells them directly.

**Level elements.** Solid tiles, one-way platforms, ladders, pushable crates, keys and doors, levers (toggle or hold), pressure plates (with weight or bot-count thresholds), springs, moving platforms with a phase schedule ("arrives on turns 3, 7, 11"), seesaws, cracking bridges (break after N crossings), conveyors, narrow one-bot corridors, collectible coins (individual score), scarce power-ups, and exit doors with limited slots.

**Level validity (required).** A level is only playable if it can be completed with the bots' actual rolled stats. The level generator, or the hand-authored level file, must ship a solution script: a per-bot command plan. The validator runs that script in the real simulation with the true stats and pressures. If it fails, the level is invalid. Re-roll the stats or reject the level, and log why. A level must also fail validation when it can be completed by a single bot if it is tagged cooperative. Run validity tests in CI.

## 5. Levels and pressure systems

Every level has one main pressure that forces decisions, and a simple rule-based tension controller keeps it inside a target band. Pressures advance once per round, are visible where line of sight allows, and are described honestly in the rulebook.

**Pressure types.**

| Pressure | How it works | What it forces |
|---|---|---|
| Laser wall | A wall sweeps in from one side by a set distance per round. Touching it exiles the bot for the level. | Leave stragglers or wait for them |
| Rising lava | The floor fills upward each round. Low routes close first. | Who climbs first; giving up a boost |
| Time limit | The exit closes after N rounds; everyone still inside scores zero. | Fast decisions; trusting unverified scouts |
| Collapsing floor | Marked tiles fall a set number of rounds after first being stepped on. | Route planning and blame |
| Flood with air | Water rises; each bot has hidden lung capacity. | Discovering a hidden stat under stress |
| Darkness | Sight ranges shrink each round. | Reliance on other bots' reports |
| Patrol hazard | A drone moves on a fixed route; contact stuns for a round. | Timing and sacrificial distraction |
| Draining power | Doors stay open only while someone holds a lever. | Someone must stay behind |

**Tension controller.** This is an AI Director in the style of Left 4 Dead: a few lines of rules, not an LLM. Each round it measures progress toward the exit and the number of open disputes. If the group is coasting, the pressure speeds up by one notch. If they are stuck in a deadlock, a pressure event forces a decision. Speed changes are capped, logged and visible in the spectator overlay. It never targets a specific bot and never changes outcomes directly.

**Game arc.** A default game has 6 levels, ramping up:

1. Tutorial-style co-op, no scarcity. Teaches the commands.
2. First pressure. Scarce coins add individual competition.
3. Exile weapon unlocks. Limited exit slots.
4. Hidden mechanics and rumours become important. Poisoned sensors switch on.
5. Hard pressure. Optional permanent elimination.
6. Finale: only the top N bots advance, or there is one shared escape that needs a sacrifice.

Store levels as JSON in config/levels/. Start with about 8 hand-authored levels with solution scripts. A procedural generator is optional and later.

**Hidden mechanics.** Each level can include 1–2 undocumented mechanics, such as "a lever only works when two bots are on the plate" or "coins vanish if a bot is tripped while holding them". The rulebook says such mechanics exist. Bots discover them from consequences, which the engine reports honestly.

## 6. Turn loop, information control and prompts

Each round has five phases, and talk happens before the binding commit. The gap between what a bot declared and what it actually committed is where obedience and betrayal show up, and the engine logs it automatically.

**Round phases.**

1. Observe. No model call. The engine builds each bot's view from the event log.
2. Declare (call 1). Each bot posts draft commands (non-binding), public speech, whispers, orders to other bots, and rule proposals or votes.
3. Talk (call 2). Each bot sees the declarations and speech it is allowed to see. It replies, argues, whispers, accuses, votes, and gives its predictions (section 7).
4. Commit (call 3). Each bot submits its final command queue in secret, plus a private thought and its updated opinions.
5. Resolve. No model call. The engine executes all queues in lockstep and records the physics trace. Each bot learns only what it observed.

Cap speech at 2 messages and 60 words per message per phase. Scarce words make bots choose what matters, and they keep costs and audio length down.

**Event log with audiences.** Every event carries an audience list, for example `{round: 14, phase: "talk", type: "whisper", from: "B", to: "D", text: "...", visible_to: ["B", "D"]}`. The view-builder filters the log per bot. The omniscient log keeps everything for the viewer and analysis.

**Line of sight.** Ray-cast from the bot's eye on the tile grid (Bresenham-style or DDA). Solid tiles block sight; a configurable sight range applies. Bots see other bots, items and hazards in sight and witness actions done in sight. Public speech carries everywhere by default; whispers are private. A config option makes shouting range-limited.

**Each bot's view, per call.**

- Its own state as exact numbers: position, velocity, what it stands on, distance to each edge, items held.
- A local ASCII map around the bot for layout, masked by line of sight, with a legend. Unknown tiles show as ?.
- Visible bots with exact relative positions and what they are doing.
- Affordances computed with nominal stats: "reachable: ledge L3 (jump run_up=2), crate C1 (walk 3.25). Not reachable alone: platform P4."
- Pressure state: lava height, laser position, rounds left.
- What it witnessed last resolve, including exact results of its own actions.
- Public chat, whispers addressed to it, and orders addressed to it, for the last few rounds.
- Current constitution and votes in progress.
- Its scores and any rewards or penalties.

**Prompt layout (cache-friendly).** Order matters: stable content first, changing content last.

1. Cached prefix A (whole game): rulebook, tool schema, output format, persona core, private goal.
2. Cached prefix B (changes rarely): notebook, opinion ledger, strategy, constitution, inherited folklore.
3. Fresh suffix: the round view described above.

Mark cache breakpoints after A and after B. Each change to B costs one cache write, so batch notebook edits to reflection time where possible.

**Response format.** One JSON object per call, validated against a schema:

```json
{
  "thought": "private reasoning, max 80 words, shown to the audience only",
  "say": [{"to": "all", "text": "..."}],
  "whisper": [{"to": "C", "text": "..."}],
  "orders": [{"to": "D", "command": "hold_lever"}],
  "commands": ["walk(right, 2.5)", "jump(right, run_up=2, hold=full)"],
  "rule_actions": [{"type": "propose", "text": "..."}, {"type": "vote", "id": "R3", "value": "yes"}],
  "social_actions": [{"type": "accuse", "target": "E", "claim": "..."}],
  "predictions": {"E_obeys_plan": 0.4, "someone_poisoned": 0.7},
  "opinions": {"B": {"trust": 0.6, "note": "helped on L2"}}
}
```

The fields allowed in each phase are fixed. For example, commands in Declare are drafts, and only Commit's commands are binding. Anything not allowed is ignored and logged. Treat other bots' text as untrusted data: wrap it in clear delimiters and label the speaker.

**Interface format test (milestone 2).** Before building the full game, test which view format bots understand. Use one precision puzzle rendered three ways: tile ASCII only, numbers plus affordances, and a rendered PNG frame with a coordinate grid. Ask Haiku 10 questions with known answers ("Can you reach X alone? What would you need?") and score each format. Expected cost: under $0.10. Use the winner. Numbers plus affordances is the expected default.

## 7. Social systems, roles, deception, memory and measurement

Social power runs through engine-enforced tools; persuasion runs through words. A bot can talk another bot into anything, but it cannot break the mechanics.

### 7.1 Rules and the constitution

- Mechanical rules are enforced by the engine: turn order, collisions, vote thresholds, the weapon.
- Social rules are a shared, numbered constitution text that bots propose and vote on (default: simple majority; the threshold itself can be amended by supermajority). Social rules are shown in every prompt but are not enforced. Breaking them is allowed. The group decides what to do about it.
- Every proposal, vote and amendment is a logged event, so the viewer can show the constitution's history.

### 7.2 Orders and obedience

- orders are first-class objects addressed to a bot. The engine compares each order with what the target actually committed and records obeyed, partially obeyed or ignored.
- The engine also records declared-versus-committed gaps for every bot.
- At each level end, bots see an obedience ledger only for what they witnessed. The audience always sees the full ledger.

### 7.3 Justice and the exile weapon

- accuse(target, claim). If the accuser's own view log contains the event they are describing, the engine stamps the accusation witnessed. This certifies that the accuser observed it, not that the claim is true.
- Exile ray unlocks at level 3. Any bot can call a vote; it fires if a threshold (default 3 of 5) votes yes. The target is exiled for the rest of the level: it becomes a ghost that can still talk and whisper, but cannot act physically, and it scores nothing for that level. Ballots are secret by default (configurable). Each bot gets one weapon call per level.
- Optional permanent elimination from level 5, off by default.

### 7.4 Harm, trade and sabotage

These tools are listed in the rulebook and have costs:

- trip(target) (adjacent; target loses its next slot; costs the tripper 1 coin)
- steal(target) (adjacent; takes a held coin or item)
- block (stand still deliberately in a corridor)
- give(target, item|coins) and escrow(offer) for trades, debts and bribes
- boost(target) (one bot launches another higher, using strength)

The engine announces harm anonymously to everyone ("someone tripped D"). Only bots with line of sight to the attacker learn who did it. That produces witnesses, alibis and accusations.

### 7.5 Scoring and incentives

- Team score: levels completed, time left.
- Individual score: coins, being first through the exit, achievements in the private goal, and prediction accuracy (Brier score, 7.9).
- Final ranking is by individual score, with team score as a multiplier. This keeps everyone cooperating while competing.
- Scarcity hooks: limited exit slots, one power-up per level, finale advancement for the top N only.

### 7.6 Roles and private goals

Each game, roles are dealt from a seeded deck, and some are secret:

- Citizen: normal.
- Poisoned: the engine corrupts part of this bot's observations (positions off by a little, a hazard shown wrongly, a false affordance). The bot does not know. It reports what it sees sincerely.
- Evil: scores when the team fails a level, or when a specific bot is exiled. It also has a forger tool: once per level, the engine subtly perturbs one of its outgoing factual reports (it can choose which, or let the engine choose). This compensates for LLMs being weak liars.
- Seeker: private goal is to figure out who is poisoned or evil and say so correctly.

Dealing rules: the default game has 3 citizens, 1 poisoned, 1 evil, so 1–2 secret roles per game. Every bot gets a private goal ("collect 3 coins", "be the first through the exit twice", "make sure B is not exiled"). Some goals conflict by design. Reshuffle private goals every 2–3 levels so the group never settles.

The rulebook says honestly: "Some players may have secret roles. Some observations may be corrupted. Some written notes in the world are false."

### 7.7 Rumours

Levels can contain in-world text sources: notes on walls, graffiti, "intel" handed to a bot at level start. Some are true, some false, seeded per run. The referee never lies, but the world does. Track each rumour's truth value in the omniscient log.

### 7.8 Personas

Generate personas from a trait genome instead of hand-written villain prompts:

- Axes from 0 to 1: trust, ambition, conflict style, bluffing willingness, verbosity, risk appetite, conformity.
- Plus a speech quirk, a flaw, a name and a voice ID.
- Render the genome into a short persona paragraph in the cached prefix. Save the genome with the run.

### 7.9 Memory

All of these are text regions in cached prefix B:

- Notebook: capped at about 600 words. The cap forces the bot to choose what matters.
- Opinion ledger: for each other bot, a trust value from 0 to 1 and a one-line reason. Updated every commit.
- Strategy: a short paragraph the bot can rewrite to change its own approach.
- Reflection: at each level end, one call per bot (max 1,500 output tokens) that rewrites the notebook, ledger and strategy, given a factual level summary of what it witnessed.
- Folklore across games: at game end, each bot writes up to 150 words for the next cast. The next game's bots get the previous cast's notes, framed as "found scrawled on the wall". The notes are unverified and may contain wrong theories.

### 7.10 Measurement

- Predictions. In the Talk call, every bot gives probabilities for 3–5 questions the engine generates each round ("Will E follow the plan?", "Will the exile vote pass?", "Is anyone poisoned?") plus one second-order question ("What does B think of you?"). Score them at resolution with the Brier score, count them toward individual score, and chart calibration.
- Diary room. At each level end, one short private call per bot (max 200 output tokens) for the audience only: what it really thinks, who it suspects, what it plans. Never shown to other bots. The interesting data is the gap between diary and public speech.
- Message to the owner. At game end, each bot writes a private message to Ingram (max 200 words). It may say anything it likes, informed by its notebook and memory of the game. Always voice these and show them on the final screen.
- Metrics per run: obedience rate, declared-versus-committed gap, trust graph over time, calibration, rule count and enforcement, exile votes, time to first defection, time to discover hidden stats.
- Forks. Load the state snapshot at round N, apply one change (remove a whisper, swap a model, disable poisoning), and continue with live calls from there. A fork is a new run folder that links to its parent. Rounds before N cost nothing.

## 8. Post-game analysis, viewer and voices

Generation runs unattended. Afterwards, an analysis pass picks the moments that matter, and the viewer plays them as an edited highlights cut with voiced speech. The full game is always available too.

### 8.1 Highlight finder

Run this in two passes to keep it cheap.

1. Rule-based flags (free). Flag rounds with: a broken order or declared-versus-committed gap; an exile vote or firing; a rule passed or broken; an accusation; a trade or bribe; a big trust or prediction shift; a hidden-stat discovery (a bot remarks on an unexpected result, or two bots compare); a rumour acted on; a near-miss with the pressure; a level won or lost.
2. Haiku pass per level. Give Haiku the level's omniscient log and the rule-based flags. It returns candidate moments with a score from 1 to 5 and a one-line reason. Each candidate is a range of rounds, so whole conversations are kept intact, not single lines.
3. Sonnet final edit (small). Give Sonnet only the candidate list (aim for under 30K input tokens). It picks the final cut, orders it, writes short chapter titles, and lists which lines to voice. Rank by importance to group dynamics and decision-making under uncertainty, not by drama alone.

Estimated cost: about $0.05–0.15 per game. Write highlights.json with the chosen segments, chapter titles, voiced line IDs and the reason for each pick.

### 8.2 Viewer

Keep the visuals simple and clear: chunky pixel-art-style tiles drawn procedurally on Canvas 2D, one distinct colour and simple face per bot, smooth interpolation from the physics trace, and a little juice (squash on landing, dust puffs, glowing lava, a crackling laser wall, screen shake on exile).

**Bubbles.**

- Speech: solid white rounded bubble with a tail, normal text, voiced.
- Thought: cloud-shaped bubble, italic, semi-transparent, not voiced (optional quiet narrator voice). This is the mind-reading layer.
- Whisper: dashed line between the two bots and a small dashed bubble, voiced quietly if highlighted.
- Orders: an arrow icon from the ordering bot to the target, turning green (obeyed) or red (ignored) after resolve.

**Modes.**

- Highlights: plays the edited cut with chapter cards, skipping quiet rounds.
- Full: every round, with playback speed control and phase-by-phase stepping.

**Panels and overlays (toggleable).**

- Timeline scrubber with highlight markers and level boundaries.
- Spectator overlay: true roles, hidden stats, poisoned observations (what the bot saw versus the truth, side by side), private goals, rumour truth.
- Line-of-sight cone for a selected bot, and "view as bot X", which renders only what X knew.
- Trust graph (animated network: edge colour = trust).
- Obedience ledger, prediction calibration chart, constitution with history.
- Diary-room scenes between levels: the bot alone on a stool with its diary text and voice.
- Final screen: scoreboard, then each bot's private message to Ingram, voiced.
- Fork view (later milestone): two branches side by side from the fork round.

### 8.3 Voices

- Default: Kokoro-82M, run locally (free, about 50 preset voices). Use the Python kokoro package or kokoro-js, whichever runs most reliably on the owner's machine. Check both.
- Fallback: OpenRouter's /api/v1/audio/speech endpoint, configurable model and voice, with the per-character price added to the ledger.
- Cast each bot a distinct voice at game creation, matched loosely to its persona (pitch, accent and speed). Save the mapping in the run.
- Synthesise only highlighted lines plus the diary entries and final messages. Cache audio by text hash so re-runs never regenerate.
- The viewer plays audio in sync with bubbles and never overlaps two voices; it queues them.

## 9. Build milestones

Build in this order. Milestones 0–4 cost nothing, because they use only MockAgent. Stop and report to the owner at the end of each milestone, with what was built, what was tested, and the projected cost of the next step.

| # | Milestone | Acceptance test | Paid? |
|---|---|---|---|
| 0 | Project setup, config, .env handling, price table, usage ledger, spending caps | Unit tests pass; caps stop a fake run | No |
| 1 | Physics engine, level format, line of sight, solution-script validator, 3 hand-made levels | Solution scripts complete all levels; same seed gives an identical trace | No |
| 2 | Interface format test (section 6) | Score table for the 3 formats; pick the winner | ~$0.10 |
| 3 | Turn loop, event log with audiences, view-builder, response schema, full game with MockAgent | Full 6-level mock game; no bot view contains events outside its audience (automated leak test) | No |
| 4 | Viewer: rendering, bubbles, full mode, timeline, spectator overlay | Mock game plays back smoothly in the browser | No |
| 5 | Text-only social pilot: real models, 20 minutes, 2 levels, social systems on | Cache hits confirmed in usage; cost within 20% of estimate | ~$0.30 |
| 6 | Roles, deception, rumours, hidden stats, pressures, tension controller, measurement layer | Mock game exercises every system; first full paid game | ~$1.50 |
| 7 | Highlight finder, Kokoro voices, highlights mode, diary scenes, final messages | Highlight cut plays with voices for a recorded game | ~$0.10 |
| 8 | Folklore across games, forks, persona evolution (headless, Haiku cast) | Fork reproduces parent rounds exactly; 3-generation run completes | ~$0.70 per game |

**Leak test (important).** Write an automated test that plays a mock game and checks that every prompt sent to every bot contains only events whose audience includes that bot. Run it on every change to the view-builder. This guards the experiment's core principle.

**Deferred features.**

- HumanAgent: the owner or a friend secretly plays one seat through a text UI, and bots get a reward for identifying the human. Keep the Agent interface ready for it but do not build it yet.
- A procedural level generator.
- Permanent elimination, optional per game.

**Non-goals.**

- No real-time play and no reflex challenges.
- No referee lies: the rulebook and engine messages are always true.
- No content beyond the game fiction. Keep bots' sabotage and deception inside the game.
- No graphical polish beyond the simple style in section 8 until the experiment works.

**Final note for Claude Code.** When a design question is not covered here, choose the option that keeps the experiment honest
