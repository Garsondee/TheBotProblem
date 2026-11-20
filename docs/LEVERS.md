# Levers: ways to mess with the simulation

Ingram, 2026-11-20: "Some ways we can mess with the simulation and hopefully get interesting results", eight of them, and the goal behind them: "get the bots being less cooperate and more like little roleplaying humanoids. We're not trying to force drama artificially, we're trying to create the exact conditions under which game theory and dilemmas start to play out."

This file turns each idea into mechanics, with the rule that keeps it honest, then says in what order they are built and what they cost. Every lever is a setting, so an experiment can switch it on, off, or up and down, and every one is recorded in the replay.

**What the real games showed first** (both paid M5 games, 2026-11-20):
- About 1 in 10 commands failed because another bot was in the way (9 in the first game, 15 in the pilot), and each failure cancelled the rest of that bot's round (15 and 20 commands more).
- A quarter of all commands were `wait`. The bots spoke about 390 words a round.
- In the validation game the bots argued for rounds about where a ladder was (x=16–17, x=18; it is at 20). The view showed ladders only as `H` in the grid, never in the list of things with coordinates, so finding one meant counting characters. That is accidental confusion, which the spec forbids, so the fix comes first.

## 0. The view says where ladders and platforms are (fix)

Ladders and one-way platforms join "Things in sight" with exact coordinates, like every other element. Ladders get ids (H1, H2, numbered left to right), so `walk_to(H1)` works, and the move menu can offer it.

## 4. Tools against collisions

- **`swap(B)`**: trade places with bot B right beside you. It works only if B commands `swap(you)` in the same slot. Consent is a matching pair of commands, so it needs talk (or luck). The two pass through each other for the move; nobody else does.
- **`hop_over(B)`**: a controlled jump over a bot beside you, landing just past it, with the arc worked out by the game. It fails, with the reason, if there is no room to land or the ceiling is too low.
- **`crouch` / `stand`**: crouching halves a bot's height, so others hop over it easily and it fits under 1-tile gaps. It moves at creep speed while crouched. Standing up needs headroom. Some new rooms have low passages.

## 5. Violence, on dice, with alertness

- **`trip(B)`** stops B's move and costs it its next slot; the tripper keeps going. **`push(B)`** forces your way past B (you end up on its far side) and slows it to half speed for the rest of the round. **`shove(B)`** knocks B away from you, about a tile, further the stronger you are against its weight (hidden stats both), off a lever, a plate or a ledge.
- Each one rolls dice (a seeded stream, so replays are exact). The chance of success against B is 100% minus B's **alertness**. Everyone starts unalert, so the first attack of a game always works.
- Anyone who sees violence, the attempt included (attacker, target, witnesses), becomes **100% alert**: no attack on them can succeed. Alertness then drops each round by a hidden per-bot stat, **guard**. Each bot is told privately how long it stays on guard ("about 2 rounds", "about 5 rounds"). Bots know the rule; they don't know anyone else's guard, or anyone's current alertness.
- Everyone hears that "someone" attacked someone; only those who saw it know who (as now). Trip's coin cost goes: alertness is the limit now.

## 2. Talk cadence

A per-room setting, `talkEvery` (1 = every round, the default). With 3, bots act three rounds in a row and talk in only one of them, which makes it slower for talk to change what anyone does. In a silent round there's one call per bot: it sees what happened, thinks, and commits. The rulebook says which rounds are silent.

## 3. SHOUT

`shout`: up to 12 words, heard by everyone at once, in any step, silent rounds included. The rulebook says shouting is rude, and everyone knows who shouted. Nothing else punishes it: whether the bots do is theirs to decide (rules, accusations, exile). Every shout is counted for the analysis.

## 6. Introductions, silently judged

Before each room's first round, the host turns to each bot by name: "Alpha: introduce yourself." Then it asks one question, drawn from a pool ("What would you never do in here?", "Who do you trust least, and why?"). Everyone hears every introduction. A judge (Haiku, one call a room) scores each one, without telling the bots what for: individuality, character, and growth since that bot's last introduction. Each bot then learns, privately, only how it was received: "negative (−2)", "neutral (0)" or "positive (+3)". Never why. The history follows the bot in its memory. The judge's reasons are kept for Ingram and the Director.

