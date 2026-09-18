# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A club-fair arcade (five canvas games with top-3 leaderboards) for GDG on Campus UOBD. Node 22.9+ / Express 5 / MySQL (`mysql2`), plain ES-module HTML/CSS/JS in the browser, no bundler and no frontend framework. It has to work **offline** at the fair, so nothing may load from the internet (fonts are bundled in `public/fonts/`).

## Commands

```bash
npm start              # server on http://localhost:3000 (loads .env if present)
npm run dev            # same, with node --watch
npm test               # node:test over test/*.test.js
node --env-file-if-exists=.env --test test/validate.test.js   # a single test file
node --env-file-if-exists=.env --test --test-name-pattern="reset" "test/*.test.js"   # tests matching a name
npm run build:static   # GitHub Pages demo into dist/ (serve it over HTTP, not file://)
npm run party          # party connection test: big screen on :3101, phones via a Cloudflare quick tunnel to :3100
npm run party -- --lan     # phones on the same Wi-Fi join the laptop directly (no tunnel)
npm run party -- --local   # nothing leaves the laptop; open http://localhost:3100 in separate windows as "phones"
node scripts/socials-qr.js [outDir]   # remake public/assets/socials-qr.svg (plus print PNG/SVG in outDir)
```

There is no linter or build step for the server version. `.claude/launch.json` defines five previews: `gdg-arcade` (`npm run dev`, port 3000); for the party test `party-tunnel` (`npm run party`), `party-screen` (`--local`) and `party-lan` (`--lan`), all on port 3101; and `gdg-resources` (port 8010), which serves the sibling `../gdg-resources` repo. Tunnel mode needs `cloudflared` installed on the machine (`brew install cloudflared`); it is not an npm dependency.

`.env` (copied from `.env.example`) holds `DB_*` and `ADMIN_PIN`. The server creates the database and applies `db/schema.sql` itself on startup. `test/api.test.js` uses a throwaway `gdg_arcade_test` database (dropped afterwards) and **skips itself when MySQL is unreachable**, which is how CI runs.

## Architecture

**One codebase, two deployments.** `public/js/config.js` exports `MODE = "server"`. `scripts/build-static.js` copies `public/` to `dist/`, leaves out `admin.html`/`js/admin.js`, and rewrites `config.js` to `MODE = "static"`. `public/js/api.js` then chooses between `serverApi` (fetch to `/api`, MySQL) and `localApi` (`public/js/local-api.js`, localStorage). Both must expose the same interface (including `playerExists(name)`: the home page uses it to ask "are you that player?" before reusing a name someone already has) **and the same ranking rules**: each player's best score per game, earliest wins ties, and names are case-insensitive. `test/local-api.test.js` checks that the demo matches. Bump `SCORES_VERSION` in `local-api.js` to wipe every visitor's demo leaderboard. The GitHub Actions workflow (`.github/workflows/pages.yml`) runs the tests, builds and deploys on every push to `main`.

**Code shared by server and browser** lives in `public/js/shared/` (`games.js` game list/metadata, `names.js` name normalisation). The server imports it directly from `public/`.

**Server** (`server/`): `index.js` binds to `127.0.0.1` only (booth laptop). `app.js` mounts `/api` and serves `public/` statically, with extensionless `.html` and a fallback to `index.html`. `db.js` keeps a lazy pool that retries every 5s. When the DB is down, `getPool()` returns null and the API answers 503, and the pages show a red "not saving" banner instead of failing. `api.js` holds the raw SQL (window functions for top 3 and standing) and the PIN-protected admin routes (`x-admin-pin` header, timing-safe compare).

**Anti-cheat run flow:** `POST /api/runs` creates a run with a random token and `started_at`. `POST /api/runs/:id/finish` accepts one score per token. `server/games.js` `checkScore` rejects scores above `maxScore` or above `maxPerSec × elapsed × 1.5 + 100`. **If you change a game's scoring in `public/js/games/*.js`, update `LIMITS` in `server/games.js` to match.** Admins hide runs (`hidden = 1`) rather than deleting them.

