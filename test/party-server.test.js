// The party server end to end: real sockets on random ports, no tunnel.
import http from "node:http";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { createPartyServer } from "../server/party/server.js";

let party;
let phoneUrl;
let screenUrl;

before(async () => {
  party = createPartyServer({ pingEveryMs: 50, snapshotEveryMs: 50 });
  const ports = await party.listen({ phonePort: 0, screenPort: 0 });
  phoneUrl = `http://127.0.0.1:${ports.phone}`;
  screenUrl = `http://127.0.0.1:${ports.screen}`;
});

after(async () => {
  await party.close();
});

// A socket that keeps every message so tests can wait for the one they need.
function open(httpUrl, options = {}) {
  const ws = new WebSocket(`${httpUrl.replace("http", "ws")}/ws`, options);
  const inbox = [];
  const waiters = [];
  ws.on("message", (data) => {
    const msg = JSON.parse(data);
    inbox.push(msg);
    for (const w of [...waiters]) {
      if (w.match(msg)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(msg);
      }
    }
  });
  const client = {
    ws,
    inbox,
    send: (msg) => ws.send(JSON.stringify(msg)),
    next(match, timeoutMs = 2000) {
      const found = inbox.find(match);
      if (found) {
        inbox.splice(inbox.indexOf(found), 1);
        return Promise.resolve(found);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out waiting for a message")), timeoutMs);
        waiters.push({
          match,
          resolve: (msg) => {
            clearTimeout(timer);
            inbox.splice(inbox.indexOf(msg), 1);
            resolve(msg);
          },
        });
      });
    },
    close() {
      ws.close();
      return new Promise((resolve) => ws.once("close", resolve));
    },
  };
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve(client));
    ws.once("error", reject);
  });
}

const openScreen = (url = screenUrl) => open(url, { origin: url });

async function joinPhone(clientId, name, network = "wifi", extra = {}, url = phoneUrl) {
  const phone = await open(url);
  phone.send({ t: "join", clientId, name, network, ...extra });
  const reply = await phone.next((m) => ["joined", "full", "error", "expired", "kicked"].includes(m.t));
  return { phone, reply };
}

async function stateWhere(screen, check) {
  // Snapshots arrive every 50ms. Drop the ones already received so an old one can't match.
  for (let i = screen.inbox.length - 1; i >= 0; i -= 1) {
    if (screen.inbox[i].t === "state") screen.inbox.splice(i, 1);
  }
  return screen.next((m) => m.t === "state" && check(m));
}

// fetch() won't send a custom Host header, so use http directly.
function statusWithHost(url, host) {
  return new Promise((resolve, reject) => {
    http
      .get(url, { headers: { host } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      })
      .on("error", reject);
  });
}

async function clearRoom() {
  const screen = await openScreen();
  screen.send({ t: "clear" });
  await stateWhere(screen, (s) => s.players.every((p) => p === null));
  await screen.close();
}

test("each port serves only its own page", async () => {
  const phonePage = await fetch(phoneUrl).then((r) => r.text());
  const screenPage = await fetch(screenUrl).then((r) => r.text());
  assert.match(phonePage, /party\/js\/phone\.js/);
  assert.match(screenPage, /party\/js\/screen\.js/);

  const css = await fetch(`${phoneUrl}/party/css/party.css`);
  assert.equal(css.status, 200);
  assert.equal((await fetch(`${phoneUrl}/admin.html`)).status, 404, "the arcade isn't exposed");
  assert.equal((await fetch(`${phoneUrl}/api/leaderboard`)).status, 404);
});

test("the big screen refuses requests that aren't addressed to localhost", async () => {
  assert.equal(await statusWithHost(screenUrl, "evil.example"), 403);
  assert.equal(await statusWithHost(screenUrl, "localhost"), 200);

  await assert.rejects(open(screenUrl, { origin: "https://evil.example" }));
  await assert.rejects(open(screenUrl.replace("127.0.0.1", "localhost"), { origin: screenUrl }), "origin must match");
});

