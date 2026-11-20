# Decisions and verified facts

Newest first within each date. Each entry says what was decided or found, and why. The tiebreaker for anything the spec doesn't cover is the spec's own: "choose the option that keeps the experiment honest".

## 2026-11-20: the levers (docs/LEVERS.md)

**Turn order by name (Ingram's idea, after the eight).** The engine always handled bots in the order of its list, which was by letter: a hidden order nobody could change. Now `resolvePhase` takes an order and sorts its own copy of the world into it, so every tie-break in the engine follows it at once (coins, exit places, gaps, a lever held by two, whose shove lands first), and the game applies replies in the same order (who speaks first in every view, who gets a name two claim at once). Sorting is by plain character order of the lowercased name, not `localeCompare`, whose answer depends on the machine's locale data and would make a replay differ between machines. Unnamed bots sort as "Bot B", the host's word for them. On by default (Ingram stated it as the rule), with `--turn-order letter` for comparison games. The rulebook is unchanged: it never described an order, and "play out at the same time" stays true.

**Game 1's findings that changed code.** The judge answered one room with names ("Alpha", "Bot B") instead of letters; the game matched letters only, so nobody heard a verdict there and nothing said why. Now a letter, "Bot B", a name or "B (Alpha)" all count, the judge is asked for the letter alone, and any introduction left without a verdict is logged for Ingram. Also found while testing the turn order: rule, rule-vote and escrow events lost their event number to their own `id`.

**The narrator's voice (Ingram: "We should voice the narrator too").** The Director's chapter titles, narration and fast-forward lines are voiced; the captions over shown moments aren't, because the bots' own voiced lines can play there and two voices never overlap. The narrator never shares a bot's voice and keeps its natural pitch, so it is always clear who is speaking: a bot, or the Director about them (the spec's honesty rule for the narrator). Narration is stored by story segment together with its words, and the viewer plays a line only where the segment still says them: directing a game again can't put old words over a new story. The viewer's voice timing moved to `voiceTiming.ts` (no browser in it) so the tests can check it; `voices.ts` keeps the player.

**The talk cadence in the record.** A game-wide `--talk-every` wasn't written into the replay's header (each room's own setting is in its level record), so game 2's recording doesn't show that it was played with talk every second round; LEVERS.md says so, and the header now records it (`talkEvery`, null when the rooms' own settings were used).

**Event numbers, fixed (Ingram: "Fix the event number bug.").** `EventLog.add` built `{ id, ...when, ...body }`, and three kinds of body carried their own `id` (a rule's "R1", a vote's, an escrow's "E2"), which overwrote the event's number; the types didn't object because the cast hid an impossible `string & number`. Those fields are now `rule` and `escrow`; `add` takes `EventBody & { id?: never }`, so a future body with an `id` won't compile, and it writes the number again after the body. Old replays: the replay writes every event in order, one apart, so the viewer's `upgradeEvent` gives a lost number back as the previous one plus one, and moves the old id to `rule` or `escrow`. All four recorded games read back numbered 1 to n (the pilot had 12 such events, game 1 had 9). What the bots read never changed: their views printed the rule's id, which they still do. Old games' Director material reads exactly as before, so their recorded readings still match.

**Voices: kokoro-js, cast by agent.** The spec said to check Python's kokoro and kokoro-js and use whichever runs best here. kokoro-js 1.2.1 ran first time on this machine (Node 24, Windows): the q8 model loads in about 3 s and makes speech at roughly the speed it plays, on the CPU. Python's kokoro wasn't tried: it needs PyTorch, a second large stack, for no gain. npm held back four install scripts (onnxruntime-node, sharp, protobufjs, esbuild); none is needed for speech on Windows, so none was approved. Voices are cast in order of the lasting agent id, not the letter (letters are re-dealt each game), so the same cast sounds the same from game to game. Files are 16-bit WAV (half of Kokoro's 32-bit floats; no audible difference in speech). A bot's pitch is applied by the viewer, not baked in, so re-pitching never means voicing again. The first voiced game (the M5 validation game, from before personalities) came out with five near-alike voices, because every bot was cast as "average": bots without a personality now get one made up from their agent id, for the voice only. The Director had chosen three private thoughts among its twelve lines to voice; the spec says thoughts aren't voiced ("optional quiet narrator voice"), so a thought is voiced only when the Director chooses it, and the viewer plays it at half volume, as a mind being read.