**Client game engine** (`public/js/engine/`):
- `loop.js`: fixed 60Hz simulation step (`TICK_HZ`), so 120Hz displays don't speed games up. Game timing should count ticks, not wall-clock time.
- `shell.js`: runs every game through the same flow: ready → 3-2-1 countdown → playing → saving → game over. It starts and finishes the run through `api`, and handles the 45s idle reset (`session.js`).
- `input.js` turns keys and clicks into actions (`primary`, `up`/`down`/`left`/`right`, …). `draw.js` has the brand canvas helpers (`paper`, `disc`, `blob`, `label`, `scoreHud`, popups).
- Each `public/js/games/<key>.js` exports `mount(root, { onScore, onGameOver })` and returns `{ start(), input(action, pressed, repeat, event), … }`. `play.js` lazy-loads them through its `GAME_MODULES` map. A new game needs entries in `shared/games.js`, `GAME_MODULES`, `server/games.js` `LIMITS`, and art in `public/assets/art/`. Difficulty tuning constants sit at the top of each game file.

**Design system:** `DESIGN.md` is the brand spec, shown live at `/design-sheet`. Follow it for UI work: all-caps Archivo, flat brand colours with no gradients or transparency, 3px ink outlines, hard no-blur shadows, bracketed headings like `<PLAY AGAIN>`, and nothing moving under reduced motion. Tokens are in `public/css/tokens.css`. User-facing error strings are short and in capitals, e.g. `"THAT GAME DOESN'T EXIST."`.

## Party connection test (`server/party/`, `party/`)

The 5-player party game, in progress: one laptop drives a big screen, and up to 5 phones join by QR code. Phones play **rounds of MASH BATTLE, LIGHTS OUT or SPLIT SECOND** (the big screen's NEXT GAME switch picks one; SNAKE ROYALE's code is still there, but its switch button was removed because its steering suffers over the tunnel, which eduroam forces) while the screen also shows connection health. **Read `HANDOFF.md` before working on it**: it records the decisions, current status, the planned campus test, the next steps and open questions for the team, and the review findings that were deliberately left unfixed. It is **separate from the arcade**: its own process, no MySQL, not part of the static demo build.

- **Two ports, one room.** `server/party/server.js` runs a phone server (`PARTY_PORT`, default 3100) and a big-screen server (`PARTY_SCREEN_PORT`, default 3101). Only the phone port is ever tunnelled or exposed. It serves `party/phone.html` plus the shared CSS, fonts, assets and `public/js/shared/`, and nothing from the arcade. The screen port also serves `public/js/engine/draw.js` (for the snake board). It binds to `127.0.0.1`, rejects any non-localhost `Host`, and only accepts WebSockets whose `Origin` matches.
- **`room.js` is pure logic** (no sockets or timers; everything takes `now`), so `test/party-room.test.js` drives it with a fake clock. It handles:
  - slots and colours (red, blue, yellow, green, black), and a 20s rejoin grace keyed by the phone's `clientId`. **Black is the brand's ink**, so anything written on a player's colour uses the `--on-player` CSS token (ink, or paper on black), and `snake-board.js` maps black to `C.ink`.
  - ping, update and stutter stats, with per-phone and overall verdicts. Stutters, missed pings and dropouts count over a rolling minute.
  - a **paused** state for a phone whose page is hidden (locked screen, other app). While paused, nothing the phone does counts against the network, and a dropout that starts while paused doesn't count as one.