test("a phone joins, and the big screen sees it, its dot and its taps", async () => {
  await clearRoom();
  const screen = await openScreen();
  assert.equal((await screen.next((m) => m.t === "join")).maxPlayers, 5);

  const { phone, reply } = await joinPhone("phone-aaaa-1", "  sara k ", "cellular");
  assert.equal(reply.t, "joined");
  assert.equal(reply.slot, 0);
  assert.equal(reply.color, "red");
  assert.equal(reply.name, "SARA K");
  assert.equal(reply.updateHz, 10);

  const state = await stateWhere(screen, (s) => s.players[0]?.name === "SARA K");
  assert.equal(state.players[0].network, "cellular");

  phone.send({ t: "update", x: 0.25 });
  assert.deepEqual(await screen.next((m) => m.t === "u"), { t: "u", slot: 0, x: 0.25 });
  phone.send({ t: "update", x: 7 });
  assert.equal((await screen.next((m) => m.t === "u")).x, 1, "positions are clamped");

  phone.send({ t: "tap" });
  assert.deepEqual(await screen.next((m) => m.t === "tap"), { t: "tap", slot: 0, taps: 1 });
  assert.equal((await phone.next((m) => m.t === "tapped")).taps, 1);

  phone.send({ t: "network", network: "wifi" });
  await stateWhere(screen, (s) => s.players[0]?.network === "wifi");

  await phone.close();
  await screen.close();
});

test("pings are answered and measured", async () => {
  await clearRoom();
  const screen = await openScreen();
  const { phone } = await joinPhone("phone-bbbb-1", "PINGER");
  for (let i = 0; i < 4; i += 1) {
    const ping = await phone.next((m) => m.t === "ping");
    phone.send({ t: "pong", id: ping.id });
  }
  const state = await stateWhere(screen, (s) => (s.players[0]?.recentPings.length ?? 0) >= 3);
  assert.ok(state.players[0].median >= 0);
  assert.notEqual(state.players[0].verdict, "MEASURING");
  const later = await phone.next((m) => m.t === "ping" && m.rtt !== null);
  assert.ok(later.rtt >= 0, "the phone is told its own ping");
  await phone.close();
  await screen.close();
});

test("bad names are refused with the arcade's message", async () => {
  const { phone, reply } = await joinPhone("phone-cccc-1", "x");
  assert.deepEqual(reply, { t: "error", message: "USE 2 TO 16 LETTERS OR NUMBERS." });
  phone.send({ t: "join", clientId: "../../etc", name: "SARA K" });
  assert.equal((await phone.next((m) => m.t === "error")).message, "RELOAD THE PAGE AND TRY AGAIN.");
  await phone.close();
});

test("the 6th phone is told the party is full", async () => {
  await clearRoom();
  const phones = [];
  for (let i = 0; i < 5; i += 1) phones.push((await joinPhone(`phone-full-${i}`, `P${i}`)).phone);
  const extra = await joinPhone("phone-full-9", "LATE");
  assert.equal(extra.reply.t, "full");
  await Promise.all([...phones, extra.phone].map((p) => p.close()));
});

test("a phone that reconnects gets its slot back", async () => {
  await clearRoom();
  const screen = await openScreen();
  const first = await joinPhone("phone-dddd-1", "BACK AGAIN");
  await first.phone.close();
  await stateWhere(screen, (s) => s.players[0]?.connected === false);

  const second = await joinPhone("phone-dddd-1", "BACK AGAIN");
  assert.equal(second.reply.rejoined, true);
  assert.equal(second.reply.slot, 0);
  const state = await stateWhere(screen, (s) => s.players[0]?.connected === true);
  assert.equal(state.players[0].reconnects, 1);

  // Back on a new connection before the old one was noticed as dead (a network switch):
  // the old one is closed and it still counts as a rejoin.
  const third = await joinPhone("phone-dddd-1", "BACK AGAIN");
  const code = await new Promise((resolve) => second.phone.ws.once("close", resolve));
  assert.equal(code, 4001);
  const after = await stateWhere(screen, (s) => s.players[0]?.reconnects === 2);
  assert.equal(after.players[0].connected, true);
  assert.equal(after.players[0].slot, 0);

  await third.phone.close();
  await screen.close();
});