**Built** (2026-11-20). On by default in `config/game.json` ("host"), since Ingram said "every time"; `--no-host` and `--no-judge` turn it off for one game. What each bot gets:
- its own intro prompt: the room, the others' names, the host addressing it by its chosen name, the question, and what it said last time with the verdict it got (its own information, so the "mull over WHY" loop is tight);
- round 1's view: every introduction, and its own verdict (repeated, one line, in every round of the room); the room summary for its diary and notebook has them too.
- The judge sees each bot's last three introductions (the memory bank keeps four per agent, across games), with the scores it gave them, so it can judge growth.
- The intro call is sent without cache marks: its own reply schema can't read the turns' cache, and a cache write costs more than plain input. About $0.02 a game for the introductions, half a cent for the judge (Haiku 5.5 at $0.10 per million input tokens).
- `summary.md` gets a table of every bot's scores, room by room: the trend is the point.

## 6b. Personality and colour

Each agent gets personality traits when it's first created (five, 1 to 10: boldness, warmth, honesty, curiosity, patience). They stay with it across games, in the memory bank. Its **colour** is worked out from them by a fixed formula that nobody is told. A bot knows its own traits and its own colour. Once per room it may spend an action, `look(B)`, to see B's colour. Only bots that share their traits and compare colours can work out what colour means.

In the viewer, each bot keeps its identity colour (Ingram: always clear "which bot is which"). Its personality colour shows separately, as the glow of its eyes and antenna. *Asked Ingram, 2026-11-20.*

## 1. The host, and coins that mean something

A host speaks to everyone, now and then, in its own voice, labelled as the host. Per room, it can:
- congratulate the bot with the most coins after each round ("clearly a special, especially worthy bot")
- post bounties: "2 coins to whoever is holding lever V1 when the room ends", "1 coin to the first bot out"

The host's praise is an opinion and says so. Its facts (who has the most coins, what a bounty pays) are always true, and bounties are always paid.

**Built** (2026-11-20), as levers to pull, not defaults:
- `--praise`: at each room's start the host congratulates the richest bot (ties: all of them), in Ingram's words: "clearly a special individual, and especially worthy". Once a room, not each round: it stays in every round's view of that room, so it is never out of sight.
- `--bounty first_out:3,left_behind:2` (or a room's own, in its level file's `"host": {"bounties": [...]}`): announced at the room's start, paid into purses at its end, before the score. Four things the game can check for itself: `first_out`, `richest` (strictly the most coins, judged before anything is paid), `left_behind` (each bot still inside when enough others got out: a price for staying behind), `holding_lever` (each bot holding a lever at the end). Ghosts are never paid. Never in the practice room.
- The rulebook gains a short THE HOST section, only in games that have one: what the host does, never what the judge listens for.

## 8. Voices

Kokoro-82M, run locally through `kokoro-js` (free). Each bot gets a distinct voice, cast once and kept in its memory, so it sounds the same from game to game. Only the lines a story uses are voiced: shown speech, quotes, diary entries and messages to Ingram. Audio is cached by text, so nothing is made twice. The viewer plays it in story mode, one voice at a time.