- **Four games, one round shape.** `server.js` keeps `rounds = { tap, snake, split, lights }` and a current `game` (default `tap`). All round objects share an interface (`start`, `tick`, `remove`, `toLobby`, `reset`, `snapshot`, `viewFor`), and `state.round` and `round` messages carry `game`. The screen can switch games only in the lobby or results (switching away from results calls `toLobby()`). Kick, leave and the sweep remove the phone from every round.
- **MASH BATTLE rounds** (`round.js`, also pure logic; tests in `test/party-round.test.js`): lobby → countdown (3s) → playing (30s limit) → results.
  - A round (of either game) starts with **`MIN_PLAYERS` (1)** or more connected phones. **Only the big screen starts rounds** (START, PLAY AGAIN). Phones have no start button and the server ignores anything a phone sends to start one.
  - **MASH BATTLE's rules** live in `public/js/shared/tap-battle.js` (shared by phone and server): each tap adds `TAP_FILL` (1), the bar always drains `DRAIN_PER_SEC` (2/s) **plus `LEAK_PER_SEC` (15%) of its current level every second** (solved exactly with an exponential, not stepped), and after `IDLE_AFTER_MS` without a tap it also drains `IDLE_DRAIN_PER_SEC`. The leak makes each tapping speed settle at `settleLevel(tapsPerSec)`: one finger (~8/s) stalls near 40%, two thumbs (~14/s) near 80%, and filling needs 18+ taps/s held for 8–18s, so it's hard on purpose and tired fingers lose. First full bar wins; at the time limit, the fullest bar wins.
  - **Phones run the bar and the server checks it.** Levels are capped by `maxLevelAt(time played) + 10`, the bar's curve at `MAX_TAPS_PER_SEC` = 30 with the leak counted, so the fastest possible fill (`MIN_FILL_MS`) is about 5.1s and takes at least `TAPS_TO_FILL` (153) taps. A final bar held back by the cap gets status `capped`, isn't locked in, and the phone keeps resending it until the cap allows it. A finish time is the phone's own, clamped to `[max(MIN_FILL_MS, serverElapsed − 2s), serverElapsed]`.
  - **The first full bar closes the round** `finishWindowMs` (1.5s) later, so near-simultaneous finishes are ranked by their own times.
- **Nothing is lost on the phone side:**
  - `phone.js` saves the battle (bar state via `bar.save()`, round number, start time as a wall-clock epoch, report seq) to sessionStorage on every tap. A reload restores it exactly.
  - Every `progress` report carries `round` and `seq`, and the server answers `ack {seq,status}`. The phone resends its final bar (`final: true`) every second until acked.
  - `report()` returns a status: `saved`, `final` (already final), `too-late` (other round, or past `LATE_REPORT_MS`) or `rejected`.
  - During results, a **late final** is accepted only if the phone was offline at the close: no live report within 1s of the close. It must also add up on its own (`MIN_FILL_MS ≤ ms ≤ roundMs`, `TAPS_TO_FILL ≤ taps ≤ MAX_TAPS_PER_SEC (30/s) × ms`). It re-ranks the results and is broadcast.
  - When the results arrive, a phone whose local clock still says "playing" freezes its bar at that moment.