test("the big screen can remove a phone, and a phone can leave", async () => {
  await clearRoom();
  const screen = await openScreen();
  const kicked = await joinPhone("phone-eeee-1", "KICK ME");
  const leaver = await joinPhone("phone-eeee-2", "BYE NOW");

  screen.send({ t: "kick", slot: 0 });
  await kicked.phone.next((m) => m.t === "kicked");
  await new Promise((resolve) => kicked.phone.ws.once("close", resolve));

  leaver.phone.send({ t: "leave" });
  await leaver.phone.next((m) => m.t === "left");

  const state = await stateWhere(screen, (s) => s.players[0] === null && s.players[1] === null);
  assert.equal(state.verdict.level, "waiting");
  await screen.close();
});

test("the join link reaches the big screen as a QR code", async () => {
  const screen = await openScreen();
  await screen.next((m) => m.t === "join");
  await party.setJoin("https://example-words.trycloudflare.com", "live");
  const msg = await screen.next((m) => m.t === "join");
  assert.equal(msg.url, "https://example-words.trycloudflare.com");
  assert.equal(msg.tunnel, "live");
  assert.match(msg.qr, /^<svg/);
  await screen.close();
});

test("a phone coming back to a spot that's gone is told so", async () => {
  await clearRoom();
  const expired = await joinPhone("phone-ffff-1", "LATE AGAIN", "wifi", { rejoin: true });
  assert.equal(expired.reply.t, "expired");
  await expired.phone.close();

  // Removed from the big screen while offline: told "kicked" once, then free to join again.
  const screen = await openScreen();
  const first = await joinPhone("phone-ffff-2", "OFFLINE KICK");
  await first.phone.close();
  await stateWhere(screen, (s) => s.players[0]?.connected === false);
  screen.send({ t: "kick", slot: 0 });
  await stateWhere(screen, (s) => s.players[0] === null);

  const back = await joinPhone("phone-ffff-2", "OFFLINE KICK", "wifi", { rejoin: true });
  assert.equal(back.reply.t, "kicked");
  await back.phone.close();
  const fresh = await joinPhone("phone-ffff-2", "OFFLINE KICK");
  assert.equal(fresh.reply.t, "joined");
  assert.equal(fresh.reply.rejoined, false);
  await fresh.phone.close();
  await screen.close();
});

test("a paused phone shows as PAUSED until it resumes", async () => {
  await clearRoom();
  const screen = await openScreen();
  const { phone } = await joinPhone("phone-gggg-1", "SLEEPY");
  phone.send({ t: "pause" });
  const paused = await stateWhere(screen, (s) => s.players[0]?.paused === true);
  assert.equal(paused.players[0].verdict, "PAUSED");
  phone.send({ t: "resume" });
  await stateWhere(screen, (s) => s.players[0]?.paused === false);
  await phone.close();
  await screen.close();
});

test("a burst of queued messages after a stall doesn't disconnect the phone", async () => {
  await clearRoom();
  const screen = await openScreen();
  const { phone } = await joinPhone("phone-hhhh-1", "BURSTY");
  for (let i = 0; i < 150; i += 1) phone.send({ t: "update", x: i / 150 });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(phone.ws.readyState, WebSocket.OPEN);
  await stateWhere(screen, (s) => s.players[0]?.connected === true);

  // A flood well past the allowance still gets cut off.
  for (let i = 0; i < 400; i += 1) phone.send({ t: "update", x: 0.5 });
  const code = await new Promise((resolve) => phone.ws.once("close", resolve));
  assert.equal(code, 1008);
  await screen.close();
});

