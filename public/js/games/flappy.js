// FLAPPY BYTE: flap a yellow dot through green pipes.
// +10 per pipe, +5 more for flying through the middle of the gap.
import { createLoop } from "../engine/loop.js";
import { C, createCanvas, paper, sticker, disc, label, scoreHud, createPopups, rand } from "../engine/draw.js";

const W = 480;
const H = 640;
const GROUND = 570;
const BIRD_X = 140;
const BIRD_R = 19;
const HIT_R = 14;

const GRAVITY = 0.35;
const FLAP_VELOCITY = -6.6;
const MAX_FALL = 9;

const PIPE_W = 74;
const PIPE_SPACING = 250;
const START_GAP = 180;
const MIN_GAP = 140;
const GAP_SHRINK = 5; // every 5 pipes
const START_SPEED = 2.6;
const MAX_SPEED = 3.4;
const SPEED_STEP = 0.2; // every 10 pipes
const MAX_GAP_JUMP = 140;

const POINTS_PER_PIPE = 10;
const CLEAN_BONUS = 5;
const CLEAN_ZONE = 0.2; // within 20% of the gap height from its centre

export function mount(root, { onScore, onGameOver }) {
  const view = createCanvas(root, W, H, { maxHeightOffset: 340 });
  view.canvas.setAttribute("aria-label", "Flappy Byte game");
  const { ctx } = view;
  const popups = createPopups();

  const bird = { y: 280, vy: 0, wing: 0 };
  let pipes = [];
  let flapped = false;
  let passedCount = 0;
  let score = 0;
  let distance = 0;
  let ticks = 0;
  let over = false;
  let lastGapY = 300;

  const speed = () => Math.min(MAX_SPEED, START_SPEED + Math.floor(passedCount / 10) * SPEED_STEP);
  const gapSize = () => Math.max(MIN_GAP, START_GAP - Math.floor(passedCount / 5) * GAP_SHRINK);

  function addPipe(x) {
    const gap = gapSize();
    const min = 60 + gap / 2;
    const max = GROUND - 60 - gap / 2;
    const y = Math.max(min, Math.min(max, lastGapY + rand(-MAX_GAP_JUMP, MAX_GAP_JUMP)));
    lastGapY = y;
    pipes.push({ x, gapY: y, gap, passed: false });
  }

  function crash() {
    over = true;
    render();
    loop.stop();
    setTimeout(() => onGameOver(score), 450);
  }

  function update() {
    ticks += 1;
    popups.update();
    if (over) return;

    if (!flapped) {
      // Hover in place until the first flap.
      bird.y = 280 + Math.sin(ticks / 12) * 8;
      return;
    }

    bird.vy = Math.min(MAX_FALL, bird.vy + GRAVITY);
    bird.y += bird.vy;
    if (bird.wing > 0) bird.wing -= 1;

    // The ceiling blocks instead of killing.
    if (bird.y < BIRD_R) {
      bird.y = BIRD_R;
      bird.vy = 0;
    }

    const s = speed();
    distance += s;
    for (const p of pipes) p.x -= s;
    pipes = pipes.filter((p) => p.x > -PIPE_W - 20);
    const last = pipes[pipes.length - 1];
    if (!last) addPipe(W + 60);
    else if (last.x < W - PIPE_SPACING) addPipe(last.x + PIPE_SPACING);

    for (const p of pipes) {
      if (!p.passed && p.x + PIPE_W < BIRD_X - HIT_R) {
        p.passed = true;
        passedCount += 1;
        const clean = Math.abs(bird.y - p.gapY) <= p.gap * CLEAN_ZONE;
        const points = POINTS_PER_PIPE + (clean ? CLEAN_BONUS : 0);
        score += points;
        onScore(score);
        popups.add(clean ? `+${points} CLEAN` : `+${points}`, BIRD_X + 10, bird.y - 46, clean ? C.green : C.yellow);
      }
    }

    if (bird.y + HIT_R >= GROUND) {
      bird.y = GROUND - HIT_R;
      crash();
      return;
    }

    for (const p of pipes) {
      const withinX = BIRD_X + HIT_R > p.x && BIRD_X - HIT_R < p.x + PIPE_W;
      if (!withinX) continue;
      const top = p.gapY - p.gap / 2;
      const bottom = p.gapY + p.gap / 2;
      if (bird.y - HIT_R < top || bird.y + HIT_R > bottom) {
        crash();
        return;
      }
    }
  }

  function drawPipe(p) {
    const top = p.gapY - p.gap / 2;
    const bottom = p.gapY + p.gap / 2;
    const lipH = 26;
    const lipOut = 7;
    sticker(ctx, p.x, -30, PIPE_W, top + 30, 16, C.green);
    sticker(ctx, p.x - lipOut, top - lipH, PIPE_W + lipOut * 2, lipH, 12, C.green);
    sticker(ctx, p.x, bottom, PIPE_W, GROUND - bottom + 30, 16, C.green);
    sticker(ctx, p.x - lipOut, bottom, PIPE_W + lipOut * 2, lipH, 12, C.green);
  }

  function drawBird() {
    const tilt = flapped ? Math.max(-0.45, Math.min(1.1, bird.vy * 0.08)) : 0;
    ctx.save();
    ctx.translate(BIRD_X, bird.y);
    ctx.rotate(tilt);
    ctx.lineJoin = "round";

    // Beak
    ctx.beginPath();
    ctx.moveTo(BIRD_R - 3, -4);
    ctx.lineTo(BIRD_R + 13, 2);
    ctx.lineTo(BIRD_R - 3, 9);
    ctx.closePath();
    ctx.fillStyle = C.red;
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = C.ink;
    ctx.stroke();

    disc(ctx, 0, 0, BIRD_R, C.yellow);

    // Wing flicks up right after a flap
    ctx.beginPath();
    ctx.ellipse(-7, bird.wing > 0 ? 0 : 6, 10, bird.wing > 0 ? 5 : 7, bird.wing > 0 ? -0.5 : 0.2, 0, Math.PI * 2);
    ctx.fillStyle = C.paper;
    ctx.fill();
    ctx.stroke();

    // Eye
    disc(ctx, 7, -7, 6.5, C.paper);
    if (over) {
      ctx.beginPath();
      ctx.moveTo(5, -9);
      ctx.lineTo(10, -4);
      ctx.moveTo(10, -9);
      ctx.lineTo(5, -4);
      ctx.lineWidth = 2.5;
      ctx.stroke();
    } else {
      disc(ctx, 9, -7, 2.6, C.ink, { stroke: 0 });
    }
    ctx.restore();
  }

  function render() {
    paper(ctx, W, H, { offsetX: distance * 0.4 });
    for (const p of pipes) drawPipe(p);

    // Ground band
    ctx.fillStyle = C.paper;
    ctx.fillRect(0, GROUND, W, H - GROUND);
    ctx.fillStyle = C.ink;
    ctx.fillRect(0, GROUND - 1.5, W, 3);
    const dash = distance % 60;
    for (let x = -dash; x < W; x += 60) {
      ctx.fillRect(x + 10, GROUND + 18, 22, 3);
      ctx.fillRect(x + 42, GROUND + 34, 8, 3);
    }

    drawBird();
    scoreHud(ctx, score, W - 22, 18, { size: 40 });
    if (!flapped && !over) {
      label(ctx, "SPACE OR CLICK TO FLAP", W / 2, 400, { size: 18, weight: 800, align: "center" });
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
      if (action !== "primary" && action !== "up") return;
      flapped = true;
      bird.vy = FLAP_VELOCITY;
      bird.wing = 8;
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