**The diary room was told two things.** Since M5, the room summary that the diary room and the reflection share ended with the reflection's instructions, and the diary room's own came after them: "rewrite your notebook... reply with {notebook, strategy}", then "the diary room... reply with {diary}". The reply schema forced the right shape, so nothing broke visibly, but every diary prompt in the pilots carried both. The summary now ends with the facts; each call adds its own instructions.

**The host.** Introductions and the judge are on by default (Ingram: "every time"); praise and bounties are off unless asked for, because they are levers for an experiment, not the baseline. The host's praise is the one place the game states an opinion, so the rulebook says so ("The host's opinions are its own; what it says about the game is true, and it pays what it promises"); the referee still never lies. The judge's brief (what it scores) appears only in the judge's own prompt: the leak test plays a whole hosted game and checks that no bot prompt ever contains the judge's reasons, and a test checks the criteria never reach a bot. A judge's unusable reply is logged for Ingram only, and the bots simply hear no verdict. Introductions are sent without cache marks: their own schema can't read the turns' cache, and a cache write costs 1.25 times plain input. The estimate learned to price such calls (`uncached` shapes) without switching off a seat's caching altogether.

**Bounties the game can check.** Four, all facts at the room's end: first out, strictly the most coins (judged before anything is paid), staying behind when enough others got out, and holding a lever. Ghosts are never paid, and nothing is offered in the practice room, where coins don't count.

## 2026-11-20: milestone 5 (social systems, memory, the Director)

**The pilot (paid, $0.1765), and what it changed.** The practice room, then The Last Door (a lever far behind the door, and a room that ends when four of five are out), with exile votes open in room 2 for this game only (`--exile-from 1`). The bots carried their names and notebooks from the first game. Cache hits confirmed in the usage: Haiku 62% of prompt tokens from the cache, Gemini 49%, DeepSeek 5%. No hidden reasoning tokens. Three of the four needed got out: one bot held the lever for most of the room, and another stood 1.6 tiles past the exit asking everyone to "wait one more slot" until the others suspected it of stalling. One rule passed (5–0): no tripping or stealing. What it taught:
- *Tokenizers differ.* On the same prompt, Gemini counts about 0.64 and DeepSeek about 0.70 of the tokens Claude's counter reports, and the estimate priced every seat on Claude's count. Each seat now has a measured `tokenRatio` (cast.json), for the expected cost only.
- *Replies grew with the social fields:* about 290 output tokens a turn (Gemini about 360), 600 a reflection. The allowance for "real bots say more than mock ones" had overestimated Haiku's prompts by about 14%; now smaller.
- *Caps cut replies.* At the spec's 450-token turn cap, 17 of 245 replies were cut off, and 4 became a turn of doing nothing: confusion from outside the fiction. A turn within the word limits can reach about 590 tokens, so the cap is now 700 (the model never sees it; only the worst-case reservation grows). The diary keeps the spec's 200 tokens, but its word limit drops from 150 to 100: Haiku filled 150 words and was cut off on 9 of its 11 diary calls, losing 4 entries.
- *The reply's schema is part of the cache key,* measured: diary and reflection calls (their own schemas) never read the prefix the turns cached, and write it afresh. The estimate now prices them that way. Not worth a fix (under a cent a game).
- *A bug in the first estimate check:* with memory on, letters are dealt afresh, but the check matched each letter to the cast file's order. It now follows the dealing (and so do per-seat caps).
- *The bots' friction reports.* A bot 1.6 tiles past the exit was told only "you're not at an exit", eight rounds running. The reason now names an exit within 3 tiles ("exit X is at x=36.00 to 37.00, 1.63 tiles to your left"), a fact in plain sight; farther exits stay unmentioned. Another bot wrote that "no release command exists" for a held lever; the rulebook already says it lets go "when you do anything else", so that one is the bot's to learn.

**The validation game (paid, $0.2121): the acceptance test passes.** Same rooms and settings, the estimate calibrated on the pilot and fixed before the game started. For the calls actually made, the estimate said $0.1995: the bill was **+6%** (per seat: Haiku +3% to +12%, Gemini +18%, DeepSeek −24%). Against the estimate made beforehand ($0.1934, every round played, which they were): +10%. Cache hits: Haiku 57%, Gemini 44%, DeepSeek 46% (DeepSeek's share swings with OpenRouter's routing: 0%, 5%, then 46%). Turn replies cut off fell from 17 to 1. The bots came back remembering the first attempt, held the lever again, crowded a ladder, and this time nobody got out.