test("sockets over the limit are refused without taking the server down", async () => {
  const sockets = [];
  for (let i = 0; i < 24; i += 1) sockets.push(await open(phoneUrl));
  const extra = new WebSocket(`${phoneUrl.replace("http", "ws")}/ws`);
  extra.on("error", () => {});
  extra.on("open", () => extra.send("x".repeat(400)));
  await new Promise((resolve) => extra.once("close", resolve));
  await Promise.all(sockets.map((s) => s.close()));

  const { phone, reply } = await joinPhone("phone-iiii-1", "STILL UP");
  assert.equal(reply.t, "joined");
  await phone.close();
});

test("a port that's already taken is reported, not a crash", async () => {
  const other = createPartyServer();
  const port = Number(new URL(phoneUrl).port);
  await assert.rejects(other.listen({ phonePort: port, screenPort: 0 }), { code: "EADDRINUSE" });
  await other.close();
});

test("a battle starts with fewer than 4 phones, and only the big screen can start it", async () => {
  await clearRoom();
  const screen = await openScreen();

  // Nobody in the room yet: the big screen is told why it can't start.
  screen.send({ t: "start" });
  assert.equal((await screen.next((m) => m.t === "notice")).message, "NEED AT LEAST 1 PLAYER TO START.");

  const first = await joinPhone("phone-jjjj-1", "FIRST PHONE");
  const firstLobby = await first.phone.next((m) => m.t === "round" && m.players === 1);
  assert.equal(firstLobby.phase, "lobby");
  assert.equal(firstLobby.minPlayers, 1);
  assert.equal("host" in firstLobby, false);

  const second = await joinPhone("phone-jjjj-2", "SECOND PHONE");
  await second.phone.next((m) => m.t === "round" && m.players === 2);

  // Phones can't start a round, not even the first one that joined.
  first.phone.send({ t: "start" });
  second.phone.send({ t: "start" });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(first.phone.inbox.some((m) => m.t === "round" && m.phase === "countdown"), false);

  screen.send({ t: "start" });
  const countdown = await second.phone.next((m) => m.t === "round" && m.phase === "countdown");
  assert.equal(countdown.inRound, true);
  assert.ok(countdown.endsInMs > countdown.durationMs);
  const state = await stateWhere(screen, (s) => s.round.phase === "countdown");
  assert.deepEqual(state.round.bars.map((b) => b.name).sort(), ["FIRST PHONE", "SECOND PHONE"]);

  screen.send({ t: "start" });
  assert.equal((await screen.next((m) => m.t === "notice")).message, "A ROUND IS ALREADY RUNNING.");

  await Promise.all([first.phone.close(), second.phone.close()]);
  await screen.close();
  await clearRoom();
});

