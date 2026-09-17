# GDG Arcade — Club Fair

Five quick games for the GDG on Campus UOBD booth: **Dino Run, Flappy Byte, Snake, Memory Match and Stack Tower**.
A student types their name, picks a game and plays. Each game keeps a **top 3** leaderboard, stored in MySQL on this laptop.

- **Online demo:** https://udayahuja19.github.io/gdg-arcade/ (scores save on each device only)
- Arcade: http://localhost:3000
- Admin (hide rude names, reset scores): http://localhost:3000/admin
- Design sheet (brand rules): http://localhost:3000/design-sheet, also written up in [DESIGN.md](DESIGN.md)

Stack: Node.js + Express, MySQL, plain HTML/CSS/JS with canvas games. Nothing loads from the internet, so it works offline at the fair.

There are two versions from the same code:

| | Fair laptop | Online demo (GitHub Pages) |
|---|---|---|
| Runs on | `npm start` on this laptop | Any browser, via a public link |
| Scores | Shared top 3 in MySQL | Each device keeps its own top 3 (browser storage) |
| Admin page | Yes | No |

---

## Setup (once)

You need Node.js 22.9+ and MySQL running locally (`brew services start mysql`).

```bash
npm install
```

```bash
cp .env.example .env
```

Open `.env` and fill in:

| Setting | What to put |
|---|---|
| `DB_USER` / `DB_PASSWORD` | A MySQL login that can create a database (root is fine on this laptop) |
| `DB_NAME` | Leave it as `gdg_arcade` |
| `ADMIN_PIN` | Any 4+ digits, used on the admin page |

Then start it:

```bash
npm start
```

On first start the server creates the `gdg_arcade` database and its tables for you.
If MySQL isn't reachable, the arcade still runs: a red banner says scores aren't saving, and it reconnects on its own once MySQL is back.

Run the tests (the database tests use a throwaway `gdg_arcade_test` database and delete it afterwards):

```bash
npm test
```

## Online demo on GitHub Pages

The demo is a static copy of the site with no server or database. Scores save in each visitor's browser, and the home page says so.

Try it locally:

```bash
npm run build:static
```

This writes the demo to `dist/`. Open it through any static file server (not by double-clicking the file).

**Publish it (one time):**

