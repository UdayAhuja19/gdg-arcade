// Makes the QR code for the club's socials page. The page lives in the gdg-resources repo
// (socials/index.html) on GitHub Pages; this repo only needs the code for the party big screen.
//
//   node scripts/socials-qr.js            writes public/assets/socials-qr.svg (the big screen's corner card)
//   node scripts/socials-qr.js ~/Downloads   also writes print copies (PNG and SVG, with a quiet zone) there
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";

export const SOCIALS_URL = "https://udayahuja19.github.io/gdg-resources/socials/";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const colours = { color: { dark: "#111111", light: "#ffffff" } };

// The card draws its own white padding, so the on-screen copy has no margin.
const asset = path.join(root, "public", "assets", "socials-qr.svg");
await fs.writeFile(asset, await QRCode.toString(SOCIALS_URL, { type: "svg", margin: 0, errorCorrectionLevel: "M", ...colours }));
console.log(`Wrote ${path.relative(root, asset)}`);

const outDir = process.argv[2];
if (outDir) {
  await fs.mkdir(outDir, { recursive: true });
  const png = path.join(outDir, "GDG-UOBD-socials-QR.png");
  const svg = path.join(outDir, "GDG-UOBD-socials-QR.svg");
  await QRCode.toFile(png, SOCIALS_URL, { width: 2000, margin: 4, errorCorrectionLevel: "M", ...colours });
  await fs.writeFile(svg, await QRCode.toString(SOCIALS_URL, { type: "svg", margin: 4, errorCorrectionLevel: "M", ...colours }));
  console.log(`Wrote ${png}\nWrote ${svg}`);
}
console.log(`Points to ${SOCIALS_URL}`);
