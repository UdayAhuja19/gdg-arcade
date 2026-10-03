// PICTIONARY's server with real sockets: 120 phones join, are balanced into teams, and play
// a turn against the projector. Short pick/ready/reveal times keep it quick.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import WebSocket from "ws";
import { createPictionaryServer } from "../server/pictionary/server.js";

const PHONES = 120;

function open(url, options) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, options);
    ws.messages = [];
    ws.waiters = [];
    ws.on("message", (data) => {
      const msg = JSON.parse(data);
      ws.messages.push(msg);
      ws.waiters = ws.waiters.filter((w) => !(w.match(msg) && (w.resolve(msg), true)));
    });
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

// The next message (or one already received after `from`) that matches.
function next(ws, match, { from = 0, ms = 5000 } = {}) {
  const seen = ws.messages.slice(from).find(match);
  if (seen) return Promise.resolve(seen);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting on ${match}`)), ms);
    ws.waiters.push({ match, resolve: (msg) => (clearTimeout(timer), resolve(msg)) });
  });
}

const send = (ws, msg) => ws.send(JSON.stringify(msg));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function get(port, host) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: "/", headers: { host } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    }).on("error", reject);
  });
}

test(`${PHONES} phones join, play a turn and see the results`, { timeout: 30_000 }, async () => {
  const server = createPictionaryServer({ timing: { pickMs: 400, readyMs: 400, revealMs: 300, guessGapMs: 0 }, tickMs: 20 });
  const ports = await server.listen({ phonePort: 0, screenPort: 0 });
  const phoneUrl = `ws://127.0.0.1:${ports.phone}/ws`;
  const screen = await open(`ws://127.0.0.1:${ports.screen}/ws`, { origin: `http://127.0.0.1:${ports.screen}` });

  try {
    // ---- Everyone joins ----
    const phones = await Promise.all(Array.from({ length: PHONES }, () => open(phoneUrl)));
    phones.forEach((ws, i) => send(ws, { t: "join", clientId: `phone-${String(i).padStart(4, "0")}`, name: `Player ${i}` }));
    const joined = await Promise.all(phones.map((ws) => next(ws, (m) => m.t === "joined")));
    const perTeam = [0, 0, 0, 0, 0, 0];
    joined.forEach((m) => (perTeam[m.team] += 1));
    assert.deepEqual(perTeam, [20, 20, 20, 20, 20, 20]);
    assert.equal(server.phoneCount(), PHONES);

    // ---- The game starts; one red player is asked to pick ----
    send(screen, { t: "settings", rounds: 1 });
    send(screen, { t: "start" });
    const pickViews = await Promise.all(phones.map((ws) => next(ws, (m) => m.t === "view" && m.phase === "pick")));
    const drawerIndex = pickViews.findIndex((v) => v.turn.isDrawer);
    assert.ok(drawerIndex >= 0, "someone is drawing");
    assert.equal(joined[drawerIndex].team, 0, "red draws first");
    assert.equal(pickViews.filter((v) => v.turn.choices).length, 1, "only the drawer gets the words");
    const drawer = phones[drawerIndex];
    const from = screen.messages.length;
    send(drawer, { t: "pick", index: 1, turn: pickViews[drawerIndex].turn.number });
    const ready = await next(drawer, (m) => m.t === "view" && m.phase === "ready");
    const word = ready.turn.word;
    assert.ok(word, "the drawer sees the word");

    // ---- The first stroke starts the clock ----
    send(screen, { t: "drawing" });
    await next(screen, (m) => m.t === "state" && m.phase === "draw", { from });

    // ---- Guessing: a wrong guess, then everyone else gets it ----
    const guessers = phones.filter((_, i) => joined[i].team !== 0);
    const teammates = phones.filter((_, i) => joined[i].team === 0 && i !== drawerIndex);
    send(teammates[0], { t: "guess", text: word, turn: ready.turn.number, seq: 1 });
    assert.equal((await next(teammates[0], (m) => m.t === "guessed")).status, "drawing-team");
    send(guessers[0], { t: "guess", text: "definitely wrong", turn: ready.turn.number, seq: 1 });
    assert.equal((await next(guessers[0], (m) => m.t === "guessed" && m.seq === 1)).status, "wrong");
    await next(screen, (m) => m.t === "feed" && m.kind === "wrong" && m.text === "DEFINITELY WRONG");
    guessers.forEach((ws) => send(ws, { t: "guess", text: word.toUpperCase(), turn: ready.turn.number, seq: 2 }));
    const acks = await Promise.all(guessers.map((ws) => next(ws, (m) => m.t === "guessed" && m.seq === 2)));
    assert.ok(acks.every((a) => a.status === "correct"), "every guesser got it");

    // ---- Everyone got it, so the turn ends at once ----
    const reveal = await next(screen, (m) => m.t === "state" && m.phase === "reveal", { from });
    assert.equal(reveal.turn.word, word);
    assert.equal(reveal.turn.reason, "all");
    assert.equal(reveal.turn.teamPoints[0], 200, "everyone guessed: the drawing team gets the full 200");
    for (const pts of reveal.turn.teamPoints.slice(1)) assert.ok(pts >= 250, `guessing teams average near the top: ${pts}`);

    // The projector never had the word before the reveal.
    const early = screen.messages.slice(from).filter((m) => m.t === "state" && m.phase !== "reveal" && m.phase !== "results");
    assert.ok(early.length > 0);
    for (const m of early) assert.ok(!JSON.stringify(m).toLowerCase().includes(word.toLowerCase()), `the word leaked in ${m.phase}`);

    // ---- The host ends the game: results on every phone ----
    send(screen, { t: "end" });
    const results = await Promise.all(phones.map((ws) => next(ws, (m) => m.t === "view" && m.phase === "results")));
    assert.equal(results[0].results.ranking.length, 6);
    assert.ok(results[0].results.ranking[0].score > 0);

    // ---- A phone that floods the server is cut off ----
    const flood = phones[5];
    const closed = new Promise((resolve) => flood.once("close", (code) => resolve(code)));
    for (let i = 0; i < 200; i += 1) send(flood, { t: "pong" });
    assert.equal(await closed, 1008);

    phones.forEach((ws) => ws.close());
  } finally {
    screen.close();
    await server.close();
  }
});