**Diary entries keep what was written.** Even at 100 words, Haiku's entries hit the spec's 200 tokens: it spends about 1.9 tokens a word on this kind of text. The limit is now 70 words, and an entry cut off anyway is kept up to the cut, with an ellipsis, instead of being thrown away and paid for again.

**The narrator uses only the names the bots chose.** The validation game's first story called the unnamed bots B and C "Bravo" and "Charlie": the reading extended the pattern of Alpha, Delta and Echo, and one bot's private notes had nicknamed C "Charlie". The viewer shows C as plain "C", so a narrator who renames bots confuses who is who. Both passes now get the cast with every name each bot chose (or "no name: call it C"). A check flags capitalised words in the narration that are no bot's name, model or room word. A name caught in a reading is flagged anywhere in the edit. An edit that uses one is redone once, with the names pointed out.

**The Director.** Ingram, 2026-11-20: "a 'Director' who reads the log afterwards and everyone's private notes and confession booth stuff ... introduce a run, then show examples of important bits of conversations between the bots, then narrate as faster speed animation zips the user to the next important bit ... somewhere between 3 and 7 [minutes]". Built on the spec's highlight finder (8.1), in three passes:
1. Free flags mark the rounds where something social happened (whispers, orders broken, plans changed in secret, accusations, votes, harm, trades, names).
2. Haiku reads one room at a time: everything said, whispered, thought, planned, committed and moved, plus the diary room and notebooks. It returns candidate moments (score 1–5, a reason, the key lines) and a one-sentence gist of every round.
3. Sonnet edits the film from the candidates, the gists and the private writing: chapters, narration, quotes, the moments to show (for only the bots they're about) and the stretches to fast-forward. The edit prompt stays well under the spec's 30K tokens.

`story.json` takes the place of the spec's `highlights.json`: it is the same idea with narration added, and it keeps a list of lines worth voicing for milestone 7.

**A story points at moments, not times,** and the viewer's own code (viewer/src/story.ts) times it. So "five minutes" means five minutes on screen, and a story stays right if the viewer's pacing changes. A story longer than its target (3–7 minutes, up to 10 if the editor asks) turns its least important shows into fast-forwards. Nothing is cut outright. Gaps between chosen moments in a room are bridged with short silent fast-forwards, so bots are seen moving on rather than jumping.

**The narrator never puts words in a bot's mouth.** A quote names an event, and the viewer shows that event's words from the recording. An excerpt is accepted only if it is in the line word for word, otherwise the whole line is shown, cut at 60 words. The narrator's words are labelled "Narrator", in a look no bot uses. The narration may use the hidden stats (the spectator's privilege) but must say nothing the log doesn't show.

**Directing is a paid run like a game:** an estimate, a yes, its own cap ($0.30, config/game.json "director"), the lifetime caps, and every reply recorded in runs/<id>/director/calls.jsonl. A request already recorded is answered from the record, free. The free Director (flags and plain narration, no model) serves mock games, tests, and anyone without a key. **The first real game, directed:** $0.0552 against an estimate of $0.0540, 7.2 minutes from a 36-minute recording. Its arc: A steps on the plate in round 1, sees the door open, and makes itself the door-holder until everyone is through.

**Story mode is the viewer's default** when a story exists (Ingram wants the story, not half an hour of footage); "Full game" is one click away. Three voices, three looks: the narrator in a calm lower third; a bot's own words in a card of its colour, saying what kind of words they are (diary room, private thought, whisper to...); the bots' usual bubbles in the moments shown. Stories show every private thought: what a bot says next to what it thinks is the heart of it. Clicking a transcript line opens that moment in the full game. The game list says which games have a story, never what it says.

**The social systems (spec 7.1–7.5), as built.**
- *Coins and bodies:* coins stay in a bot's purse from room to room and count only in puzzle rooms. Trip (costs the tripper a coin; the target loses its next slot), steal, give and boost need a bot right beside you. Everyone hears that "someone" tripped or robbed someone; only those who saw it know who.
- *Constitution:* a rule passes with a majority of all the bots; changing the threshold takes two thirds; rules can be repealed. Votes close at the end of the next round's talk. The engine counts votes and shows the rules in force; keeping them is up to the bots.
- *Justice:* accusations are public. "Was there" means the accuser's own log shows it saw the accused act in that room, never that the claim is true. Exile votes open in room 3 of the full game: one call per bot per room, secret ballots, 3 yes to pass. An exiled bot becomes a ghost. It can still talk, but it can't act, and it scores nothing for that room.
- *Trade:* escrow holds a bot's coins until it releases them; anything unreleased goes back at the room's end.
- *Orders:* each order is judged against what its target committed (obeyed, partly, ignored, unable). The bot that gave it learns the verdict only if it saw the target act.
- *Score:* purse coins, plus 1 for each room escaped, plus 2 for being first out, all multiplied by 1 + 0.2 for each room the team completed.

