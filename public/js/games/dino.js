// DINO RUN: jump the red capsule cacti, duck the blue flowers.
// Score comes from distance. Every 100 points is a checkpoint where the run speeds up,
// so obstacles come faster and surviving pays more.
import { createLoop } from "../engine/loop.js";
import { C, createCanvas, paper, sticker, disc, flower, label, scoreHud, createPopups, overlaps, shrink, rand } from "../engine/draw.js";

const W = 960;
const H = 300;
const GROUND = 250;
const DINO_X = 90;

const START_SPEED = 6; // px per tick
const MAX_SPEED = 12;
const CHECKPOINT_POINTS = 100;
const SPEED_PER_CHECKPOINT = 0.5; // top speed at 1,200 points
const SPEED_EASE = 0.05; // settles into the new speed over about a second
const POINTS_PER_PX = 0.025; // 9 pts/s at start, 18 pts/s at top speed
const FLYERS_FROM = 400;

const JUMP_VELOCITY = -15;
const GRAVITY = 0.8;
const FAST_FALL_GRAVITY = 2.2;
const SHORT_HOP_VELOCITY = -6;
const HITBOX = 0.78;

export function checkpointAt(score) {
  return Math.floor(score / CHECKPOINT_POINTS);
}

export function speedAt(score) {
  return Math.min(MAX_SPEED, START_SPEED + checkpointAt(score) * SPEED_PER_CHECKPOINT);
}