test("the projector only answers this laptop, and only its own page may connect", async () => {
  const server = createPictionaryServer();
  const ports = await server.listen({ phonePort: 0, screenPort: 0 });
  try {
    assert.equal(await get(ports.screen, `127.0.0.1:${ports.screen}`), 200);
    assert.equal(await get(ports.screen, "evil.example.com"), 403);
    assert.equal(await get(ports.phone, "anything.trycloudflare.com"), 200);
    await assert.rejects(open(`ws://127.0.0.1:${ports.screen}/ws`, { origin: "https://evil.example.com" }));
  } finally {
    await server.close();
  }
});

test("a phone that comes back keeps its team; a removed one is told so", async () => {
  const server = createPictionaryServer();
  const ports = await server.listen({ phonePort: 0, screenPort: 0 });
  const url = `ws://127.0.0.1:${ports.phone}/ws`;
  const screen = await open(`ws://127.0.0.1:${ports.screen}/ws`, { origin: `http://127.0.0.1:${ports.screen}` });
  try {
    const a = await open(url);
    send(a, { t: "join", clientId: "aaaaaaaa-1", name: "Amira" });
    const first = await next(a, (m) => m.t === "joined");
    a.close();
    await wait(50);
    const again = await open(url);
    send(again, { t: "join", clientId: "aaaaaaaa-1", name: "Amira", rejoin: true });
    const back = await next(again, (m) => m.t === "joined");
    assert.equal(back.team, first.team);
    assert.equal(back.rejoined, true);

    send(screen, { t: "kick", id: "aaaaaaaa-1" });
    await next(again, (m) => m.t === "kicked");
    const ghost = await open(url);
    send(ghost, { t: "join", clientId: "aaaaaaaa-1", name: "Amira", rejoin: true });
    await next(ghost, (m) => m.t === "expired");

    const rude = await open(url);
    send(rude, { t: "join", clientId: "bbbbbbbb-2", name: "shithead" });
    assert.equal((await next(rude, (m) => m.t === "error")).message, "PICK A DIFFERENT NAME.");
    [ghost, rude].forEach((ws) => ws.close());
  } finally {
    screen.close();
    await server.close();
  }
});