test("in a battle, the first full bar wins, reports are confirmed, and a late phone still counts", async () => {
  // A clock the test moves by hand, so a whole round takes milliseconds.
  let now = 1_000_000;
  const party = createPartyServer({ clock: () => now, pingEveryMs: 20, snapshotEveryMs: 20 });
  const ports = await party.listen({ phonePort: 0, screenPort: 0 });
  const phoneAt = `http://127.0.0.1:${ports.phone}`;
  const screenAt = `http://127.0.0.1:${ports.screen}`;
  try {
    const screen = await openScreen(screenAt);
    const a = await joinPhone("phone-kkkk-1", "FAST ONE", "wifi", {}, phoneAt);
    const b = await joinPhone("phone-kkkk-2", "SLOW ONE", "wifi", {}, phoneAt);
    const c = await joinPhone("phone-kkkk-3", "OFFLINE ONE", "wifi", {}, phoneAt);
    screen.send({ t: "start" });
    const countdown = await a.phone.next((m) => m.t === "round" && m.phase === "countdown");

    now += 3000; // GO
    await stateWhere(screen, (s) => s.round.phase === "playing");

    now += 3000;
    b.phone.send({ t: "progress", round: countdown.number, seq: 1, level: 55, taps: 40 });
    assert.deepEqual(await b.phone.next((m) => m.t === "ack"), { t: "ack", round: 1, seq: 1, status: "saved" });
    assert.deepEqual(await screen.next((m) => m.t === "bar" && m.slot === 1), { t: "bar", slot: 1, level: 55, full: false });

    // The third phone reports once, then loses its connection.
    c.phone.send({ t: "progress", round: 1, seq: 1, level: 30, taps: 25 });
    await c.phone.next((m) => m.t === "ack");
    await c.phone.close();

    now += 3000;
    a.phone.send({ t: "progress", round: 1, seq: 9, level: 100, taps: 70, done: true, ms: 5800, final: true });
    assert.equal((await a.phone.next((m) => m.t === "ack")).status, "saved");
    assert.equal((await screen.next((m) => m.t === "bar" && m.slot === 0)).full, true);
    const heard = await b.phone.next((m) => m.t === "round" && m.winner === "FAST ONE");
    assert.equal(heard.youWon, false);
    const state = await stateWhere(screen, (s) => s.round.winner === "FAST ONE");
    assert.equal(state.players[0].taps, 70, "battle taps count on the card too");

    // Resending a final bar the server already has is confirmed as final.
    a.phone.send({ t: "progress", round: 1, seq: 10, level: 100, taps: 70, done: true, ms: 5800, final: true });
    assert.equal((await a.phone.next((m) => m.t === "ack" && m.seq === 10)).status, "final");

    now += 1500; // the finish window closes
    const result = await a.phone.next((m) => m.t === "round" && m.phase === "results");
    assert.deepEqual(result.result, { rank: 1, of: 3, level: 100, finishMs: 5800 }, "the phone's own finish time");
    const other = await b.phone.next((m) => m.t === "round" && m.phase === "results");
    assert.deepEqual(other.result, { rank: 2, of: 3, level: 55, finishMs: null });
    const final = await stateWhere(screen, (s) => s.round.phase === "results");
    assert.deepEqual(final.round.results.map((r) => r.name), ["FAST ONE", "SLOW ONE", "OFFLINE ONE"]);

    // The offline phone filled its bar at 5.5s before it lost the connection. It comes back
    // after the results, finds its round is over, and hands in the bar it kept.
    now += 4000;
    const back = await joinPhone("phone-kkkk-3", "OFFLINE ONE", "wifi", { rejoin: true }, phoneAt);
    assert.equal(back.reply.t, "joined");
    const itsRound = await back.phone.next((m) => m.t === "round" && m.phase === "results");
    assert.equal(itsRound.inRound, true);
    back.phone.send({ t: "progress", round: 1, seq: 7, level: 100, taps: 160, done: true, ms: 5500, final: true });
    assert.equal((await back.phone.next((m) => m.t === "ack" && m.seq === 7)).status, "saved");
    const updated = await back.phone.next((m) => m.t === "round" && m.result?.rank === 1);
    assert.deepEqual(updated.result, { rank: 1, of: 3, level: 100, finishMs: 5500 });
    const redone = await stateWhere(screen, (s) => s.round.results[0]?.name === "OFFLINE ONE");
    assert.deepEqual(redone.round.results.map((r) => r.name), ["OFFLINE ONE", "FAST ONE", "SLOW ONE"]);
    assert.equal((await a.phone.next((m) => m.t === "round" && m.result?.rank === 2)).result.rank, 2);

    // A report for an old round is confirmed as too late, so the phone can stop sending it.
    back.phone.send({ t: "progress", round: 99, seq: 8, level: 50, final: true });
    assert.equal((await back.phone.next((m) => m.t === "ack" && m.seq === 8)).status, "too-late");

    // Back to the lobby from the big screen.
    screen.send({ t: "lobby" });
    await a.phone.next((m) => m.t === "round" && m.phase === "lobby");

    await Promise.all([a.phone.close(), b.phone.close(), back.phone.close(), screen.close()]);
  } finally {
    await party.close();
  }
});