export function mount(root, { onScore, onGameOver }) {
  const view = createCanvas(root, W, H, { maxHeightOffset: 300 });
  view.canvas.setAttribute("aria-label", "Dino Run game");
  const { ctx } = view;
  const popups = createPopups();

  const dino = { y: 0, vy: 0, ducking: false, jumpHeld: false, downHeld: false };
  let obstacles = [];
  let speed = START_SPEED;
  let score = 0;
  let shownScore = -1;
  let checkpoint = 0;
  let distance = 0;
  let nextSpawnAt = 700;
  let ticks = 0;
  let over = false;

  const onGround = () => dino.y >= 0;

  function dinoBox() {
    const h = dino.ducking ? 40 : 64;
    const w = dino.ducking ? 76 : 58;
    return shrink({ x: DINO_X, y: GROUND + dino.y - h, w, h }, HITBOX);
  }

  function spawn() {
    const x = W + 40;
    const roll = Math.random();
    if (score >= FLYERS_FROM && roll < 0.3) {
      const high = Math.random() < 0.5;
      obstacles.push({ kind: "flyer", x, y: GROUND - (high ? 72 : 30), r: 22, bob: rand(0, Math.PI * 2) });
    } else if (roll < 0.62) {
      obstacles.push({ kind: "cactus", x, w: 26, h: 50 });
    } else if (roll < 0.84) {
      obstacles.push({ kind: "cactus", x, w: 30, h: 70 });
    } else {
      obstacles.push({ kind: "cactus", x, w: 26, h: 50 });
      obstacles.push({ kind: "cactus", x: x + 36, w: 24, h: 38 });
    }
    // Gaps grow with speed so there's always time to react.
    const minGap = 360 + speed * 38;
    nextSpawnAt = distance + rand(minGap, minGap + 420);
  }

  function obstacleBox(o) {
    if (o.kind === "flyer") {
      const r = o.r * 0.8;
      return { x: o.x - r, y: o.y - r, w: r * 2, h: r * 2 };
    }
    return shrink({ x: o.x, y: GROUND - o.h, w: o.w, h: o.h }, 0.8);
  }

  function update() {
    ticks += 1;
    popups.update();
    if (over) return;

    distance += speed;
    score += speed * POINTS_PER_PX;
    speed += (speedAt(score) - speed) * SPEED_EASE;

    // Jumping and ducking
    dino.ducking = dino.downHeld && onGround();
    if (!onGround() || dino.vy < 0) {
      dino.vy += dino.downHeld ? FAST_FALL_GRAVITY : GRAVITY;
      dino.y += dino.vy;
      if (dino.y >= 0) {
        dino.y = 0;
        dino.vy = 0;
        if (dino.jumpHeld && !dino.downHeld) dino.vy = JUMP_VELOCITY;
      }
    }

    if (distance >= nextSpawnAt) spawn();
    for (const o of obstacles) {
      o.x -= speed;
      if (o.kind === "flyer") o.bob += 0.12;
    }
    obstacles = obstacles.filter((o) => o.x > -80);

    const me = dinoBox();
    if (obstacles.some((o) => overlaps(me, obstacleBox(o)))) {
      over = true;
      render();
      loop.stop();
      setTimeout(() => onGameOver(Math.floor(score)), 350);
      return;
    }

    const whole = Math.floor(score);
    if (whole !== shownScore) {
      shownScore = whole;
      onScore(whole);
    }
    if (checkpointAt(score) > checkpoint) {
      const faster = speedAt(score) > speedAt(score - CHECKPOINT_POINTS);
      checkpoint = checkpointAt(score);
      const points = checkpoint * CHECKPOINT_POINTS;
      popups.add(faster ? `${points}! FASTER` : `${points}!`, W - 110, 70, faster ? C.yellow : C.green);
    }
  }

  function drawDino() {
    const x = DINO_X;
    const y = GROUND + dino.y;
    const running = onGround() && !over && ticks > 0;
    const stride = running ? Math.floor(ticks / 6) % 2 : 0;
    ctx.lineJoin = "round";

    if (dino.ducking) {
      tri(x + 4, y - 24, x - 14, y - 32, x + 6, y - 12);
      sticker(ctx, x + 12, y - 12, 10, 12 - stride * 4, 5, C.green);
      sticker(ctx, x + 32, y - 12, 10, 8 + stride * 4, 5, C.green);
      sticker(ctx, x, y - 34, 54, 26, 12, C.green);
      sticker(ctx, x + 42, y - 42, 34, 26, 10, C.green);
      eye(x + 66, y - 32);
      return;
    }

    tri(x + 4, y - 36, x - 16, y - 50, x + 8, y - 26);
    sticker(ctx, x + 12, y - 24, 10, 24 - stride * 6, 5, C.green);
    sticker(ctx, x + 30, y - 24, 10, 18 + stride * 6, 5, C.green);
    sticker(ctx, x, y - 48, 42, 32, 13, C.green);
    sticker(ctx, x + 22, y - 66, 36, 28, 11, C.green);
    eye(x + 48, y - 55);
  }

  function tri(x1, y1, x2, y2, x3, y3) {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.lineTo(x3, y3);
    ctx.closePath();
    ctx.fillStyle = C.green;
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = C.ink;
    ctx.stroke();
  }

  function eye(x, y) {
    if (over) {
      ctx.beginPath();
      ctx.moveTo(x - 4, y - 4);
      ctx.lineTo(x + 4, y + 4);
      ctx.moveTo(x + 4, y - 4);
      ctx.lineTo(x - 4, y + 4);
      ctx.lineWidth = 3;
      ctx.strokeStyle = C.ink;
      ctx.stroke();
    } else {
      disc(ctx, x, y, 3.5, C.ink, { stroke: 0 });
    }
  }

  function render() {
    paper(ctx, W, H, { offsetX: distance * 0.5 });

    // Ground line with passing dashes for a sense of speed
    ctx.fillStyle = C.ink;
    ctx.fillRect(0, GROUND - 1.5, W, 3);
    const dashOffset = distance % 90;
    for (let x = -dashOffset; x < W; x += 90) {
      ctx.fillRect(x + 20, GROUND + 14, 18, 3);
      ctx.fillRect(x + 62, GROUND + 26, 8, 3);
    }

    for (const o of obstacles) {
      if (o.kind === "flyer") {
        flower(ctx, o.x, o.y + Math.sin(o.bob) * 4, o.r, C.blue, o.bob * 0.4);
      } else {
        sticker(ctx, o.x, GROUND - o.h, o.w, o.h + 2, o.w / 2, C.red);
      }
    }

    drawDino();
    scoreHud(ctx, Math.floor(score), W - 24, 20);
    if (ticks === 0) {
      label(ctx, "SPACE = JUMP   ↓ = DUCK", 24, 28, { size: 16, weight: 700, baseline: "top" });
    } else {
      const level = speedAt(score) >= MAX_SPEED ? "TOP SPEED" : `LEVEL ${checkpointAt(score) + 1}`;
      label(ctx, level, 24, 28, { size: 16, weight: 800, baseline: "top" });
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
      if (over) return;
      if (action === "primary" || action === "up") {
        dino.jumpHeld = pressed;
        if (pressed && onGround() && !dino.downHeld) dino.vy = JUMP_VELOCITY;
        if (!pressed && dino.vy < SHORT_HOP_VELOCITY) dino.vy = SHORT_HOP_VELOCITY;
      } else if (action === "down") {
        dino.downHeld = pressed;
      }
    },
    get ticks() {
      return loop.ticks;
    },
    get speed() {
      return speed;
    },
    destroy() {
      loop.destroy();
      view.destroy();
    },
  };
}
