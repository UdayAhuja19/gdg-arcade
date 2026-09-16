// Canvas drawing in the brand style: graph paper, flat fills, 3px ink outlines,
// hard shadows and Archivo type. See DESIGN.md section 9.
export const C = {
  paper: "#ffffff",
  grid: "#ececec",
  ink: "#111111",
  muted: "#bdbdbd",
  red: "#ea4335",
  blue: "#4285f4",
  yellow: "#fbbc04",
  green: "#34a853",
};

export const BRAND_CYCLE = [C.red, C.yellow, C.green, C.blue];
export const FONT = '"Archivo Variable", "Helvetica Neue", Arial, sans-serif';
export const STROKE = 3;

// Sets up a crisp canvas at a fixed logical size and scales it to fit its container.
// Resizing clears a canvas, so set `view.redraw` to repaint when the loop isn't running.
export function createCanvas(root, width, height, { maxHeightOffset = 250 } = {}) {
  const canvas = document.createElement("canvas");
  canvas.className = "game-canvas";
  canvas.setAttribute("role", "img");
  root.append(canvas);
  const ctx = canvas.getContext("2d");

  function fit() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const maxW = root.clientWidth || width;
    const maxH = Math.max(240, window.innerHeight - maxHeightOffset);
    const scale = Math.min(maxW / width, maxH / height);
    canvas.style.width = `${Math.floor(width * scale)}px`;
    canvas.style.height = `${Math.floor(height * scale)}px`;
    canvas.width = Math.round(width * scale * dpr);
    canvas.height = Math.round(height * scale * dpr);
    ctx.setTransform(scale * dpr, 0, 0, scale * dpr, 0, 0);
    view.redraw?.();
  }

  const view = {
    canvas,
    ctx,
    width,
    height,
    redraw: null,
    destroy() {
      observer.disconnect();
      window.removeEventListener("resize", fit);
      canvas.remove();
    },
  };

  fit();
  const observer = new ResizeObserver(fit);
  observer.observe(root);
  window.addEventListener("resize", fit);

  return view;
}

export function paper(ctx, w, h, { size = 24, offsetX = 0, offsetY = 0 } = {}) {
  ctx.fillStyle = C.paper;
  ctx.fillRect(0, 0, w, h);
  ctx.beginPath();
  const startX = -(((offsetX % size) + size) % size);
  const startY = -(((offsetY % size) + size) % size);
  for (let x = startX; x <= w; x += size) {
    ctx.moveTo(Math.round(x) + 0.5, 0);
    ctx.lineTo(Math.round(x) + 0.5, h);
  }
  for (let y = startY; y <= h; y += size) {
    ctx.moveTo(0, Math.round(y) + 0.5);
    ctx.lineTo(w, Math.round(y) + 0.5);
  }
  ctx.strokeStyle = C.grid;
  ctx.lineWidth = 1;
  ctx.stroke();
}

export function roundRectPath(ctx, x, y, w, h, r) {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, radius);
}

// Outlined rounded rectangle with an optional hard shadow straight down.
export function sticker(ctx, x, y, w, h, r, fill, { shadow = 0, stroke = STROKE } = {}) {
  if (shadow > 0) {
    roundRectPath(ctx, x, y + shadow, w, h, r);
    ctx.fillStyle = C.ink;
    ctx.fill();
  }
  roundRectPath(ctx, x, y, w, h, r);
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke > 0) {
    ctx.lineWidth = stroke;
    ctx.strokeStyle = C.ink;
    ctx.stroke();
  }
}

export function disc(ctx, x, y, r, fill, { stroke = STROKE } = {}) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke > 0) {
    ctx.lineWidth = stroke;
    ctx.strokeStyle = C.ink;
    ctx.stroke();
  }
}