test("the big screen picks the game between rounds, and only it gets the drawing helpers", async () => {
  assert.equal((await fetch(`${screenUrl}/js/engine/draw.js`)).status, 200);
  assert.equal((await fetch(`${phoneUrl}/js/engine/draw.js`)).status, 404, "the arcade's code isn't on the phone port");
  assert.equal((await fetch(`${screenUrl}/js/engine/loop.js`)).status, 404);

  await clearRoom();
  const screen = await openScreen();
  const { phone } = await joinPhone("phone-llll-1", "SWITCHER");
  await phone.next((m) => m.t === "round" && m.game === "tap");

  screen.send({ t: "game", game: "snake" });
  const lobby = await phone.next((m) => m.t === "round" && m.game === "snake");
  assert.equal(lobby.phase, "lobby");
  assert.equal((await stateWhere(screen, (s) => s.round.game === "snake")).round.phase, "lobby");

  screen.send({ t: "game", game: "pinball" });
  screen.send({ t: "start" });
  await stateWhere(screen, (s) => s.round.phase === "countdown");
  assert.equal((await stateWhere(screen, () => true)).round.game, "snake", "an unknown game is ignored");
  screen.send({ t: "game", game: "tap" });
  assert.equal((await screen.next((m) => m.t === "notice")).message, "FINISH THIS ROUND FIRST.");
  assert.equal((await stateWhere(screen, () => true)).round.game, "snake");

  // CLEAR ROOM ends the round; then the game can change back.
  screen.send({ t: "clear" });
  await stateWhere(screen, (s) => s.round.phase === "lobby");
  screen.send({ t: "game", game: "tap" });
  await stateWhere(screen, (s) => s.round.game === "tap");
  await Promise.all([phone.close(), screen.close()]);
});

test("in a snake battle, phones steer, the laptop runs the board, and the last snake wins", async () => {
  let now = 2_000_000;
  const party = createPartyServer({
    clock: () => now,
    pingEveryMs: 20,
    snapshotEveryMs: 20,
    gameEveryMs: 5,
    snakeTiming: { stepMs: 100 },
    // Food goes in the bottom-right corner, out of the way.
    random: () => 0.999999,
  });
  const ports = await party.listen({ phonePort: 0, screenPort: 0 });
  const phoneAt = `http://127.0.0.1:${ports.phone}`;
  const screenAt = `http://127.0.0.1:${ports.screen}`;
  const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
  try {
    const screen = await openScreen(screenAt);
    const red = await joinPhone("phone-mmmm-1", "RED ONE", "wifi", {}, phoneAt);
    const blue = await joinPhone("phone-mmmm-2", "BLUE ONE", "wifi", {}, phoneAt);
    screen.send({ t: "game", game: "snake" });
    await red.phone.next((m) => m.t === "round" && m.game === "snake");

    // The big screen starts it, like MASH BATTLE.
    screen.send({ t: "start" });
    const countdown = await red.phone.next((m) => m.t === "round" && m.phase === "countdown");
    assert.equal(countdown.inRound, true);
    assert.equal(countdown.spawn, "TOP LEFT");
    assert.equal((await blue.phone.next((m) => m.t === "round" && m.phase === "countdown")).spawn, "TOP RIGHT");
    const board = await screen.next((m) => m.t === "arena");
    assert.equal(board.step, 0);
    assert.deepEqual(
      board.snakes.map((s) => [s.slot, s.body.slice(0, 2)]),
      [
        [0, [6, 3]],
        [1, [28, 6]],
      ]
    );

    // A turn before GO doesn't count.
    red.phone.send({ t: "turn", round: countdown.number, dir: "down" });
    await settle();
    now += 3000; // GO
    await red.phone.next((m) => m.t === "round" && m.phase === "playing");

    red.phone.send({ t: "turn", round: countdown.number, dir: "up" });
    await settle();
    for (let step = 1; step <= 3; step += 1) {
      now += 100;
      const frame = await screen.next((m) => m.t === "arena" && m.step === step);
      assert.deepEqual(frame.snakes[0].body.slice(0, 2), [6, 3 - step], `red goes up on step ${step}`);
      assert.deepEqual(frame.snakes[1].body.slice(0, 2), [28, 6 + step]);
    }

    now += 100; // red leaves the board
    const crash = await screen.next((m) => m.t === "arena" && m.step === 4);
    assert.equal(crash.snakes[0].alive, false);
    assert.equal(crash.food.filter((_, i) => i % 3 === 2 && crash.food[i] === 0).length, 4, "red's body is food");
    const out = await red.phone.next((m) => m.t === "round" && m.over === true);
    assert.equal(out.alive, false);
    assert.deepEqual(out.cause, { type: "wall" });
    assert.equal(out.winner, "BLUE ONE");
    assert.equal((await stateWhere(screen, (s) => s.round.over)).round.winner, "BLUE ONE");

    now += 1500; // the final board stays up, then the results
    const redResult = await red.phone.next((m) => m.t === "round" && m.phase === "results");
    assert.deepEqual(redResult.result, { rank: 2, of: 2, length: 4, alive: false, outAtMs: 400 });
    const blueResult = await blue.phone.next((m) => m.t === "round" && m.phase === "results");
    assert.equal(blueResult.result.rank, 1);
    const final = await stateWhere(screen, (s) => s.round.phase === "results");
    assert.deepEqual(
      final.round.results.map((r) => [r.rank, r.name]),
      [
        [1, "BLUE ONE"],
        [2, "RED ONE"],
      ]
    );

    // Phones never get the board; the big screen does.
    assert.equal([...red.phone.inbox, ...blue.phone.inbox].some((m) => m.t === "arena"), false);
    await Promise.all([red.phone.close(), blue.phone.close(), screen.close()]);
  } finally {
    await party.close();
  }
});