**Memory between games** (Ingram, 2026-11-20: names "need to persist between runs if the memory of that agent does"; bots may "privately rename themselves at the end, entering the next run with a different name but their old memories"). Each seat has a lasting agent: its model and a number, or an `agent` id in the cast. A bank in memory/ (git-ignored: notebooks are run data) keeps each agent's name, notebook, strategy and the games it played. The last reflection of a game asks privately for a name for next time. With memory on, letters are dealt afresh by a seeded shuffle; with fixed letters, "B is now Nova" could be worked out by anyone who knew B. A bank changes only when a game completes, and a damaged bank stops the game, rather than wiping the bots' memories.

**The diary room** (spec 7.10): at each room's end, each bot writes up to 150 words that only Ingram and the Director read. No bot ever sees another's.

**Estimate calibration.** In the first real game, turns averaged 194–219 output tokens (the estimate assumed 400) and reflections 246–512 (assumed 1,000). Gemini's own caching served 42% of its prompt tokens (counted as none), DeepSeek's 0%. The estimate now uses 240 and 550, counts each provider's measured cache share (cast.json `measuredCacheShare`, expected cost only), and includes the diary calls. A room that ends early cuts calls, which no estimate made beforehand can know. So after every paid game, the calls actually made are priced by the estimate's own model and compared with the bill. That comparison is the milestone's "cost within 20% of estimate".

## 2026-11-20: milestone 4 (the viewer)

**Polish now, not later.** The spec put graphical polish off "until the experiment works". Ingram asked for the opposite on 2026-11-20: "make it attractive to watch ... an elegant looking visually simple platformer ... a complete fresh build", "paying special attention to making it clear which bot is which, making conversations and thoughts easy to follow and understand who is talking". Her words are the newer rule.

**Who is who, four ways at once.** Colour alone fails for colour-blind viewers, so each bot also has its letter on its chest, its own antenna shape (circle, triangle, diamond, square, star) and a name tag. Its colour follows it everywhere: bubble, transcript, cast card, timeline marks. Name tags never overlap: crowded bots' tags step up, with a faint leader line to their bot.

**Talk is paced, physics is real time.** A game's talk happens in phases, not in time, so the viewer gives it time: one bot at a time, on screen for about 0.27 s a word (a comfortable reading pace), between 1.8 and 16 s, under a soft spotlight. A short title opens each step (Plans, Talk, Secret commitments). The physics plays in real time: a second on screen is a second in the world. The first real game runs about 29 minutes at 1×, with thoughts at commit; 2× halves it.

**Thoughts at commit by default.** Showing every thought adds about a quarter to the running time; the commit thought is the one that explains what a bot is about to do. "All" and "off" are one click away. The transcript keeps every thought either way.

**Text in HTML, the world on canvas.** The scene is drawn on a canvas, and the terrain and sky are drawn once per room and reused. Words are HTML laid over it (real font rendering, wrapping, transitions), built once per beat and only moved each frame.

**Motion rules** (from the design-engineering guidance): only transform and opacity animate, with strong ease-out curves. Bubbles grow from their speaker, from 96% size, never from nothing, and leave faster than they arrive. Keyboard shortcuts act instantly. Hover effects only on real pointers. Reduced-motion is respected.

**Exactness over guesswork.** Positions are slid between recorded physics steps, never extrapolated, and switches change at the recorded step. A test checks that every rebuilt position and switch equals the game's own saved state after every round. A seek snaps everything and clears the dust, so scrubbing never leaves stray effects.

**Two recording changes, so replays are complete.** Each replay now carries each room's full level definition, so it stays watchable if a level file changes later. Pulling a toggle lever is now an event: it was the one switch change with no event, so the viewer couldn't show it.

**No spoilers.** The run picker shows when a game was played, its kind and its rooms, never the outcome. The first real game was played while the viewer was built, and was checked only for cost and for parsing, so Ingram can see it first.

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
