// The lobby's PREVIEW: the next game playing itself, so people walking past see what it is.
// SNAKE ROYALE runs the real rules with four bots on the real board renderer; MASH BATTLE
// races four bars. Nothing here talks to the server.
import { COLS, DIRECTIONS, ROWS, createArena } from "../../js/shared/snake-battle.js";
import { createSnakeBoard } from "./snake-board.js";

const SLOT_COLORS = ["red", "blue", "yellow", "green"];
const SLOT_NAMES = ["RED", "BLUE", "YELLOW", "GREEN"];
const SNAKE_STEP_MS = 120;
const SNAKE_MAX_STEPS = 420; // a demo round that goes on this long starts over
const TAP_TICK_MS = 100;
const RESTART_MS = 1600;
const LEFT = { up: "left", left: "down", down: "right", right: "up" };
const RIGHT = { up: "right", right: "down", down: "left", left: "up" };

const stillMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---------- SNAKE ROYALE ----------
function snakeDemo(root) {
  const holder = document.createElement("div");
  holder.className = "demo__board";
  root.append(holder);
  const board = createSnakeBoard(holder);
  board.setNames([0, 1, 2, 3].map((slot) => ({ slot, name: SLOT_NAMES[slot] })));

  let arena = null;
  let round = 0;
  let steps = 0;
  let restartAt = 0;

  function reset() {
    round += 1;
    steps = 0;
    restartAt = 0;
    arena = createArena([0, 1, 2, 3]);
    show();
  }

  function show() {
    board.setFrame({ round, step: steps, cols: COLS, rows: ROWS, snakes: arena.snakes(), food: arena.food() });
  }

  // Each bot looks one cell ahead: it avoids walls and bodies, prefers the nearest food,
  // and now and then wanders (or slips up), so rounds end and look like people playing.
  function think() {
    const snakes = arena.snakes();
    const taken = new Set();
    for (const s of snakes) for (let i = 0; i < s.body.length; i += 2) taken.add(s.body[i + 1] * COLS + s.body[i]);
    const food = arena.food();
    const free = (x, y) => x >= 0 && x < COLS && y >= 0 && y < ROWS && !taken.has(y * COLS + x);
    const room = (x, y) =>
      Object.values(DIRECTIONS).filter((d) => free(x + d.x, y + d.y)).length;

    for (const s of snakes) {
      if (!s.alive) continue;
      const hx = s.body[0];
      const hy = s.body[1];
      const options = [s.dir, LEFT[s.dir], RIGHT[s.dir]].map((dir) => {
        const d = DIRECTIONS[dir];
        const x = hx + d.x;
        const y = hy + d.y;
        let best = Infinity;
        for (let i = 0; i < food.length; i += 3) best = Math.min(best, Math.abs(food[i] - x) + Math.abs(food[i + 1] - y));
        return { dir, safe: free(x, y), room: free(x, y) ? room(x, y) : 0, dist: best };
      });
      const safe = options.filter((o) => o.safe && o.room > 0);
      let pick;
      if (safe.length === 0 || Math.random() < 0.012) pick = options[Math.floor(Math.random() * options.length)];
      else if (Math.random() < 0.15) pick = safe[Math.floor(Math.random() * safe.length)];
      else pick = safe.sort((a, b) => a.dist - b.dist || b.room - a.room)[0];
      if (pick.dir !== s.dir) arena.turn(s.slot, pick.dir);
    }
  }

  function tick(now) {
    if (restartAt) {
      if (now >= restartAt) reset();
      return;
    }
    think();
    arena.step();
    steps += 1;
    show();
    if (arena.alive <= 1 || steps >= SNAKE_MAX_STEPS) restartAt = now + RESTART_MS;
  }

  reset();
  return {
    stepMs: SNAKE_STEP_MS,
    tick,
    // A still frame a few seconds in, for reduced motion.
    still() {
      reset();
      for (let i = 0; i < 24; i += 1) {
        think();
        arena.step();
      }
      steps = 24;
      show();
    },
    shown: () => board.refit(),
    remove: () => holder.remove(),
  };
}

// ---------- MASH BATTLE ----------
function tapDemo(root) {
  const lanes = document.createElement("div");
  lanes.className = "demo__lanes";
  const bots = SLOT_COLORS.map((color, slot) => {
    const col = document.createElement("div");
    col.className = "battle-col";
    col.dataset.color = color;
    col.innerHTML =
      '<p class="badge battle-col__badge" hidden>FULL!</p>' +
      '<div class="battle-col__track"><div class="battle-col__fill"></div></div>' +
      `<p class="battle-col__name">${SLOT_NAMES[slot]}</p>`;
    lanes.append(col);
    return { col, level: 0, speed: 0 };
  });
  root.append(lanes);

  let restartAt = 0;

  function reset() {
    restartAt = 0;
    for (const bot of bots) {
      bot.level = 0;
      bot.speed = 2.2 + Math.random() * 1.6;
      draw(bot, false);
    }
  }

  function draw(bot, full) {
    bot.col.style.setProperty("--level", full ? 100 : bot.level);
    bot.col.classList.toggle("is-full", full);
    const badge = bot.col.querySelector(".battle-col__badge");
    if (full && badge.hidden) {
      badge.hidden = false;
      badge.classList.remove("pop-in");
      void badge.offsetWidth;
      badge.classList.add("pop-in");
    } else if (!full) {
      badge.hidden = true;
    }
  }

  function tick(now) {
    if (restartAt) {
      if (now >= restartAt) reset();
      return;
    }
    for (const bot of bots) {
      // Bursts of tapping with short pauses, and the bar always drains a little.
      const tapping = Math.random() < 0.8;
      bot.level = Math.max(0, Math.min(100, bot.level + (tapping ? bot.speed * (0.6 + Math.random()) : 0) - 0.6));
    }
    const winner = bots.find((bot) => bot.level >= 100);
    for (const bot of bots) draw(bot, bot === winner);
    if (winner) restartAt = now + RESTART_MS;
  }

  reset();
  return {
    stepMs: TAP_TICK_MS,
    tick,
    still() {
      [72, 94, 58, 81].forEach((level, i) => {
        bots[i].level = level;
        draw(bots[i], false);
      });
    },
    shown() {},
    remove: () => lanes.remove(),
  };
}

// ---------- The preview ----------
export function createLobbyDemo(root) {
  const makers = { snake: snakeDemo, tap: tapDemo };
  let game = null;
  let demo = null;
  let active = false;
  let timer = 0;

  function run() {
    clearInterval(timer);
    timer = 0;
    if (!demo || !active || document.hidden) return;
    if (stillMotion()) {
      demo.still();
      return;
    }
    demo.shown();
    timer = setInterval(() => demo.tick(performance.now()), demo.stepMs);
  }

  document.addEventListener("visibilitychange", run);

  return {
    setGame(next) {
      if (next === game || !makers[next]) return;
      game = next;
      demo?.remove();
      root.dataset.game = next;
      demo = makers[next](root);
      run();
    },
    // Only animates while the lobby is on screen.
    setActive(on) {
      if (on === active) return;
      active = on;
      run();
    },
  };
}
