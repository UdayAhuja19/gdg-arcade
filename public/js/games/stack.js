// STACK TOWER: drop the sliding block onto the tower. Overhangs get cut off.
// +10 per block, +15 more for a PERFECT drop; 3 perfects in a row widen the block again.
// Every 5 blocks is a checkpoint where the slider speeds up.
import { createLoop } from "../engine/loop.js";
import { C, BRAND_CYCLE, createCanvas, paper, sticker, label, scoreHud, createPopups } from "../engine/draw.js";

const W = 480;
const H = 640;
const BLOCK_H = 30;
const BASE_W = 250;
const BASE_Y = H - 70;
const TOWER_VIEW_Y = 300; // the top block settles around here once the camera scrolls

const START_SPEED = 3; // px per tick
const MAX_SPEED = 7;
const CHECKPOINT_BLOCKS = 5;
const SPEED_PER_CHECKPOINT = 0.4; // top speed at 50 blocks
const PERFECT_PX = 6;
const REGROW_PX = 12;
const REGROW_EVERY = 3;
const BLOCK_POINTS = 10;
const PERFECT_BONUS = 15;
const DROP_COOLDOWN_TICKS = 15;

export function speedAt(level) {
  return Math.min(MAX_SPEED, START_SPEED + Math.floor(level / CHECKPOINT_BLOCKS) * SPEED_PER_CHECKPOINT);
}

export function mount(root, { onScore, onGameOver }) {
  const view = createCanvas(root, W, H, { maxHeightOffset: 340 });
  view.canvas.setAttribute("aria-label", "Stack Tower game");
  const { ctx } = view;
  const popups = createPopups();

  // tower[0] is the base; each placed block sits BLOCK_H above the one below.
  const tower = [{ x: (W - BASE_W) / 2, w: BASE_W, color: C.ink }];
  let moving = null;
  let debris = [];
  let score = 0;
  let perfectRun = 0;
  let cooldown = 0;
  let camera = 0;
  let ticks = 0;
  let over = false;
  let started = false;

  const level = () => tower.length - 1;
  const speed = () => speedAt(level());
  const blockY = (i) => BASE_Y - i * BLOCK_H;

  function spawn() {
    const top = tower[tower.length - 1];
    const fromLeft = tower.length % 2 === 1;
    moving = {
      x: fromLeft ? -top.w * 0.6 : W - top.w * 0.4,
      w: top.w,
      dir: fromLeft ? 1 : -1,
      color: BRAND_CYCLE[(tower.length - 1) % BRAND_CYCLE.length],
    };
  }

  function drop() {
    if (!moving || cooldown > 0 || over) return;
    const top = tower[tower.length - 1];
    const y = blockY(tower.length);
    let { x, w } = moving;
    const offset = x - top.x;

    if (Math.abs(offset) <= PERFECT_PX) {
      x = top.x;
      perfectRun += 1;
      const points = BLOCK_POINTS + PERFECT_BONUS;
      if (perfectRun % REGROW_EVERY === 0 && w < BASE_W) {
        const grow = Math.min(REGROW_PX, BASE_W - w);
        x -= grow / 2;
        w += grow;
      }
      score += points;
      popups.add(`PERFECT +${points}`, x + w / 2, y - camera - 20, C.green);
    } else {
      const overlap = w - Math.abs(offset);
      if (overlap <= 0) {
        // Missed the tower completely.
        debris.push({ x, y, w, vy: 0, spin: 0, color: moving.color });
        moving = null;
        over = true;
        setTimeout(() => onGameOver(score), 750);
        return;
      }
      const cut = { y, w: w - overlap, vy: 0, spin: 0, color: moving.color };
      // Keep the part over the tower; the overhang on either side falls away.
      if (offset > 0) {
        cut.x = top.x + top.w;
      } else {
        cut.x = x;
        x = top.x;
      }
      w = overlap;
      debris.push(cut);
      perfectRun = 0;
      score += BLOCK_POINTS;
      popups.add(`+${BLOCK_POINTS}`, x + w / 2, y - camera - 20, C.yellow);
    }

    tower.push({ x, w, color: moving.color });
    onScore(score);
    // The speed-up applies from the next block, so it never jumps mid-swing.
    if (speedAt(level()) > speedAt(level() - 1)) {
      popups.add(`HEIGHT ${level()}! FASTER`, W / 2, 110, C.blue);
    }
    cooldown = DROP_COOLDOWN_TICKS;
    spawn();
  }

  function update() {
    ticks += 1;
    popups.update();

    for (const d of debris) {
      d.vy += 0.6;
      d.y += d.vy;
      d.spin += 0.05;
    }
    debris = debris.filter((d) => d.y - camera < H + 200);

    const targetCamera = Math.min(0, blockY(tower.length) - TOWER_VIEW_Y);
    camera += (targetCamera - camera) * 0.1;

    if (over) {
      if (!debris.length) loop.stop();
      return;
    }
    if (cooldown > 0) cooldown -= 1;
    if (moving) {
      moving.x += moving.dir * speed();
      const min = -moving.w * 0.6;
      const max = W - moving.w * 0.4;
      if (moving.x < min) {
        moving.x = min;
        moving.dir = 1;
      } else if (moving.x > max) {
        moving.x = max;
        moving.dir = -1;
      }
    }
  }

  function render() {
    paper(ctx, W, H, { size: 24, offsetY: -camera * 0.5 });

    ctx.save();
    ctx.translate(0, -camera);

    // Base plinth under the tower
    sticker(ctx, tower[0].x - 30, BASE_Y + BLOCK_H, tower[0].w + 60, 400, 14, C.paper);

    for (let i = 0; i < tower.length; i += 1) {
      const b = tower[i];
      sticker(ctx, b.x, blockY(i), b.w, BLOCK_H - 2, (BLOCK_H - 2) / 2, b.color, { shadow: 3 });
    }
    if (moving && !over) {
      sticker(ctx, moving.x, blockY(tower.length), moving.w, BLOCK_H - 2, (BLOCK_H - 2) / 2, moving.color, { shadow: 3 });
    }
    for (const d of debris) {
      ctx.save();
      ctx.translate(d.x + d.w / 2, d.y + BLOCK_H / 2);
      ctx.rotate(d.spin);
      sticker(ctx, -d.w / 2, -BLOCK_H / 2, d.w, BLOCK_H - 2, Math.min(d.w, BLOCK_H - 2) / 2, d.color);
      ctx.restore();
    }
    ctx.restore();

    label(ctx, `HEIGHT ${level()}`, 20, 22, { size: 18, weight: 800, baseline: "top" });
    if (perfectRun >= 2 && !over) {
      label(ctx, `PERFECT x${perfectRun}`, 20, 46, { size: 16, weight: 800, baseline: "top", color: C.green });
    }
    scoreHud(ctx, score, W - 20, 16, { size: 40 });
    if (!started) {
      label(ctx, "SPACE OR CLICK TO DROP", W / 2, H - 22, { size: 18, weight: 800, align: "center" });
    }
    popups.draw(ctx);
  }

  spawn();
  const loop = createLoop({ update, render });
  view.redraw = render;
  render();

  return {
    start() {
      loop.start();
    },
    input(action, pressed, repeat) {
      if (!pressed || repeat || action !== "primary") return;
      started = true;
      drop();
    },
    get ticks() {
      return loop.ticks;
    },
    get speed() {
      return speed();
    },
    destroy() {
      loop.destroy();
      view.destroy();
    },
  };
}
