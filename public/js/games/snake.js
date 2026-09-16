// SNAKE: hitting a wall or your own body ends the game.
// +10 per red food, +30 for the yellow bonus that appears every 6 foods.
import { createLoop, TICK_HZ } from "../engine/loop.js";
import { C, createCanvas, paper, disc, blob, label, scoreHud, createPopups } from "../engine/draw.js";

const COLS = 20;
const ROWS = 20;
const CELL = 28;
const HUD = 56;
const W = COLS * CELL;
const H = ROWS * CELL + HUD;

const START_SPEED = 7; // steps per second
const MAX_SPEED = 13;
const SPEED_STEP = 0.5; // every 5 foods
const FOOD_POINTS = 10;
const BONUS_POINTS = 30;
const BONUS_EVERY = 6;
const BONUS_TICKS = 6 * TICK_HZ;
const MAX_QUEUED_TURNS = 2;

const DIRS = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

export function mount(root, { onScore, onGameOver }) {
  const view = createCanvas(root, W, H, { maxHeightOffset: 340 });
  view.canvas.setAttribute("aria-label", "Snake game");
  const { ctx } = view;
  const popups = createPopups();

  const cy = Math.floor(ROWS / 2);
  let snake = [
    { x: 7, y: cy },
    { x: 6, y: cy },
    { x: 5, y: cy },
    { x: 4, y: cy },
  ];
  let dir = DIRS.right;
  const queue = [];
  let food = null;
  let bonus = null;
  let foods = 0;
  let score = 0;
  let stepAcc = 0;
  let ticks = 0;
  let over = false;

  const speed = () => Math.min(MAX_SPEED, START_SPEED + Math.floor(foods / 5) * SPEED_STEP);
  const occupied = (x, y) => snake.some((s) => s.x === x && s.y === y);

  function emptyCell() {
    const free = [];
    for (let y = 0; y < ROWS; y += 1) {
      for (let x = 0; x < COLS; x += 1) {
        if (!occupied(x, y) && !(food && food.x === x && food.y === y) && !(bonus && bonus.x === x && bonus.y === y)) {
          free.push({ x, y });
        }
      }
    }
    return free.length ? free[Math.floor(Math.random() * free.length)] : null;
  }

  food = emptyCell();

  function step() {
    if (queue.length) dir = queue.shift();
    const head = snake[0];
    const next = { x: head.x + dir.x, y: head.y + dir.y };

    const eatsFood = food && next.x === food.x && next.y === food.y;
    const eatsBonus = bonus && next.x === bonus.x && next.y === bonus.y;

    const hitsWall = next.x < 0 || next.x >= COLS || next.y < 0 || next.y >= ROWS;
    // The tail moves out of the way this step unless the snake is growing.
    const body = eatsFood ? snake : snake.slice(0, -1);
    if (hitsWall || body.some((s) => s.x === next.x && s.y === next.y)) {
      over = true;
      render();
      loop.stop();
      setTimeout(() => onGameOver(score), 450);
      return;
    }

    snake.unshift(next);
    if (!eatsFood) snake.pop();

    const px = next.x * CELL + CELL / 2;
    const py = HUD + next.y * CELL;
    if (eatsFood) {
      foods += 1;
      score += FOOD_POINTS;
      onScore(score);
      popups.add(`+${FOOD_POINTS}`, px, py - 10, C.yellow);
      food = emptyCell();
      if (foods % BONUS_EVERY === 0 && !bonus) {
        const cell = emptyCell();
        if (cell) bonus = { ...cell, ttl: BONUS_TICKS };
      }
      if (!food) {
        // Board full: nothing left to eat.
        over = true;
        loop.stop();
        setTimeout(() => onGameOver(score), 450);
      }
    }
    if (eatsBonus) {
      score += BONUS_POINTS;
      onScore(score);
      popups.add(`+${BONUS_POINTS} BONUS`, px, py - 10, C.green);
      bonus = null;
    }
  }

  function update() {
    ticks += 1;
    popups.update();
    if (over) return;
    if (bonus) {
      bonus.ttl -= 1;
      if (bonus.ttl <= 0) bonus = null;
    }
    stepAcc += speed() / TICK_HZ;
    while (stepAcc >= 1 && !over) {
      stepAcc -= 1;
      step();
    }
  }

  function cellCenter(c) {
    return { x: c.x * CELL + CELL / 2, y: HUD + c.y * CELL + CELL / 2 };
  }

  // Draws the body as one outlined tube: an ink pass, then a blue pass on top.
  function drawSnake() {
    const passes = [
      { color: C.ink, size: CELL - 2 },
      { color: C.blue, size: CELL - 8 },
    ];
    for (const { color, size } of passes) {
      ctx.fillStyle = color;
      for (let i = 0; i < snake.length; i += 1) {
        const a = cellCenter(snake[i]);
        ctx.beginPath();
        ctx.roundRect(a.x - size / 2, a.y - size / 2, size, size, size * 0.38);
        ctx.fill();
        const b = snake[i + 1] && cellCenter(snake[i + 1]);
        if (b) {
          const x = Math.min(a.x, b.x) - (a.x === b.x ? size / 2 : 0);
          const y = Math.min(a.y, b.y) - (a.y === b.y ? size / 2 : 0);
          const w = a.x === b.x ? size : CELL;
          const h = a.y === b.y ? size : CELL;
          ctx.fillRect(x, y, w, h);
        }
      }
    }

    // Eyes look where the snake is heading.
    const head = cellCenter(snake[0]);
    const side = { x: -dir.y, y: dir.x };
    for (const s of [-1, 1]) {
      const ex = head.x + dir.x * 4 + side.x * 6 * s;
      const ey = head.y + dir.y * 4 + side.y * 6 * s;
      if (over) {
        ctx.strokeStyle = C.ink;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(ex - 3, ey - 3);
        ctx.lineTo(ex + 3, ey + 3);
        ctx.moveTo(ex + 3, ey - 3);
        ctx.lineTo(ex - 3, ey + 3);
        ctx.stroke();
      } else {
        disc(ctx, ex, ey, 4, C.paper, { stroke: 2 });
        disc(ctx, ex + dir.x * 1.5, ey + dir.y * 1.5, 1.8, C.ink, { stroke: 0 });
      }
    }
  }

  function render() {
    ctx.fillStyle = C.paper;
    ctx.fillRect(0, 0, W, H);
    ctx.save();
    ctx.translate(0, HUD);
    paper(ctx, W, ROWS * CELL, { size: CELL });
    ctx.restore();
    // Solid walls around the board: touching one ends the game.
    ctx.strokeStyle = C.ink;
    ctx.lineWidth = 6;
    ctx.strokeRect(3, HUD + 3, W - 6, ROWS * CELL - 6);

    if (food) {
      const f = cellCenter(food);
      const pulse = 1 + Math.sin(ticks / 8) * 0.06;
      disc(ctx, f.x, f.y, 9 * pulse, C.red);
    }
    if (bonus) {
      const b = cellCenter(bonus);
      // A shrinking ring shows how long the bonus has left.
      ctx.beginPath();
      ctx.arc(b.x, b.y, 18, -Math.PI / 2, -Math.PI / 2 + (bonus.ttl / BONUS_TICKS) * Math.PI * 2);
      ctx.strokeStyle = C.ink;
      ctx.lineWidth = 3;
      ctx.stroke();
      blob(ctx, b.x, b.y, 14, C.yellow, ticks / 20);
    }

    drawSnake();

    label(ctx, `LENGTH ${snake.length}`, 18, HUD / 2 + 1, { size: 18, weight: 800, baseline: "middle" });
    scoreHud(ctx, score, W - 18, 12, { size: 34 });
    if (ticks === 0) {
      label(ctx, "ARROWS OR WASD TO TURN. DON'T HIT THE WALLS.", W / 2, HUD + ROWS * CELL - 30, { size: 16, weight: 800, align: "center" });
    }
    popups.draw(ctx);
  }

  const loop = createLoop({ update, render });
  view.redraw = render;
  render();

  return {
    start() {
      loop.start();
    },
    input(action, pressed) {
      if (over || !pressed) return;
      const next = DIRS[action];
      if (!next) return;
      // Compare with the last queued turn so fast double-taps work and reversing is ignored.
      const last = queue.length ? queue[queue.length - 1] : dir;
      if (next === last || (next.x === -last.x && next.y === -last.y)) return;
      if (queue.length < MAX_QUEUED_TURNS) queue.push(next);
    },
    get ticks() {
      return loop.ticks;
    },
    destroy() {
      loop.destroy();
      view.destroy();
    },
  };
}