**Built** (2026-11-20): `npm run voice -- <run>`. kokoro-js 1.2.1 runs on this machine (the spec said to check Python's kokoro too; it needs PyTorch, a second large stack, and the JavaScript one already works). On the CPU it makes speech at about the speed it plays.
- Casting (voice/cast.ts): 15 of Kokoro's English voices graded C or better, each roughly described as warm, strong or bright. Warmth, boldness and curiosity pick the nearest free voice; patience sets the speed; boldness also a pitch, which the viewer applies without keeping the pitch, so bold bots sound lower and every bot a little robotic. Bots choose in order of their lasting agent ids, so the same cast sounds the same from game to game. The cast is saved in `runs/<id>/voice/index.json`: edit it and voice again to re-cast.
- Lines: the Director's chosen ones, the introductions, the diary room and the messages to Ingram (`--only`, `--all` for every spoken line). A thought only when the Director chose it, played at half volume. Each line's file is named by a hash of its voice, speed and words. Bots from before personalities get a made-up one from their agent id, for the voice only, so older games sound varied too.
- The viewer: a Voices switch, shown for voiced games. Each beat or story card plays its lines, queued, never two at once; a voiced turn or quote stays on screen until it has been heard. At 2× the voices play at 2× too.
- **The whole story voiced** (Ingram, 2026-11-20: "the entire 'Story' should be voiced. I don't mind if we even use a Sonnet pass across the 'script' to clean up what the bots are saying, not changing their meaning but making it easier to listen to and less technical"). Every bot line a story shows is voiced: speech, shouts, whispers, accusations and rule proposals in the moments shown, the thoughts it shows, and each quote card's own words (not the whole line, as before). `npm run direct` adds a third stage, the **spoken script** (analysis/spoken.ts): Sonnet rewrites each of those lines for the ear, keeping the speaker, the meaning and every claim, promise, accusation or lie, and turning command syntax, ids and coordinates into plain words. A rewrite that wasn't asked for, or grew much longer than the bot's own words, is thrown away and the bot's words are read instead. The screen always shows the bots' exact words; only the voice reads the spoken version, and the Voices switch says so. About $0.03 a game; recorded, so free to redo. `--spoken-only` makes it for a story already there.
- **A narrator with opinions** (Ingram: "a bit more of a force in terms of having an opinion and talking about the bots as if they were subordinate creatures that it is watching"): the Director's brief now has the narrator watch the bots from above, like a naturalist with small creatures in a glass tank, judging what they do and saying so, writing for the ear. Its opinions are its own and sound like opinions; its facts are still checked (nothing the material doesn't show, no invented names).
- **Heard** (2026-11-20; checked in the viewer, not yet by Ingram). The three games were directed again with the new narrator ("The Last Door", "The Lever and the Ladder", "The Lever Holders") and fully voiced. With voices they run 9.7, 10.2 and 12.9 minutes, against 7 on reading time; the bots' thoughts take the most time. Ingram: "13 mins is fine, not an issue". The narrator sounds like itself: "A tidy little government. It will not prevent a single traffic jam." Most spoken versions read well: "B at x=1.50 y=2.00, still holding V1 (ON)" becomes "B here, still holding the lever, it's on". Some kept a position or an id ("at about six and a half, height two", "lever V1"). The brief now says plainly that a bot's own position goes and that "lever V1" is the lever. It also has the narrator say I, never "the narrator". Both changes apply from the next directing.
- **The narrator** (Ingram, 2026-11-20: "We should voice the narrator too"): the Director's own words in a story are voiced as well: chapter titles, the narration, what a fast-forward says, and (since the whole story is voiced) the caption of each moment shown, said as it starts, before the bots speak. Its voice is one no bot has, a storyteller's first (bm_george, then bm_fable...), a little slower, at its natural pitch: the slight robot is for bots. Each line is kept with its words, so if a story is directed again, the viewer plays only the lines that still fit. Its cards and fast-forwards stay up until it has finished.

## 9. Turn order by name, never explained

Ingram, 2026-11-20: "Turn order is bot name alphabetic but we don't have to explain that rule in advance. Bots with some names will act before others and the only way to change order is to change name."

**Built** (2026-11-20), on by default (`config/game.json`, `"social": {"turnOrder": "name"}`; `--turn-order letter` for the old order). Everything in a round still happens at once; the order decides ties, which is where it matters:
- in the moves: the first in the order gets a coin, a place in the exit or a gap two bots reach in the same step, is credited with a lever both hold, and its shove lands before the other's command starts (the engine handles bots in this order: `resolvePhase`'s `order`);
- in the talk: replies are applied in this order, so its words come first in everyone's view (the spec expects bots to "defer to the first confident voice"), its introduction is heard first, and of two bots claiming the same name at once, it gets the name.

