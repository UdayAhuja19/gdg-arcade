// The branded join QR (server/pictionary/qr.js): rounded modules, rounded eyes, and the bracket mark
// in the middle only when it can't cover an alignment pattern.
import { test } from "node:test";
import assert from "node:assert/strict";
import QRCode from "qrcode";
import { brandedQr } from "../server/pictionary/qr.js";

const TUNNEL = "https://raymond-gardening-products-translations.trycloudflare.com";

test("the join code is an SVG with three rounded eyes and the mark in the middle", () => {
  const svg = brandedQr(TUNNEL);
  const n = QRCode.create(TUNNEL, { errorCorrectionLevel: "Q" }).modules.size;
  assert.match(svg, new RegExp(`^<svg [^>]*viewBox="0 0 ${n} ${n}"`));
  assert.equal(svg.match(/rx="1.9"/g).length, 3, "three eye rings");
  assert.match(svg, /viewBox="0 0 124 68"/, "the bracket mark");
});

test("a code big enough to have a centre alignment pattern leaves the mark out", () => {
  const long = `https://${"a-very-long-tunnel-name-".repeat(5)}x.trycloudflare.com`;
  assert.ok(QRCode.create(long, { errorCorrectionLevel: "Q" }).version >= 7);
  assert.doesNotMatch(brandedQr(long), /viewBox="0 0 124 68"/);
});
