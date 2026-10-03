// The join QR code, drawn in the club brand: rounded modules, rounded corner "eyes" and the
// bracket mark in the middle. Error correction Q (25%) easily covers the ~4% the mark hides, and
// the mark is left out of codes big enough (version 7+) to have an alignment pattern in the centre.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";

const INK = "#111111";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// The mark's drawing (its <g>), reused inside the code.
const MARK = fs
  .readFileSync(path.join(root, "public/assets/logo-mark.svg"), "utf8")
  .match(/<g[\s\S]*<\/g>/)[0];

export function brandedQr(text) {
  const { version, modules } = QRCode.create(text, { errorCorrectionLevel: "Q" });
  const n = modules.size;
  const dark = (r, c) => modules.get(r, c) === 1;
  const eyes = [
    [0, 0],
    [0, n - 7],
    [n - 7, 0],
  ];
  const inEye = (r, c) => eyes.some(([er, ec]) => r >= er && r < er + 7 && c >= ec && c < ec + 7);

  // A clear square in the middle for the mark (an odd number of modules, so it's centred).
  const withMark = version < 7;
  let hole = Math.round(n * 0.2);
  if (hole % 2 === 0) hole += 1;
  const h0 = (n - hole) / 2;
  const inHole = (r, c) => withMark && r >= h0 && r < h0 + hole && c >= h0 && c < h0 + hole;

  let dots = "";
  for (let r = 0; r < n; r += 1) {
    for (let c = 0; c < n; c += 1) {
      if (!dark(r, c) || inEye(r, c) || inHole(r, c)) continue;
      dots += `M${c + 0.04} ${r + 0.34}a.3 .3 0 0 1 .3-.3h.32a.3 .3 0 0 1 .3.3v.32a.3 .3 0 0 1-.3.3h-.32a.3 .3 0 0 1-.3-.3z`;
    }
  }
  const eyeShapes = eyes
    .map(
      ([r, c]) =>
        `<rect x="${c + 0.5}" y="${r + 0.5}" width="6" height="6" rx="1.9" fill="none" stroke="${INK}" stroke-width="1"/>` +
        `<rect x="${c + 2}" y="${r + 2}" width="3" height="3" rx="0.95" fill="${INK}"/>`
    )
    .join("");
  // The mark is 124×68; it sits in the hole with a module of paper around it.
  const markW = hole - 1.2;
  const markH = (markW * 68) / 124;
  const mark = withMark
    ? `<svg x="${h0 + 0.6}" y="${h0 + (hole - markH) / 2}" width="${markW}" height="${markH}" viewBox="0 0 124 68">${MARK}</svg>`
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="geometricPrecision" role="img" aria-label="Join QR code"><path d="${dots}" fill="${INK}"/>${eyeShapes}${mark}</svg>`;
}
