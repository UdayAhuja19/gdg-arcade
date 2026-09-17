// The SNAKE BATTLE board on the big screen: graph paper, food, and one outlined snake per
// player in their colour. It only draws what the server sends (an `arena` frame per step).
import { C, disc, label, paper, sticker } from "../../js/engine/draw.js";

const CRASH_SHOWN_MS = 1000;
const COLOR_NAMES = { red: "RED", blue: "BLUE", yellow: "YELLOW", green: "GREEN" };
const SLOT_COLORS = ["red", "blue", "yellow", "green"];
const DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

// The canvas's CSS border and hard shadow sit outside the drawing.
const FRAME_X = 6;
const FRAME_Y = 12;

export function createSnakeBoard(root) {
  const canvas = document.createElement("canvas");
  canvas.className = "snake__canvas";
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", "Snake battle board");
  root.append(canvas);
  const ctx = canvas.getContext("2d");

  let frame = null;
  let names = new Map(); // slot -> name
  let tags = false;
  let cell = 0;
  let crashes = []; // { x, y, slot, until }
  let crashTimer = 0;

  function fit() {
    if (!frame) return;
    const size = Math.floor(Math.min((root.clientWidth - FRAME_X) / frame.cols, (root.clientHeight - FRAME_Y) / frame.rows));
    if (size < 4) return;
    cell = size;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = cell * frame.cols;
    const h = cell * frame.rows;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }

  const center = (x, y) => ({ x: x * cell + cell / 2, y: y * cell + cell / 2 });

  // One outlined tube: an ink pass, then the colour on top (like the arcade's Snake).
  function drawSnake(snake) {
    const color = C[SLOT_COLORS[snake.slot]];
    const body = snake.body;
    const count = body.length / 2;
    const passes = [
      { fill: C.ink, size: cell - 2 },
      { fill: color, size: Math.max(2, cell - 8) },
    ];
    for (const { fill, size } of passes) {
      ctx.fillStyle = fill;
      for (let i = 0; i < count; i += 1) {
        const a = center(body[i * 2], body[i * 2 + 1]);
        ctx.beginPath();
        ctx.roundRect(a.x - size / 2, a.y - size / 2, size, size, size * 0.38);
        ctx.fill();
        if (i + 1 < count) {
          const b = center(body[(i + 1) * 2], body[(i + 1) * 2 + 1]);
          const x = Math.min(a.x, b.x) - (a.x === b.x ? size / 2 : 0);
          const y = Math.min(a.y, b.y) - (a.y === b.y ? size / 2 : 0);
          ctx.fillRect(x, y, a.x === b.x ? size : cell, a.y === b.y ? size : cell);
        }
      }
    }

    // Eyes look where the snake is heading.
    const k = cell / 28;
    const [dx, dy] = DIRS[snake.dir] ?? DIRS.right;
    const head = center(body[0], body[1]);
    for (const s of [-1, 1]) {
      const ex = head.x + dx * 4 * k + -dy * 6 * k * s;
      const ey = head.y + dy * 4 * k + dx * 6 * k * s;
      disc(ctx, ex, ey, 4 * k, C.paper, { stroke: Math.max(1, 2 * k) });
      disc(ctx, ex + dx * 1.5 * k, ey + dy * 1.5 * k, 1.8 * k, C.ink, { stroke: 0 });
    }
  }

  // A straight sticker with text, kept inside the board. `side` puts its near edge a cell
  // to the right or left of (cx, cy) instead of centring it there.
  function tag(text, cx, cy, fill, side = "center") {
    const size = Math.max(12, Math.round(cell * 0.6));
    ctx.font = `900 ${size}px "Archivo Variable", "Helvetica Neue", Arial, sans-serif`;
    const w = ctx.measureText(text).width + size * 1.1;
    const h = size * 1.7;
    const boardW = cell * frame.cols;
    const boardH = cell * frame.rows;
    const left = side === "right" ? cx + cell : side === "left" ? cx - cell - w : cx - w / 2;
    const x = Math.min(Math.max(left, 4), boardW - w - 4);
    const y = Math.min(Math.max(cy - h / 2, 4), boardH - h - 7);
    sticker(ctx, x, y, w, h, h / 2, fill, { shadow: 3 });
    label(ctx, text, x + w / 2, y + h / 2 + 1, { size, align: "center", baseline: "middle" });
  }

  function draw() {
    if (!frame || cell < 4) return;
    const w = cell * frame.cols;
    const h = cell * frame.rows;
    paper(ctx, w, h, { size: cell });

    const food = frame.food;
    for (let i = 0; i < food.length; i += 3) {
      const { x, y } = center(food[i], food[i + 1]);
      const from = food[i + 2];
      if (from < 0) disc(ctx, x, y, cell * 0.2, C.ink, { stroke: 0 });
      else disc(ctx, x, y, cell * 0.22, C[SLOT_COLORS[from]], { stroke: 2 });
    }

    for (const snake of frame.snakes) if (snake.alive) drawSnake(snake);

    if (tags) {
      for (const snake of frame.snakes) {
        if (!snake.alive) continue;
        const [dx, dy] = DIRS[snake.dir] ?? DIRS.right;
        const head = center(snake.body[0], snake.body[1]);
        const name = names.get(snake.slot) ?? COLOR_NAMES[SLOT_COLORS[snake.slot]];
        const fill = C[SLOT_COLORS[snake.slot]];
        // Above a snake heading sideways (below, near the top wall); beside one heading up or down.
        if (dy === 0) {
          const above = snake.body[1] >= 2;
          tag(name, head.x - dx * cell, head.y + (above ? -1.5 : 1.5) * cell, fill);
        } else {
          tag(name, head.x, head.y, fill, snake.body[0] < frame.cols / 2 ? "right" : "left");
        }
      }
    }

    const now = performance.now();
    crashes = crashes.filter((c) => c.until > now);
    for (const c of crashes) {
      const at = center(c.x, c.y);
      tag(`${COLOR_NAMES[SLOT_COLORS[c.slot]]} OUT!`, at.x, at.y, C.paper);
    }
  }

  const observer = new ResizeObserver(fit);
  observer.observe(root);

  return {
    // A new board from the server. Snakes that just died get an OUT! sticker where they crashed.
    setFrame(next) {
      const before = frame && frame.round === next.round ? new Map(frame.snakes.map((s) => [s.slot, s])) : null;
      const resized = !frame || frame.cols !== next.cols || frame.rows !== next.rows;
      if (before) {
        for (const snake of next.snakes) {
          const was = before.get(snake.slot);
          if (was?.alive && !snake.alive) {
            // Where its head was when it crashed.
            crashes.push({ x: was.body[0], y: was.body[1], slot: snake.slot, until: performance.now() + CRASH_SHOWN_MS });
          }
        }
        if (crashes.length > 0) {
          clearTimeout(crashTimer);
          crashTimer = setTimeout(draw, CRASH_SHOWN_MS + 20);
        }
      } else {
        crashes = [];
      }
      frame = next;
      if (resized || cell === 0) fit();
      else draw();
    },

    // slot -> name, for the name tags.
    setNames(players) {
      const next = new Map(players.map((p) => [p.slot, p.name]));
      const changed = next.size !== names.size || [...next].some(([slot, name]) => names.get(slot) !== name);
      names = next;
      if (changed && tags) draw();
    },

    // Name tags next to each head, so players can find their snake before GO.
    setTags(on) {
      if (tags === on) return;
      tags = on;
      draw();
    },

    // The section just became visible: size the canvas to it.
    refit: fit,
  };
}