test("phones sending junk are disconnected", async () => {
  const phone = await open(phoneUrl);
  phone.ws.send("not json");
  const code = await new Promise((resolve) => phone.ws.once("close", resolve));
  assert.equal(code, 1007);
});

test("in SPLIT SECOND, phones run blind, lock in, and the big screen sees every run", async () => {
  let now = 3_000_000;
  const party = createPartyServer({
    clock: () => now,
    pingEveryMs: 20,
    snapshotEveryMs: 20,
    gameEveryMs: 5,
    // Targets 1.00, 2.00, 3.00.
    random: () => 0,
  });
  const ports = await party.listen({ phonePort: 0, screenPort: 0 });
  const phoneAt = `http://127.0.0.1:${ports.phone}`;
  const screenAt = `http://127.0.0.1:${ports.screen}`;
  try {
    const screen = await openScreen(screenAt);
    const a = await joinPhone("phone-ssss-1", "ONE", "wifi", {}, phoneAt);
    const b = await joinPhone("phone-ssss-2", "TWO", "wifi", {}, phoneAt);
    screen.send({ t: "game", game: "split" });
    await a.phone.next((m) => m.t === "round" && m.game === "split");
    screen.send({ t: "start" });
    const countdown = await a.phone.next((m) => m.t === "round" && m.phase === "countdown");
    const round = countdown.number;

    now += 2000; // round 1: the target, then 3-2-1
    const set = await a.phone.next((m) => m.t === "round" && m.stage === "set");
    assert.equal(set.targetMs, 1000);
    now += 5000; // the window opens
    await a.phone.next((m) => m.t === "round" && m.stage === "run");

    const act = (phone, seq, event, ms) => phone.send({ t: "split", round, leg: 0, seq, event, ms });
    act(a.phone, 1, "start");
    assert.equal((await a.phone.next((m) => m.t === "ack" && m.seq === 1)).status, "saved");
    assert.equal((await screen.next((m) => m.t === "split" && m.event === "start")).slot, 0);
    now += 1050;
    act(a.phone, 2, "stop", 1040);
    const stop = await screen.next((m) => m.t === "split" && m.event === "stop");
    assert.deepEqual([stop.slot, stop.ms, stop.error, stop.locked], [0, 1040, 40, false]);
    const blind = await a.phone.next((m) => m.t === "round" && m.canLock === true);
    assert.equal(blind.reveal, null);
    assert.equal(JSON.stringify(blind).includes("1040"), false, "the phone never sees its own time before the reveal");

    act(a.phone, 3, "lock");
    assert.equal((await a.phone.next((m) => m.t === "ack" && m.seq === 3)).status, "saved");
    act(a.phone, 4, "lock");
    assert.equal((await a.phone.next((m) => m.t === "ack" && m.seq === 4)).status, "final", "a resent lock is already in");

    act(b.phone, 1, "start");
    await b.phone.next((m) => m.t === "ack" && m.seq === 1);
    now += 900;
    act(b.phone, 2, "stop", 880);
    await b.phone.next((m) => m.t === "ack" && m.seq === 2);
    act(b.phone, 3, "lock");
    // Everyone locked: the leg ends and each phone learns its own time.
    const reveal = await a.phone.next((m) => m.t === "round" && m.stage === "reveal");
    assert.deepEqual(reveal.reveal, { ms: 1040, error: 40, total: 40 });
    const shown = await stateWhere(screen, (s) => s.round.stage === "reveal");
    assert.deepEqual(shown.round.results.map((r) => [r.name, r.total]), [["ONE", 40], ["TWO", 120]]);

    // Phones never hear about other players' runs.
    assert.equal([...a.phone.inbox, ...b.phone.inbox].some((m) => m.t === "split"), false);
    await Promise.all([a.phone.close(), b.phone.close(), screen.close()]);
  } finally {
    await party.close();
  }
});