1. On GitHub, create a new **public** repository, e.g. `gdg-arcade`. Don't add a README.
2. In this project folder, push the code (your `.env` with the MySQL password is ignored and won't be uploaded):
   ```bash
   git init -b main
   git add .
   git commit -m "GDG club fair arcade"
   git remote add origin https://github.com/YOUR-USERNAME/gdg-arcade.git
   git push -u origin main
   ```
3. On GitHub: **Settings → Pages → Source: GitHub Actions**.
4. Open the **Actions** tab and wait for "Deploy demo to GitHub Pages" to finish (about a minute). Your link is `https://YOUR-USERNAME.github.io/gdg-arcade/`.

After that, every push to `main` runs the tests and republishes the demo automatically (`.github/workflows/pages.yml`).

## Fair-day checklist

1. Plug in the charger and turn on **Do Not Disturb**. Set the display to never sleep while plugged in.
2. `npm start` in the project folder.
3. Open Chrome in kiosk mode (full screen, no address bar):
   ```bash
   open -a "Google Chrome" --args --kiosk http://localhost:3000
   ```
   To quit kiosk mode, press `⌘Q`.
4. Before doors open, clear the test scores: go to `/admin` → **Reset everything** → type `RESET`.
5. If someone enters a rude name, open `/admin` in another tab and click **Hide player**.

**Walk-away reset:** after 45 seconds with no input on the home page or a game-over screen, the arcade clears the name and goes back to the name box, so the next student doesn't play under someone else's name. The **NEXT PLAYER** button does the same thing straight away.

## Party mode: TAP BATTLE and SNAKE BATTLE (4-player games, in progress)

Up to 4 students join on their phones by scanning a QR code on the big screen, and battle each other. **NEXT GAME** (bottom right of the big screen) picks the game:

- **TAP BATTLE:** every tap fills your bar, and it drains when you stop. First to fill it wins.
- **SNAKE BATTLE:** phones become trackpads (slide a finger to steer), and everyone watches one board on the big screen. Eat to grow. Crash into a wall, yourself or another snake and you're out, and your body turns into food. The last snake left wins.

A round can start with fewer than 4 phones, from the big screen's **START** or from the first phone that joined. While people play, the screen also checks the connection: each phone gets a card with a moving dot, its ping and a verdict. In TAP BATTLE each phone keeps its own bar and resends it until the laptop confirms it, so a reload or a dropped connection doesn't lose anyone's result. In SNAKE BATTLE the laptop runs the board, so the big screen never lags.

Install the free Cloudflare tunnel once (no account needed):

```bash
brew install cloudflared
```

Then start the test:

```bash
npm run party
```

Open **http://localhost:3101** on the big screen and scan the QR code with up to 4 phones. They can be on campus Wi-Fi or mobile data. The top verdict reads **READY FOR PARTY GAMES** once every phone is good: 95% of pings under 250ms, no more than 2 stutters a minute, and no missed pings.

| Command | Phones join through |
|---|---|
| `npm run party` | The internet (free Cloudflare link, changes every start) |
| `npm run party -- --lan` | The same Wi-Fi as the laptop (no tunnel) |
| `npm run party -- --local` | Nothing: open http://localhost:3100 in other tabs to try it alone |

Only the phone page is reachable from outside. The arcade, admin page and MySQL stay private. See [HANDOFF.md](HANDOFF.md) for the plan and what to test on campus. The games' numbers are at the top of `public/js/shared/tap-battle.js` (fill per tap, drain, time limit) and `public/js/shared/snake-battle.js` (speed, board size, food), and the fewest phones needed to start is `MIN_PLAYERS` in `server/party/round.js`.

## How scoring works

Every game starts gentle and speeds up slowly **up to a cap**, so anyone can score but the top spots take skill. Hitboxes are a bit smaller than the drawings, so near-misses feel fair.

| Game | Controls | Points | How hard it gets |
|---|---|---|---|
| **Dino Run** | `SPACE`/`↑` jump (hold for higher), `↓` duck | Distance: ~9 pts/s at the start, up to 18 pts/s at top speed | **Checkpoint every 100 points:** the run speeds up ("200! FASTER") until top speed at 1,200. Gaps widen as it speeds up, so there's always time to react. Flying flowers only appear after 400 points. |
| **Flappy Byte** | `SPACE` or click to flap | +10 per pipe, **+5 CLEAN** for flying through the middle of the gap | The bird hovers until your first flap. The ceiling doesn't kill you. The gap shrinks slowly from 180px to 140px. |
| **Snake** | Arrows or `WASD` | +10 per red food, **+30** for the yellow bonus (every 6 foods, gone after 6s) | **Hitting a wall or yourself ends the game.** It speeds up every 5 foods. Quick double-turns are buffered, and you can't reverse into yourself. |
| **Memory Match** | Click cards (or `TAB` + `SPACE`) | +100 per pair, **+50 extra for each pair in a row**, then +10 per second left under 90s | All cards are shown for 2 seconds at the start. There's a 120s limit. |
| **Stack Tower** | `SPACE` or click to drop | +10 per block, **+15 PERFECT** bonus when it lines up (within 6px) | **Checkpoint every 5 blocks:** the slider speeds up ("HEIGHT 10! FASTER") until top speed at 50 blocks. 3 perfects in a row makes your block wider again. |

**Leaderboards** show each player's **best** score per game. On a tie, whoever got there first ranks higher. The same name in any case (`Sara K` / `sara k`) counts as one player, so ask students to add a surname initial.

**Cheat protection:** the server starts a timed run when a game begins and only accepts one score per run. It rejects any score that is higher than the game allows, or that came in faster than is possible to earn.

## Project layout

```
server/        Express app, API, MySQL connection, score limits
db/schema.sql  Tables (applied automatically on start)
public/
  index.html   Home: name box + game library with live top 3
  play.html    Game page (loads public/js/games/<game>.js)
  admin.html   PIN-protected admin (fair laptop only)
  design-sheet.html
  css/         tokens.css, base.css, components.css (brand system), pages.css
  fonts/       Archivo (SIL Open Font License)
  js/config.js "server" or "static"; the demo build switches it
  js/api.js    Talks to the server, or to js/local-api.js (browser storage) in the demo
  js/shared/   Game list and name rules, used by both the server and the browser
  js/engine/   60Hz game loop, input, brand drawing helpers, game flow (shell.js)
  js/games/    dino, flappy, snake, memory, stack
server/party/  Party connection test server (room logic, phone + big-screen sockets, tunnel)
party/         Party test pages: phone.html, screen.html, their JS and CSS
scripts/       build-static.js builds the GitHub Pages demo into dist/
test/          node:test unit, API, demo-scores and party tests
```

To tune difficulty, change the constants at the top of each file in `public/js/games/`. If you change how many points a game can earn, update `maxScore`/`maxPerSec` in `server/games.js` to match.
