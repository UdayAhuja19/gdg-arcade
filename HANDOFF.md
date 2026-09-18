# Handoff: GDG Arcade and the party game plan

Last updated: 17 September 2026. This file is written for you, or for Claude on another device, to carry on the work without the old chat. Read it top to bottom once. After that, sections 3–6 are the reference.

---

## 1. Moving the folder to another Mac

The whole folder is about 12 MB, so AirDrop is fine. It includes the git history, all uncommitted work, `node_modules` and your `.env`.

**Before you send it**
1. Stop anything running in this folder (`Ctrl+C` in the terminal).
2. Remember that `.env` holds your MySQL password and admin PIN. Only AirDrop the folder to your own device.

**If the other Mac already has a copy of the project (with its own Claude Code chat)**

AirDrop brings everything, hidden files included, and puts the folder in that Mac's Downloads. If a `GDG` folder is already there, AirDrop names the new one `GDG 2`, and so on. To move the new files into the existing project folder:

- **Hidden files:** Finder doesn't show files whose names start with a dot: `.git`, `.env`, `.gitignore`, `.github`, `.claude`. Press **⌘ Shift .** to show them. With them hidden, *Select All* skips them.
- **Finder's "Replace" on a folder** throws away the whole old folder, including anything that only existed on that Mac. Finder's **Merge** (Option-drag) isn't offered when both folders have different versions of the same file, which is the case here. So use the Terminal command below.
- **The safe way (Terminal):** check first that the existing copy has no work of its own that you want to keep. In that folder, `git status` should show nothing you care about. Then run this, putting the existing project folder's path at the end (drag the folder into Terminal to paste its path):
  ```bash
  rsync -av --exclude node_modules --exclude .git --exclude .env ~/Downloads/GDG/ /path/to/existing/GDG/
  ```
  - **What it does:** copies every new and changed file, hidden ones included, and deletes nothing.
  - **The trailing `/` after `~/Downloads/GDG/` matters:** it copies what's *inside* the folder.
  - **`--exclude .git`** keeps that Mac's own git history. The new work shows up there as changes to commit.
  - **`--exclude .env`** keeps that Mac's own database password. If it has no `.env` yet, copy this one across once.
- **Afterwards, in the existing folder:** run `npm ci`, then `npm test`.
- **The Claude chat on that Mac** isn't touched. Chats are stored in `~/.claude` on each Mac, not in the project folder, and they stay linked as long as the project stays at the same path. It doesn't know what happened here, though, so start by telling it:
  > The project was updated from another laptop. Read CLAUDE.md and HANDOFF.md before doing anything else.

**On the new Mac**
1. Put the folder anywhere. Nothing in the project depends on its path.
2. Install Node.js **22.9 or newer**. Check with:
   ```bash
   node -v
   ```
3. Reinstall the packages cleanly. `node_modules` does travel and is pure JavaScript, but a clean install rules out problems from the copy. This needs internet: `npm ci` deletes the old `node_modules` first. If you're offline, skip this step; the copied `node_modules` works.
   ```bash
   npm ci
   ```
4. Install the Cloudflare tunnel tool. It is a Mac app, not an npm package, so it doesn't travel with the folder. You need [Homebrew](https://brew.sh) for this and for MySQL.
   ```bash
   brew install cloudflared
   ```
5. The arcade also needs MySQL. **Scores don't travel:** they live inside the MySQL server, not in this folder, so the new Mac starts with empty leaderboards. On first start the server creates the database and tables itself.
   ```bash
   brew install mysql
   ```
   ```bash
   brew services start mysql
   ```
   Then check that `DB_USER` / `DB_PASSWORD` in `.env` match a login on the new Mac.
6. Check everything works:
   ```bash
   npm test
   ```
   Expect every test to pass. The 7 database tests show as *skipped* when MySQL isn't running, and that's normal.
7. The first time you run `npm run party -- --lan`, macOS asks whether Node may accept incoming connections. Click **Allow**, or phones on the same Wi-Fi can't connect.

**Continuing with Claude Code:** in a new chat, `CLAUDE.md` loads automatically and explains how the code fits together; say *"read HANDOFF.md and continue"*. An existing chat loaded the old `CLAUDE.md`, so ask it to read **both** files again. This chat's history stays on the old laptop; these two files carry what it knew.