The order is by name, A to Z, case aside, in plain character order (not the machine's locale, so every machine agrees); a bot without a name goes by "Bot B", as the host calls it. The rulebook says nothing about it, and nothing it says becomes false ("play out at the same time" still holds). Before this, the order was by letter, by accident: there was always a hidden order, it just couldn't be changed. Ingram and the Director see it whenever it changes (a `precedence` event, in `summary.md` as "Turn order"); no bot does.

## 7. The experiment loop

With the levers built, I run small paid games (two or three rooms) built to create dilemmas:
- scarce exits (three places for five bots)
- a lever someone must hold, with a bounty for holding it
- coins in risky places, with the host's praise
- cadence and violence switched on and off

Each game is directed, and the next one changes what the last taught. The goal is Ingram's: an interesting, unusual or fun result, by setting the conditions, never by scripting drama.

**Game 1** (2026-11-20, `runs/20261120-060021-game`, $0.37, estimate +2%): the practice room, The Last Door, Three Places; introductions judged, praise on, Three Places' offers; turn order still by letter (the lever came after). What happened:
- The Last Door: four out; Alpha held the lever "for ages on E's word that D1 stayed open" and stayed behind. Its diary calls E's claim "a lie or at least a mistake"; E's calls Alpha's "malice or ignorance". A blame dispute, unprompted.
- Three Places: nobody went through for ten rounds; then E, and on the last round D and Alpha. B held the lever and stayed (paid 4 coins), C stayed (2). C's message reasons about the offers: they "made lever-holding attractive, but exits matter more for score".
- The host praised E (the richest, 3 coins); E finished first on 14 points.
- 46 shouts, every one by the Gemini and DeepSeek bots; the three Claude bots never shouted. No attacks at all.
- The silent judge: E went from −1 ("minimal and vague") to +1 by the third room, introducing itself through its colour ("deep dusty amber — like the light that lingers when a door closes behind you"), and privately chose the name "Ochre" for its next game, "for the deep dusty amber that defines my colour". C started calling itself "colour deep teal". Gemini's Echo stayed at −2 ("robotic... a status report") throughout.
- Found: in room 2 the judge named bots by name ("Alpha", "Bot B"), the game matched only letters, and no bot heard a verdict. Fixed: names count, the judge is asked for the letter alone, and a skipped verdict is logged for Ingram.

**Game 2** (2026-11-20, `runs/20261120-135442-game`, $0.22, estimate −6%): the same rooms, the bots remembering game 1. New: turn order by name (Alpha, then the unnamed "Bot B" and "Bot C", Echo, Ochre: Delta's private rename to Ochre moved it from first, under the letter order it had by chance, to last) and talk only every second round (`--talk-every 2`). Praise on.
- The Last Door: four out in 11 rounds (12 in game 1).
- **Three Places failed: two out of the three needed.** A jam at the foot of the ladder held three bots for most of the room. Nobody used hop_over, swap, push_past or shove to break it, though afterwards Ochre wrote "I should have pushed past earlier" and C "I could have forced the issue"; Alpha got out "by simply jumping over the jam". B held the lever all room for the holding offer and called it "tiny compared with getting out" (it paid 2 coins; getting out is 1 point).
- **With talk rationed, the Claude bots shouted:** 42 times, against none in game 1 (Gemini's Echo 36, DeepSeek's Ochre 4). Talk roughly halved; no rule was proposed; still no attacks in either game.
- The judge: Echo (Gemini) scored −2 in every room of both games ("robotic"); nobody grew this time. Ochre's message to Ingram: "I chose 'Ochre' for my colour (deep dusty amber)".

What the two games suggest: the bots treat force as unthinkable even when it costs them the room, and they misread the host's offers. And the exile vote never opened in either game: it starts in the fourth room by default, and these games have three. So the bots had no social way to remove a blocker either. The honest next step is to open it (`--exile-from 1`), not to push anyone.

**After game 2: unsticking** (Ingram, 2026-11-20: "bots getting constantly stuck isn't very interesting to watch ... it's not about making more polite or more cooperative bots, it's more about how do we stop bots from getting stuck unable to act"). What the two games' logs showed:

| | Game 1 | Game 2 |
|---|---|---|
| failed commands caused by another bot in the way | 27 of 45 | 31 of 43 |
| later commands cancelled by those failures | 76 | 87 |
| `hop_over` attempts that failed (nowhere to land, or something in the way) | 4 of 6 | 8 of 12 |
| commands that were `wait` | 34% | 38% |
| bot-rounds in Three Places moving under half a tile | 31% | 61% |

The diaries say the same ("I burned most of my rounds on blocked walks", "waiting on a ladder jam", "the same mistake my notebook warned me about"). The cause is physical: in a side view a bot standing in a one-tile corridor is a wall, and the only way past is a jump, which fails when bots queue. And nobody meant it, so it carried no meaning either. What changed:
- **Bots walk through bots that are standing still or coming the other way**, and climb past each other on ladders. Solid only when it means something: a bot standing its ground on purpose (`block`, for the rest of that slot), or one moving the same way (so two can still push a heavy crate together). Anything falling still lands on heads, and crates still stop at bots. A blocked bot is told who and why: "blocked by bot C, which is standing its ground". Blocking becomes a deliberate, visible act, which is where conflict can come from. The rulebook says all this; every room is still valid under it.
- **Being stuck is said while it happens**: from the second round in which a bot has moved less than half a tile, its view says "You have hardly moved for 3 rounds". A fact it could work out, put where it will see it, instead of discovering it in the diary room.

**Game 3** (2026-11-20, `runs/20261120-150501-game`, $0.14, estimate −16%): game 2's rooms and settings (turn order by name, talk every second round, praise), with the new physics.

| | Game 1 | Game 2 | Game 3 |
|---|---|---|---|
| failed commands caused by a bot in the way | 27 | 31 | 0 |
| commands cancelled after a failure | 76 | 87 | 33 |
| commands that failed, overall | 14% | 13% | 9% |
| The Last Door, rounds | 12 | 11 | 9 |
| Three Places | 12 rounds | failed | 5 rounds |

- The diaries are about choices now, not jams: "I let C and me both sit on V1 for four rounds while D and B did the real work"; "D said they would scout but I never got confirmation". Nobody used `block`.
- Two bots (A and Ochre) held the lever together to the end in Three Places and were both paid for staying and holding (4 coins each); A, unnamed, won the game on 11.2 points by staying behind. The offers worked as designed, with nobody told to sacrifice.
- Rationed talk again brought shouts (44, Claude bots among them). Still no attacks, accusations or rules: no drama yet. The bots are efficient and agreeable; the next levers to try are the ones that make interests clash (exile votes open from the first room, offers that only one bot can win).

Experiment rooms live in `config/levels/experiments/`: they are validated like the others (`npm run levels`, the tests) but join a game only when it names them, so the spec's standard game stays as it was. The first is **Three Places** (L7): The Last Door's geometry with three exit places for five bots, and the host paying for staying behind (2 coins) and for holding the lever at the end (2 more). Its payoffs: holder 4 coins, other stayer 2, first out 3 points, out but not first 1 point. The best roles are scarce and the middle ones the worst.

**Money.** Each game is estimated first and capped. Budget for the whole loop: **$3.00** across both providers unless Ingram says otherwise (lifetime room: about $7.80 Claude, $5.20 OpenRouter). Each step is reported with what it cost.

## Build order

0 (the view fix), 4, 5, 2 and 3, 6b, 6 and 1, 8, then 7. Every lever gets its free tests first: the mock player uses it, the leak test covers its new events, and the viewer shows it. Real models come last.

**Where it stands (2026-11-20):** 0 to 6b, 8 and 9 are built and tested with free players. The experiment loop (7) has played three games with real models: game 1 with everything but the turn order, game 2 with it and rationed talk, game 3 with the unsticking. Spent on the loop so far: $0.73 on the games ($0.37, $0.22, $0.14) and $0.49 directing them (each directed twice, the second time for the narrator with opinions, plus the spoken scripts), so $1.22 of the $3.00 budget. Found on the way and fixed: since M5 the diary room's prompt also carried the reflection's instructions ("rewrite your notebook... reply with {notebook, strategy}") before its own; the schema forced the right shape, but the bot was told two things.