// Shapes built from circles get their outline by drawing a slightly bigger ink
// silhouette first, which avoids seams where circles overlap.
function outlinedCircles(ctx, circles, fill, stroke = STROKE) {
  ctx.fillStyle = C.ink;
  ctx.beginPath();
  for (const [x, y, r] of circles) {
    ctx.moveTo(x + r + stroke, y);
    ctx.arc(x, y, r + stroke, 0, Math.PI * 2);
  }
  ctx.fill();
  ctx.fillStyle = fill;
  ctx.beginPath();
  for (const [x, y, r] of circles) {
    ctx.moveTo(x + r, y);
    ctx.arc(x, y, r, 0, Math.PI * 2);
  }
  ctx.fill();
}

export function flower(ctx, cx, cy, r, fill, spin = 0) {
  const lobes = 9;
  const circles = [[cx, cy, r * 0.72]];
  for (let i = 0; i < lobes; i += 1) {
    const a = spin + (i / lobes) * Math.PI * 2;
    circles.push([cx + Math.cos(a) * r * 0.66, cy + Math.sin(a) * r * 0.66, r * 0.3]);
  }
  outlinedCircles(ctx, circles, fill);
}

export function blob(ctx, cx, cy, r, fill, angle = Math.PI / 4) {
  const d = r * 0.55;
  const dx = Math.cos(angle) * d;
  const dy = Math.sin(angle) * d;
  const cr = r * 0.5;
  outlinedCircles(
    ctx,
    [
      [cx - dx, cy - dy, cr],
      [cx, cy, cr],
      [cx + dx, cy + dy, cr],
    ],
    fill
  );
}

export function label(ctx, text, x, y, { size = 24, weight = 900, color = C.ink, align = "left", baseline = "alphabetic", tracking = 0 } = {}) {
  ctx.font = `${weight} ${size}px ${FONT}`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  if ("letterSpacing" in ctx) ctx.letterSpacing = `${tracking}px`;
  ctx.fillText(text, x, y);
  if ("letterSpacing" in ctx) ctx.letterSpacing = "0px";
}

// Pill-shaped text badge like "+10" or "PERFECT", drawn straight on the canvas.
export function badge(ctx, text, x, y, { fill = C.yellow, size = 18, rotate = 0, color = C.ink } = {}) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rotate);
  ctx.font = `900 ${size}px ${FONT}`;
  const w = ctx.measureText(text).width + size * 1.1;
  const h = size * 1.7;
  sticker(ctx, -w / 2, -h / 2, w, h, h / 2, fill, { shadow: 3 });
  label(ctx, text, 0, 1, { size, color, align: "center", baseline: "middle" });
  ctx.restore();
}

// Floating "+10" style popups that rise and fade out.
export function createPopups() {
  const items = [];
  return {
    add(text, x, y, fill = C.yellow) {
      items.push({ text, x, y, fill, age: 0, tilt: (Math.random() - 0.5) * 0.3 });
    },
    update() {
      for (const p of items) {
        p.age += 1;
        p.y -= 0.8;
      }
      while (items.length && items[0].age > 50) items.shift();
    },
    draw(ctx) {
      for (const p of items) {
        const t = p.age / 50;
        const scale = p.age < 8 ? 0.5 + (p.age / 8) * 0.6 : 1.1 - Math.min(0.1, (p.age - 8) / 40);
        ctx.save();
        ctx.globalAlpha = t > 0.7 ? 1 - (t - 0.7) / 0.3 : 1;
        ctx.translate(p.x, p.y);
        ctx.scale(scale, scale);
        badge(ctx, p.text, 0, 0, { fill: p.fill, rotate: p.tilt, size: 16 });
        ctx.restore();
      }
    },
  };
}

// The live score in the corner of every canvas game.
export function scoreHud(ctx, score, x, y, { align = "right", size = 34 } = {}) {
  label(ctx, Number(score).toLocaleString("en-US"), x, y, { size, align, baseline: "top", tracking: -0.5 });
}

// Hitboxes are smaller than the drawing so near-misses feel fair.
export function overlaps(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export function shrink(box, factor) {
  const dw = box.w * (1 - factor);
  const dh = box.h * (1 - factor);
  return { x: box.x + dw / 2, y: box.y + dh / 2, w: box.w - dw, h: box.h - dh };
}

export function rand(min, max) {
  return min + Math.random() * (max - min);
}