test("in LIGHTS OUT, phones sync their clocks, get the schedule ahead, and taps reach the big screen", async () => {
  let now = 4_000_000;
  const party = createPartyServer({
    clock: () => now,
    pingEveryMs: 20,
    snapshotEveryMs: 20,
    gameEveryMs: 5,
    lightsTiming: { holds: [500, 800, 1100] },
  });
  const ports = await party.listen({ phonePort: 0, screenPort: 0 });
  const phoneAt = `http://127.0.0.1:${ports.phone}`;
  const screenAt = `http://127.0.0.1:${ports.screen}`;
  try {
    const screen = await openScreen(screenAt);
    const a = await joinPhone("phone-llll-1", "ONE", "wifi", {}, phoneAt);
    a.phone.send({ t: "sync", c: 123.5 });
    assert.deepEqual(await a.phone.next((m) => m.t === "sync"), { t: "sync", c: 123.5, s: now });

    screen.send({ t: "game", game: "lights" });
    await a.phone.next((m) => m.t === "round" && m.game === "lights");
    screen.send({ t: "start" });
    const countdown = await a.phone.next((m) => m.t === "round" && m.phase === "countdown");
    now += 2000;
    const grid = await a.phone.next((m) => m.t === "round" && m.stage === "grid");
    assert.equal(grid.lightsAt, now + 2500);
    assert.equal(grid.outAt, now + 2500 + 4000 + 500);
    now = grid.outAt;
    await a.phone.next((m) => m.t === "round" && m.stage === "go");
    now += 280;
    a.phone.send({ t: "lights", round: countdown.number, leg: 0, seq: 1, ms: 240 });
    assert.equal((await a.phone.next((m) => m.t === "ack" && m.seq === 1)).status, "saved");
    assert.deepEqual(await screen.next((m) => m.t === "lights"), { t: "lights", slot: 0, ms: 240, jump: false });
    const reveal = await a.phone.next((m) => m.t === "round" && m.stage === "reveal");
    assert.deepEqual(reveal.mine, { ms: 240, jump: false });
    await Promise.all([a.phone.close(), screen.close()]);
  } finally {
    await party.close();
  }
});