**Git:** nothing from this session is committed or pushed yet. Before you commit, `git status` should show:
- changed: `.claude/launch.json`, `README.md`, `package.json`, `package-lock.json`
- new: `CLAUDE.md`, `HANDOFF.md`, `party/`, `server/party/`, `public/js/shared/tap-battle.js`, `public/js/shared/snake-battle.js`, and the six test files `test/party-*.test.js`, `test/tap-battle.test.js` and `test/snake-battle.test.js`

Pushing to `main` redeploys the online demo and runs the tests on GitHub. The party test isn't part of the demo, and its tests run fine without MySQL.

The folder's git settings travel with it: commits are made as **Uday Ahuja**, and the remote is the GitHub repo behind the online demo. Check both with `git config user.name` and `git remote -v` before committing from the new Mac.

---

## 2. Where things stand

### The arcade (done, committed, live)
Five games (Dino Run, Flappy Byte, Snake, Memory Match, Stack Tower) with top-3 leaderboards in MySQL, an admin page, and an online demo on GitHub Pages. `README.md` covers setup and the fair-day checklist. `DESIGN.md` is the brand rulebook.

### The party game (being planned)
The idea: **a competitive game for up to 5 players.** Students scan a QR code, join a party on their phones, and play against each other live.

Decisions so far:

| Question | Decision | Why |
|---|---|---|
| How many rooms? | **One at a time** | It's a booth. No room codes needed. |
| What do people watch? | **The laptop, plugged into a big screen** | Spectators see all 4 players at once, which pulls a crowd. |
| What do phones do? | **Each phone runs its own copy of the game and sends progress about 10 times a second. The big screen draws all 4 side by side.** | A tap counts the moment it happens, so lag can't cost anyone a jump. At worst the screen runs a split second behind, and spectators won't notice. |
| Where does it run? | **On the laptop, with a free Cloudflare tunnel** | Costs $0 and phones can use campus Wi-Fi *or* mobile data. Render/Railway/PartyKit were considered but aren't needed for one room and a local screen. |
| Which game? | **MASH BATTLE and SNAKE ROYALE** (sections 3b and 3c); the big screen picks which one the next round plays | MASH BATTLE is simple and loud. SNAKE ROYALE is the shared-arena game Uday wanted as well. |
| How does SNAKE ROYALE handle lag? | **The laptop runs the board and draws it on the big screen; phones are only controllers** | The big screen is plugged into the laptop, so the picture has no lag. Only turns cross the network: about 50 ms one way at a 100 ms tunnel ping, under one snake step. |
| SNAKE ROYALE rules | **Out when you crash; your body turns into food; last snake left wins. No time limit.** Steer by sliding on a trackpad. | Uday's choices. The snakes slowly speed up so a round can't go on forever, and the booth has END ROUND. |
| How many players to start? | **1 or more** (`MIN_PLAYERS` in `server/party/round.js`) | You can test alone; set it to 2 for the fair. |
| How many players? | **Up to 5. The fifth colour is black (the brand's ink)** | The brand has four colours, and ink is already a game colour in the arcade. Black's snake starts at the top middle. |
| Who starts a round? | **Only the big screen** | The booth stays in control. Phones have no start button (there used to be a host phone that could start). |
| Can a player's taps get lost? | **No: each phone keeps its own bar and resends it until the laptop confirms it** | A reload, a locked screen or a network drop doesn't lose a result. |

Other game ideas considered, all of which show every player's progress on the big screen:

| Idea | Difficulty | Notes |
|---|---|---|
| Race versions of **Stack Tower** or **Flappy Byte** | Easy–moderate | Mostly reuses the existing games; the phone runs the game and reports progress. |
| **Reaction duel** (first to tap on GO) | Easy | Fair even with lag if each phone times its own tap. A good warm-up game. |
| **Snake Battle** (shared arena) | Moderate | **Built** (section 3c). The laptop runs the board, so no smoothing was needed. |
| Fast platformer or shooter | Avoid | Needs complex lag compensation. |

Rough numbers:
- **Queue:** a 90-second round plus about a minute for joining and results is roughly 24 rounds, or up to ~90 players, an hour.
- **Cost:** $0.
- **Data:** about 50 KB per player per round, so mobile data is fine.

Known risks, and what we plan to do about them:
- **Venue internet drops.** Phones reach the laptop through the tunnel, so everything stops. Keep a **phone hotspot** ready for the laptop.
- **The free quick tunnel has no uptime guarantee, and its link changes every start.** That's fine because the QR code is generated on screen. For a permanent link you'd set up a free Cloudflare account with a domain.
- **Phones lock or switch apps.** The page rejoins by itself and keeps the player's slot for 20 seconds.
- **iPhone Safari is the fussiest browser.** Test it most.
- **Cheating.** Phones report their own progress, so a determined student could fake it. Basic checks plus a supervised booth are enough.

**Step 1 was a connection test**, to find out whether the network is good enough before building a game. **Step 2 is rounds with a first game, MASH BATTLE**, and **step 3 is a second game, SNAKE ROYALE.** All three are built (sections 3, 3b and 3c) and run together. **None has been tried on campus yet.** That's the next thing to do (section 5).

### What it's built with
| Part | Technology |
|---|---|
| Server | **Node.js** (22.9+) with **Express 5** for the pages and **`ws`** for the live connections (WebSockets) |
| QR code | **`qrcode`** (npm), drawn on the laptop as an SVG |
| Phone page and big screen | Plain **HTML, CSS and JavaScript** (ES modules), no framework or build step. Styles reuse the arcade's design-sheet CSS and the bundled Archivo font. |
| Game rules | `public/js/shared/tap-battle.js`, one file used by both the phones and the server |
| Saving on the phone | The browser's **sessionStorage** (per tab, survives a reload) and **localStorage** (name and network) |
| Getting phones to the laptop | **Cloudflare quick tunnel** (`cloudflared`, free, no account), or the laptop's Wi-Fi address in `--lan` mode |
| Tests | Node's built-in **`node:test`**, run with `npm test` |
| Arcade (unchanged) | The same Node/Express server, plus **MySQL** for the leaderboards and GitHub Pages for the online demo |

---

## 3. What was built: the party connection test

Start it with one command. The big screen shows a QR code and 4 player cards. Each phone that joins gets a brand colour (red, blue, yellow or green) and a big TAP button. It sends a fake game update 10 times a second, which shows as a dot sliding along its lane on the big screen. If updates flow, the dot glides. If they stall, you *see* the dot freeze and jump.

Each card shows:
- **Ping now**, plus the **median** and **95th-percentile** ping, with a bar chart of the last 30 pings (bars over 250 ms turn red)
- **Updates/s** (should be 10/10)
- **Stutters:** gaps of more than 400 ms between updates, counted over the last minute
- **Missed:** pings with no answer within 3 s, counted over the last minute
- **Rejoins:** how many times the phone dropped and came back
- **Taps**, and whether the phone says it's on Wi-Fi or mobile data
- **A verdict for each phone**, shown at the bottom of its card:

  | Verdict | Meaning |
  |---|---|
  | **GOOD** | 95% of pings ≤ 250 ms, ≤ 2 stutters, no missed pings and no dropouts in the last minute |
  | **OK** | 95% of pings ≤ 500 ms, ≤ 6 stutters a minute |
  | **LAGGY** | Worse than OK, or more than 6 missed pings or 2 dropouts in a minute |
  | **MEASURING** | The phone has answered fewer than 3 pings |
  | **PAUSED** | The phone is locked or showing another app |
  | **RECONNECTING** | The phone dropped. It keeps its spot for 20 s. |

- **Dropouts:** a phone that loses its connection and comes back counts against its verdict for a minute. More than 2 in a minute makes it LAGGY.
- **PAUSED:** when a phone is locked or switched to another app, its card says PAUSED and nothing counts against the network until it's back. If the lock drops the connection, the rejoin still shows under REJOINS but isn't counted as a network dropout.
- **An overall banner:** *READY FOR PARTY GAMES* (every phone GOOD), *PLAYABLE, BUT A BIT SLOW*, *A PHONE DROPPED OUT*, *A PHONE IS LOCKED OR IN THE BACKGROUND*, *MEASURING…*, or *SOME PHONES ARE LAGGING*.

The big screen can **REMOVE** one phone or **CLEAR ROOM**, and a removed phone is told so even if it was offline at the time.

What phones see when something goes wrong:
- a 5th phone: *FULL*
- a phone whose spot was freed while it was away (for example after a server restart): *TIMED OUT*
- a phone that can't get back in for 30 s: *LOST IT*, with a tip to try mobile data and scan again
- the same player opened in a second tab: *OPEN ELSEWHERE* on the first tab

If the server stops, the big screen hides the QR code and shows *PARTY SERVER OFFLINE* until it's back. Rude names are blocked by the arcade's own name rules.

**Safety:** only the phone page is reachable from outside. The big screen, the arcade, the admin page and MySQL stay private to the laptop. The big screen refuses requests that don't come from the laptop itself.

## 3b. Rounds and MASH BATTLE

**How a round goes**
1. **Lobby.** Phones join and see how many players are in. The big screen shows `LOBBY · N PLAYERS`.
2. **Start.** Tap **START** on the big screen. One phone is enough (`MIN_PLAYERS = 1`). Phones can't start a round or play again: the big screen runs every round.
   - From the 3-2-1 until the round goes back to the lobby, each phone in it shows one screen that can't scroll: its colour, the round status and the TAP circle or trackpad.
3. **Countdown.** 3-2-1 on the big screen and on every phone, then GO!
4. **Battle.**
   - **Phones:** each has a bar above the TAP button. Every tap adds 1%. The bar always drains 2% a second **plus 15% of how full it is**, and after a 0.35 s pause it drains another 24% a second. So it gets harder the fuller it is: one finger stalls around 40%, two thumbs around 80%, and filling it takes 18+ taps a second with several fingers for 8–18 seconds. Most rounds are won by the fullest bar at 30 seconds. (It used to take about 2 seconds with several fingers, which was too easy.)
   - **Big screen:** one tall bar per player in their colour, with a timer. When someone fills their bar it shows "FILLED IT!" and a FULL! sticker.
5. **End.** The round ends 1.5 s after the first full bar, or at 30 s.
6. **Results.**
   - **Ranking:** full bars rank first, fastest first, then the rest by how full their bar was.
   - **Big screen:** `<RESULTS>` with the rank colours, plus **PLAY AGAIN** and **BACK TO LOBBY**.
   - **Phones:** "YOU WON!" or "YOU'RE #2", with the finish time or the bar %.
7. **Joining mid-round.** A phone that joins mid-round sits it out ("YOU'RE IN THE NEXT ONE").

Steady tapping at 10 taps a second fills the bar in about 7 s. Tapping with several fingers is allowed and reaches about 24 taps a second (about 2.4 s). The server caps anything faster than 30 taps a second (about 1.9 s); a capped full bar isn't lost, it counts as soon as the cap catches up. The tuning numbers are at the top of `public/js/shared/tap-battle.js`.

**Fairness:** each phone runs its own bar, so a tap counts the moment it happens, even on a slow connection. The laptop checks the numbers: no bar can fill faster than humanly possible, and finish times must match when the laptop heard about them (allowing about 2 s of network delay).

**Nothing is lost on the player's side**
- **Saved on the phone:** the bar is saved in the phone's browser on every tap. A reload, or a crashed tab, picks it up exactly where it was: taps, level, finish time and round clock. The bar keeps draining while the page is away, as the rules say.
- **Confirmed by the laptop:** every report is numbered and the laptop confirms it. Under the bar, the phone shows **SAVED ON THIS PHONE · SENT**, **SENDING…**, or **SENDS WHEN YOU'RE BACK ONLINE**. The final bar is resent every second until it's confirmed.
- **Late results still count:** if a phone finished while its connection was down, it hands its result in when it reconnects, even after the results are up, for up to 60 s. The rankings update on the big screen and every phone. Without the laptop's clock, a late result has to add up on its own: a possible time, enough taps, and not too many.
- **Only offline phones can send late results:** a phone that was still connected when the round closed can't change its result afterwards.

This was all tested:
- **Automated tests:** everything above, including a phone that finishes offline and reconnects after the results.
- **Browser checks:** reloading a phone mid-round, and a phone whose reports were dropped until after the results, whose result then showed up.

### Files

| File | What it does |
|---|---|
| `server/party/room.js` | The room's rules: slots, colours, 20 s rejoin grace, ping/stutter stats and verdicts. Pure logic, tested with a fake clock. |
| `server/party/server.js` | Two small servers sharing one room: the phone port (3100, tunnelled) and the big-screen port (3101, laptop only). It handles the live connections, pings, rate limits and the QR code. |
| `server/party/tunnel.js` | Starts `cloudflared`, reads the public link, and restarts it (with a new link) if it stops. |
| `server/party/index.js` | The `npm run party` command and its `--lan` / `--local` options. |
| `server/party/round.js` | Rounds: start (1+ players), countdown, the MASH BATTLE checks, late results, ranking. Pure logic, tested with a fake clock. |
| `public/js/shared/tap-battle.js` | The MASH BATTLE rules and the bar itself (fill, drain, leak, save/restore), used by phones and the server. `settleLevel()` shows where any tapping speed tops out. |
| `party/phone.html`, `party/js/phone.js` | Phone page: join form, the battle bar and TAP button, saving and resending, auto-reconnect, keep-screen-awake, Wi-Fi/mobile-data switch. |
| `party/screen.html`, `party/js/screen.js` | Big screen: QR code, START / PLAY AGAIN, 4 connection cards, the countdown, the battle bars, results, verdict banner, tips marquee. |
| `party/css/party.css` | Styles for both pages, built on the arcade's brand CSS and following `DESIGN.md`. |
| `test/party-room.test.js`, `test/party-round.test.js`, `test/tap-battle.test.js`, `test/party-server.test.js` | 47 tests: room rules, rounds, the bar, and the real server with real sockets (including crash, flood, busy-port, a full battle and a late result). |
| `package.json` | Adds the `party` script and the `ws` and `qrcode` packages. |
| `.claude/launch.json` | Adds a `party-screen` preview (`--local` mode) for Claude's browser pane. |

`CLAUDE.md` has the technical detail, including the full message protocol.

### How it was checked
- `npm test`: 70 tests; 63 pass and 7 database tests skip when MySQL is off.
- **Browser checks** used four simulated phones (good, slow, lagging, and one that locks its screen) plus a phone page driven by hand. They covered:
  - joining, a bad name, taps and the network switch
  - reloading the phone (it kept its slot)
  - REMOVE and PARTY FULL
  - stopping the server (the screen went to OFFLINE and the phone to RECONNECTING)
  - restarting the server (the screen recovered, and the phone showed TIMED OUT)
- **Big screen:** checked at 1920×1080, 1600×900, 1440×820, 1280×720 and 1024×768; it fits without scrolling at all five. It also reflows at narrow window widths.
- **Phone page:** checked at 375 px and 320 px wide.
- **Tunnel code:** checked with a fake `cloudflared` that prints the real tool's output. The code picked up the link and restarted with a new one when the tool quit. With no `cloudflared` installed, the screen shows the install hint instead.
- **Not yet checked:** real phones, a real Cloudflare tunnel (`cloudflared` wasn't installed on the old laptop), or campus Wi-Fi.

---

## 3c. SNAKE ROYALE

**How to play it**
1. On the big screen, pick **SNAKE ROYALE** under NEXT GAME (bottom right). You can only switch between rounds.
2. Start it from the big screen, the same as MASH BATTLE.
3. **Countdown:** the board shows every snake in its corner with the player's name beside it (red top left, blue top right, yellow bottom right, green bottom left, black top middle). Phones say "YOU'RE RED, TOP LEFT".
4. **Playing:**
   - **Phones** show a trackpad. Slide a finger the way you want to go; keep gliding to turn again (an L-shaped slide is two turns). The edge arrow for your last turn lights up. Arrow keys/WASD work in a laptop window. UP means up on the big screen.
   - **The big screen** shows the board, plus a legend of who is which colour, how long each snake is, and what knocked each one out.
   - Eat the dots to grow. Hit a wall, yourself or another snake and you're out, and your body turns into food. Two heads meeting knocks both out.
5. **End:** when one snake is left it wins. The final board stays up for 1.5 s, then `<RESULTS>`: rank, name, how it went (LAST ONE STANDING / OUT AT 0:21) and length. Several players knocked out on the same step rank by length; equal lengths are a DRAW. Playing alone ends with GAME OVER when you crash.
6. **No time limit.** The snakes speed up slowly (7 → 10 steps a second), and the big screen has **END ROUND** if a round drags on; live snakes then rank by length.

**What happens when a phone drops:** its snake keeps going straight, usually into a wall. Turns are never resent, because an old turn arriving late would steer somewhere the player no longer wants. A phone that rejoins within 20 s gets its controls back. A player removed before GO just disappears; after GO their snake turns into food.

**Tuning:** board size, speed, spawn distance and food are at the top of `public/js/shared/snake-battle.js`.

### Files

| File | What it does |
|---|---|
| `public/js/shared/snake-battle.js` | The board rules: spawns, turns, one step (collisions, eating, corpses into food), speed. Pure logic. |
| `server/party/snake-round.js` | A SNAKE ROYALE round: countdown, stepping on the laptop's clock, who's out, the ending, ranking, END ROUND, and each phone's view. Pure logic, tested with a fake clock. |
| `server/party/server.js` | Now keeps both games' rounds, the NEXT GAME switch, a 10 ms game timer, and `turn` / `arena` / `game` / `end` messages. |
| `party/js/snake-board.js` | The big screen's board canvas: graph paper, food, outlined snakes, name tags, OUT! stickers. |
| `party/screen.html`, `party/js/screen.js` | NEXT GAME switch, the snake section with its legend, and snake results. |
| `party/phone.html`, `party/js/phone.js` | The trackpad, keys, and snake status text. |
| `test/snake-battle.test.js`, `test/party-snake-round.test.js`, `test/party-server.test.js` | 32 new tests: every crash type, tails, eating, corpse food, speed, rounds, draws, removals, END ROUND, and a real-socket snake round. |

### How it was checked
- `npm test`: 102 tests pass, with MySQL on.
- **Browser checks:** 3 bot phones steering around each other plus a phone page, on the big screen at 1920×1080, 1280×720 and 1024×768 and the phone at 375 px:
  - the switch, the countdown with name tags, play, crashes turning into food, results, and GAME OVER when playing alone
  - arrow-key and swipe steering
  - MASH BATTLE still working afterwards
- **Not yet checked:** real phones, touch swipes on an iPhone, the tunnel, and campus Wi-Fi.

---


## 3d. SPLIT SECOND

From the "stop the stopwatch at exactly 10.00" trend (Uday's idea, 18 Sep).

**How to play it**
1. Pick **SPLIT SECOND** under NEXT GAME, then START.
2. A game is **3 rounds**. Each round shows a random target of 1, 2, 3, 4 or 5 seconds (no repeats), then opens a **30-second window**.
3. In the window each phone has one big button: START, then STOP, as many times as you like. **The phone never shows a number**, so you count in your head. When you're happy with a run, press **`<LOCK IT IN>`**.
4. The big screen shows every player's clock running and every stopped time with how far off it was. The players can't see it, the crowd can.
5. The window ends when everyone has locked in, or at 30 seconds (an unlocked phone keeps its last stopped run; no run at all costs 5.00).
6. **Reveal:** each phone finally shows its own time and error, and the big screen shows the times and totals so far. Then the next round.
7. After 3 rounds: lowest total error wins.

**Decisions:** the phone owns the clock (a press counts the moment it happens) and the laptop only checks it against its own clock for the same run. Start/stop are sent once; a lock is resent until the laptop confirms it. Nothing on the phone moves while a run is going, since a rhythm would help people count.

**To test on campus:** whether 30 seconds is the right window, whether players can see the big screen from where they stand (if they can, it stops being blind), and whether 5.00 for a miss feels fair.


## 3e. LIGHTS OUT (replaces SNAKE ROYALE on the switch)

Eduroam blocks phones from reaching the laptop directly, so the stall has to use the Cloudflare tunnel, and SNAKE ROYALE's steering suffers from the ping. LIGHTS OUT is the F1 start-light reaction test and doesn't care about ping at all. SNAKE ROYALE's code is kept; only its NEXT GAME button is gone.

**How to play:** 3 starts. Five red lights come on one a second on the big screen and every phone, then after a random 0.2–3 s hold they all go out: tap as fast as you can. Tapping before lights out is a JUMP START (+1.000). No tap within 1.5 s is +1.000. Lowest total over 3 starts wins.

**How it beats the ping:** the laptop schedules each start on its own clock and sends the whole schedule before the first light. Each phone syncs its clock with the laptop, then switches its own lights off at the scheduled moment, so every phone and the big screen go dark together. The reaction is timed on the phone, so the tunnel's delay never enters anyone's time.

**To test on campus:** that the phones' lights and the big screen's go out together over the tunnel (film it), and that 1.5 s is enough to tap.

## 4. How to run it

```bash
npm run party
```

Then open **http://localhost:3101** on the laptop (or the big screen) and scan the QR code with phones.

| Command | Phones join through | Use it for |
|---|---|---|
| `npm run party` | A public Cloudflare link (needs `cloudflared`) | The real test: campus Wi-Fi *and* mobile data |
| `npm run party -- --lan` | The laptop's address on the same Wi-Fi | Testing at home without the tunnel |
| `npm run party -- --local` | Nothing leaves the laptop | Trying it alone: open http://localhost:3100 in **separate browser windows** side by side as "phones". A phone in a background tab shows as PAUSED, which is correct. |

- **Custom ports:** set `PARTY_PORT` and `PARTY_SCREEN_PORT` if 3100/3101 are busy.
- **Full screen:** kiosk mode works the same way as for the arcade:
  ```bash
  open -a "Google Chrome" --args --kiosk http://localhost:3101
  ```
- **Tunnel link won't open?** If you've ever set up a named Cloudflare tunnel, a `config.yml` or `config.yaml` file in `~/.cloudflared/` stops quick tunnels from working. Rename it for the test.
- **Keep-awake only works over the tunnel:** it needs https, so in `--lan` mode phones may dim their screens.

---

## 5. Next: the campus test (about 15 minutes)

Bring the laptop, a charger, and 5 phones: **at least one iPhone and one Android**. If you can, connect the laptop to the booth's actual screen.

1. `npm run party`, open http://localhost:3101, and wait for the QR code.
2. Join all 5 phones **on campus Wi-Fi**. Leave them for 2 minutes and note each verdict.
3. Switch 2 phones to **mobile data**. On each phone, tap *MOBILE DATA* under "Switched network?". Wait 2 minutes and note the verdicts.
4. **Lock one phone for 5 seconds**, then unlock it. Its card should say PAUSED, then carry on in the same colour. If the lock dropped the connection, REJOINS goes up by 1, but the verdict shouldn't suffer.
5. **Switch an app away and back**, and **turn Wi-Fi off and on**.
6. **Walk to the far end of the booth.**
7. **Play a few MASH BATTLE rounds** with 2, 3 and 5 phones. Watch whether the big screen's bars keep up, and whether the winner feels right to the players.
8. **Play a few SNAKE ROYALE rounds** with 2, 3 and 5 phones, over the tunnel and on mobile data. Ask players whether turns land when they press, and try swiping on an iPhone. If turns feel late, note the ping and stutters on the cards.
9. **Lock a phone or turn its Wi-Fi off mid-battle**, then come back. Its bar should still be there, and its result should still reach the big screen.
10. If campus Wi-Fi blocks the page entirely (it never loads, or it's stuck on CONNECTING…), note that too. Mobile data is the fallback.

Record the results in this table:

| Phone | Network | Median ms | 95% ms | Stutters | Rejoin OK? | Verdict |
|---|---|---|---|---|---|---|
| | Wi-Fi | | | | | |
| | Mobile data | | | | | |

**How to read the results**
- **All GOOD on Wi-Fi or mobile data:** go ahead with the plan in section 2 as it stands.
- **Mostly OK:** fine for MASH BATTLE. SNAKE ROYALE should still work, since the laptop runs it, but check whether turns feel late; slowing the snakes (`START_STEPS_PER_SEC`) helps.
- **LAGGY, or Wi-Fi blocks it:** try mobile data only, or use the laptop on a phone hotspot. If that's also bad, look at a hosted server near Dubai (Render/Railway, or PartyKit), or a turn-based or reaction game.
- **Rejoin fails on iPhone:** that has to be fixed before building the game. Note the iOS version and what you did.

---

## 6. After the test: building the game (suggested plan)

The round flow, the fairness checks and the no-lost-data plumbing are done. What's left:
1. **Pick the fair's games, or add another.** There are two now. A new game follows one of the two patterns:
   - **Phones run it** (like MASH BATTLE): a rules file like `tap-battle.js`, its own checks like `round.js` `report()`, and resending.
   - **The laptop runs it** (like SNAKE ROYALE): a rules file like `snake-battle.js`, a round like `snake-round.js`, and frames to the big screen.

   Either way it needs its own phone and big-screen views, an entry in `rounds` and `GAMES` in `server.js`, and a button on the NEXT GAME switch. The lobby, countdown and results stay as they are.
2. **Tune both games** after the campus test: fill per tap, drain, leak and time limit at the top of `tap-battle.js`; speed, board size and food at the top of `snake-battle.js`.
3. **Set `MIN_PLAYERS` to 2** for the fair if solo rounds shouldn't be allowed.
4. **Winners on the leaderboard:** use the arcade's MySQL API. A new game key needs entries in `public/js/shared/games.js` and `server/games.js`; see `CLAUDE.md`. Decide whether party wins get their own board.
5. **Playtest with 4 real phones on campus about a week before the fair.**

**Open questions for the team:**
- Which games for the fair: MASH BATTLE, SNAKE ROYALE, or both?
- Is SNAKE ROYALE's speed right (7 → 10 steps a second)? Should it have a time limit after all?
- Do party winners go on a leaderboard?
- Is the 30 s time limit right? Most rounds end sooner, when someone fills their bar.
- Should solo rounds be allowed at the fair (`MIN_PLAYERS` 1 or 2)?

---

## 7. Review findings (all fixed)

After building, the code went through an automated review in five areas: server logic, security of the public phone port, real-phone behaviour, the design rules, and moving the folder. A second pass tried to disprove each finding. Every finding that held up is fixed and covered by a test or a browser check:

| Area | What was wrong | Fix |
|---|---|---|
| Security | Anyone with the link could crash the server by opening a 25th connection and sending junk | Error handling is attached before anything else; extra connections are cut straight away |
| Server | A busy port crashed the server instead of showing the friendly message | Fixed; now tested |
| Server | Pages returned 404 if the project sat inside a folder whose name starts with a dot | Fixed; error pages never show file paths |
| Results | A locked phone or background tab was counted as network lag | New PAUSED state; nothing counts while paused |
| Results | A few seconds of Wi-Fi stall released a burst of queued messages that tripped the flood limit | The flood limit allows a burst |
| Results | A phone that kept dropping out could still read READY | Dropouts in the last minute count against the verdict |
| Results | A phone whose pings all took over 3 s sat on MEASURING forever | It now reads LAGGY; late answers still count as ping times |
| Results | A Wi-Fi-to-mobile-data switch wasn't counted as a rejoin | It now is |
| Phone | Two tabs in one browser fought over the same player in an endless loop | Each tab is its own player; a duplicate tab steps aside ("OPEN ELSEWHERE") |
| Phone | A stuck connection could show CONNECTED for minutes | 3.5 s of silence starts a fresh connection |
| Phone | Removed or timed-out phones silently came back as new players, and phones retried a dead link forever | Phones get REMOVED / TIMED OUT, and give up after 30 s with a hint |
| Phone | LEAVE then a quick JOIN could leave the phone on a dead screen | Fixed |
| Phone | The screen stayed awake after leaving | The keep-awake lock is released |
| Phone | Pinch-zoom was blocked on Android | Allowed again; double-tap zoom is still off |
| Design | Corner shapes painted over the player cards instead of peeking from behind | Fixed |
| Design | The "server isn't running" banner had no styling | Fixed |
| Design | "JOINING…" was grey text on yellow and couldn't be read | Shows as a white button while busy |
| Design | Phone stats spilled off 320 px screens; stat labels were cut off on 1024×768 projectors | Both fit now |
| Design | The tips marquee jumped at the end of each loop | Fixed |
| Big screen | After the server stopped, the screen still showed a QR code and green verdicts | It now shows PARTY SERVER OFFLINE and hides the QR code |

**Left as is, on purpose:**
- Someone who has the link could hold all 24 connection slots, or join 4 fake players. At a supervised booth, **CLEAR ROOM** and a restart (which changes the link) are enough.
- Phones report their own bar, so someone who edits the page could fake a result, within the limits the laptop checks.
  - **Live:** nothing faster than 30 taps a second, and finish times have to match when the laptop heard them.
  - **Late results** (from a phone that was offline at the end) can only be checked for being possible: enough taps, not too fast.

  At a supervised booth this is fine. For prizes, keep an eye on any result that shows up late.
- The arcade itself has two small issues of the same kind, outside this work:
  - its 404 page breaks inside dot-folders (`server/app.js`)
  - disabled yellow buttons stay yellow (`public/css/components.css`)