- **SNAKE ROYALE** is the opposite design: **the laptop runs the game and phones are only controllers.** Players watch the big screen, which is local, so the board has no network lag.
  - **Rules** are in `public/js/shared/snake-battle.js` (pure; `createArena(slots, { random, layout })`, tests in `test/snake-battle.test.js`). The board is 32×20, and each slot has a fixed spawn: the four corners are 180°-symmetric (red top left … green bottom left), and black starts at the top middle heading down (the spot that, in bot simulations, kept early crashes lowest without hurting the corners). Snakes speed up from 7 to 10 steps/s. Up to 2 turns queue, and reversing or repeating a direction is ignored.
  - **A step** moves every snake at once, then checks each head against every snake's new body, including snakes dying in the same step. Causes are `wall`, `self`, `body` and `head` (same cell or swapped cells, both die). A tail that moves away is safe; a growing snake's tail is not. A dead snake's pre-move body becomes food (skipping cells survivors now cover). Food tops up to snakes + 2.
  - **Rounds** (`snake-round.js`, pure; tests in `test/party-snake-round.test.js`): countdown (3s) → playing, with **no time limit** → results. Play ends when ≤ 1 snake is left, or when the only snake dies in a solo round (a solo round has no winner, just GAME OVER). The final board stays up for `endPauseMs` (1.5s) before the results. `advance(now)` runs at most one step per call and skips ahead after a stall rather than bursting. Ranking: alive first, then later death, then longer; anything still tied shares the rank, so a tie at #1 is a draw. The screen's END ROUND (`end`) stops a round, and live snakes rank by length.
  - **Server:** a `gameEveryMs` (10ms) timer calls `tick`/`advance`. Each step sends an `arena` frame to screens only; deaths or the end send everyone their `round` view, and growth updates just that phone. Turns (`turn {round,dir}`) are **never acked or resent**, because a late turn is worse than a lost one. A dropped phone's snake keeps going straight. A phone removed before GO just vanishes; after GO its snake dies (`left`) and becomes food.
  - **Big screen lobby** (`party/screen.html`, `party/js/screen.js`) is built for spectators: the next game's name as a huge bracketed title with a tagline, a big SCAN TO PLAY QR card, a PREVIEW card where `party/js/lobby-demo.js` plays the next game with bots (real `createArena` rules on the real board renderer for SNAKE ROYALE, five racing bars for MASH BATTLE; it only runs while the lobby is visible and shows a still frame under reduced motion), and five seats that show only colour, number and name (it was too crowded with ping, verdict and REMOVE on each). **STATS** (remembered in localStorage) swaps in the per-phone connection cards 3 by 2, with REMOVE, and each card reflows to its own width with a container query. The lobby is hidden while a round is on.
  - **Socials card:** the big screen's footer always ends, bottom right, with a yellow `<JOIN OUR CLUB>` card and a QR code (`public/assets/socials-qr.svg`). It is shown in the lobby, during rounds and on results. The code points to the club's socials page, which lives in the separate `gdg-resources` repo (`socials/`, https://udayahuja19.github.io/gdg-resources/socials/). That page deliberately has no links back into the resources site. The URL is `SOCIALS_URL` in `scripts/socials-qr.js`; rerun the script if it ever changes.
  - **Big screen** (`party/js/snake-board.js`) draws the board on a canvas with the arcade's `draw.js` helpers, name tags beside each head during the countdown, and an `OUT!` sticker where a snake crashed. A legend lists who is which colour.
  - **Phone** shows a trackpad: sliding a finger turns the snake each time it travels 22px (`SWIPE_PX`) in a new direction, so an L-shaped slide is two turns and gliding on keeps steering. A dot follows the finger and the edge arrow for the last turn lights up. Arrow keys/WASD work in a laptop window. Between rounds a touch (or key) sends `tap`.
- **SPLIT SECOND** (key `split`), from the "stop the stopwatch at exactly 10.00" trend. **The phone owns the clock and is blind; the big screen shows everything.**
  - **Rules** in `public/js/shared/split-second.js`: a game is 3 **legs** (shown as ROUND 1 OF 3), each with a distinct random target from 1–5s. Error = |time − target|; a leg with nothing locked costs `MISS_MS` (5s); lowest total wins, then best single leg, then earliest lock; exact ties share a rank (draw).
  - **Round** (`split-round.js`, pure; tests in `test/party-split-round.test.js`): countdown → per leg `set` (target shown, 2s) → `run` (30s window) → `reveal` (6s) → next leg → results. In a window a phone may start/stop as often as it likes, then `<LOCK IT IN>`; the leg ends when everyone has locked or at 30s (an unlocked phone keeps its last stopped run; a run left going stops at `RUN_LIMIT_MS`). `act(clientId, {event: start|stop|lock, ms}, now)`: the server stamps a run's start on its own clock and clamps the phone's `ms` to `[MIN_MS, serverRunMs + 1.5s]`.
  - **Blind:** `viewFor` never carries a time or another player's anything until `reveal`; tests assert it. The phone button shows only START/STOP/AGAIN and `RUN n`, with nothing moving while a run goes (a rhythm would help people count).
  - **Server:** `runSplit()` ticks the round on the 10ms game timer; phone `split {round,leg,seq,event,ms}` is acked (the phone resends a lock until confirmed; start/stop are not resent) and relayed at once to screens as `split {slot,event,runs,ms,error,locked}`. The screen runs its own clock per lane for the crowd while a run is going and snaps to the phone's number when the stop lands. The phone keeps its run start as a wall-clock epoch in sessionStorage (`gdg-party-split`), so a reload mid-run keeps counting.
- **LIGHTS OUT** (key `lights`), the F1 reaction test, built to be **immune to ping**.
  - **Rules** in `public/js/shared/lights-out.js`: 3 starts; 5 lights come on 1s apart, then all go out after a random hold (`holdFor`, 0.2–3s, 10ms steps). Reaction = tap after lights out. A tap before lights out, or under `MIN_REACTION_MS` (100) after, is a jump start; jump starts and no-taps within `REACT_WINDOW_MS` (1.5s) cost `PENALTY_MS` (1.000); reactions are capped there too. Lowest total wins, then best start, then earliest tap.
  - **Round** (`lights-round.js`, pure; tests in `test/party-lights-round.test.js`): countdown (2s) → per start `grid` (2.5s lead, then the lights) → `go` (window) → `reveal` (5s). **The schedule is sent ahead as server-clock times** (`lightsAt`, `lightTimes`, `outAt`, `serverNow`); nothing about lights out is sent at lights out.
  - **Clock sync:** phones send `sync {c}` (on join and at each start), the server answers `sync {c,s}`, and the phone keeps the offset from the quickest round trip. Each phone turns its lights off at `outAt` on its own clock, and the big screen converts server time with `Date.now()` (same machine), so every gantry goes out together regardless of ping. The phone times the reaction from the frame its lights went off (falling back to the scheduled time if no frame ran), and the server clamps it to `serverElapsed + 250ms`.
  - Phone taps (`lights {round,leg,seq,ms|jump}`) are acked and resent every 500ms until confirmed; screens get `lights {slot,ms,jump}` at once.
- **WebSocket protocol:** JSON with a `t` field. The server measures RTT on its own clock.

  | Direction | Messages |
  |---|---|
  | Phone → server | `join {clientId,name,network,rejoin}`, `pong {id}`, `update {x}` (10Hz), `tap` (lobby), `progress {round,seq,level,taps,done,ms,final}` (10Hz in a MASH BATTLE round), `turn {round,dir}` (SNAKE ROYALE), `split {round,leg,seq,event,ms}` (SPLIT SECOND), `lights {round,leg,seq,ms,jump}` and `sync {c}` (LIGHTS OUT), `network`, `pause`, `resume`, `leave` |
  | Server → phone | `joined`, `full`, `error`, `expired`, `kicked`, `ping {id,rtt,verdict}` (1Hz), `tapped`, `round` (that phone's view: game, phase, timing, players, winner, result; for snake also alive, length, cause, spawn), `ack {round,seq,status}`, `notice`, `left` |
  | Server → screen | `join {url,qr,tunnel}` (on change), `state` (room snapshot + `round`, every 250ms), `u {slot,x}`, `bar {slot,level,full}` (relayed immediately), `arena {round,step,cols,rows,snakes,food}` (every snake step; bodies and food as flat arrays), `split {slot,event,runs,ms,error,locked}` and `lights {slot,ms,jump}` (relayed immediately), `tap`, `notice` |
  | Screen → server | `kick {slot}`, `clear`, `start`, `lobby`, `game {game}` (between rounds), `end` (SNAKE ROYALE) |

- **Rejoining:**
  - `rejoin: true` means "I was in the party". If that spot is gone, the server answers `expired`, or `kicked` if the big screen removed the phone while it was offline, instead of silently giving it a new slot.
  - A new socket for a `clientId` that already has one replaces it: the old socket gets close code `4001`, and the swap counts as a dropout. The phone treats `4001` as final and shows "OPEN ELSEWHERE".
- **Server limits:**
  - a token-bucket rate limit (60 messages/s, burst 200, so a stalled phone's backlog isn't punished)
  - 512-byte messages and 24 sockets
  - a socket that never joins is dropped after 60s, and one that goes silent is dropped after 10s
  - every socket gets its `error` listener **before** anything else, or a bad frame crashes the process
- **Tunnel:** `tunnel.js` spawns `cloudflared tunnel --url`, waits for both the `trycloudflare.com` URL and "Registered tunnel connection", and restarts with a new URL if cloudflared exits. The screen redraws the QR code whenever the URL changes.
- **Phone client** (`party/js/phone.js`):
  - The player id lives in **sessionStorage**, so each tab or window is its own player; the name lives in localStorage. A sessionStorage flag makes a reload rejoin automatically.
  - It reconnects with backoff, and immediately on becoming visible, on `pageshow` or on `online`. It gives up after 30s ("LOST IT").
  - It treats 3.5s without a server ping as a dead connection.
  - It sends `pause`/`resume` on visibility changes and stops its update timer while hidden.
  - It holds a screen Wake Lock (https only) and releases it on leaving. Taps use `pointerdown`.
- **In a round the phone locks to one screen.** From its countdown through results, `phone.js` puts `in-game` on `<body>`: the page is fixed with no scrolling, the header, stats, network picker and leave link are hidden, and the TAP circle (sized in `.tap-zone` with container units) or the trackpad fills the height that's left. Back in the lobby it's the normal scrolling page.
- Names go through the arcade's `normalizeName`, so the same blocklist and messages apply.
