// The party connection test: two small web servers sharing one room.
//
//   phone port  (tunnelled) : the join page and the phones' live connection
//   screen port (this laptop): the big screen and its live connection
//
// Only the phone port is ever reachable from outside, so the arcade, the admin page
// and MySQL stay private. Messages are small JSON objects with a "t" (type) field.
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer } from "ws";
import QRCode from "qrcode";
import { createRoom, MAX_PLAYERS, UPDATE_HZ } from "./room.js";
import { createRound, MIN_PLAYERS } from "./round.js";
import { createSnakeRound } from "./snake-round.js";
import { normalizeName } from "../../public/js/shared/names.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const PING_EVERY_MS = 1000;
// A ping with no answer after this long counts as missed (a later answer still counts as a ping time).
const PING_TIMEOUT_MS = 3000;
// Nothing at all from a phone for this long: the connection is dead even if it never closed.
const DEAD_AFTER_MS = 10_000;
// A phone that connects but never joins gets dropped after this long.
const JOIN_TIMEOUT_MS = 60_000;
const SNAPSHOT_EVERY_MS = 250;
// How often a SNAKE ROYALE board is checked for a due step (steps are 100-143ms apart).
const GAME_EVERY_MS = 10;
const GAMES = new Set(["tap", "snake"]);
const MAX_MESSAGE_BYTES = 512;
// Phones send about 11 messages a second (10 updates and a pong), plus taps. The burst
// allowance covers a phone whose connection stalled for a few seconds and then sends
// everything it queued at once.
const MAX_MESSAGES_PER_SEC = 60;
const MESSAGE_BURST = 200;
const MAX_PHONE_SOCKETS = 24;
// Phones removed from the big screen while they were offline, told so when they come back.
const MAX_REMEMBERED_KICKS = 64;
const NETWORKS = new Set(["wifi", "cellular", "unknown"]);
const CLIENT_ID = /^[A-Za-z0-9-]{8,64}$/;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isLocalHost(hostHeader) {
  try {
    return LOCAL_HOSTS.has(new URL(`http://${hostHeader}`).hostname);
  } catch {
    return false;
  }
}

function webApp(page, { localOnly, drawHelpers = false }) {
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    // The big screen only answers to localhost, so another website can't reach it
    // through a DNS trick.
    if (localOnly && !isLocalHost(req.headers.host)) return res.status(403).type("text").send("FORBIDDEN");
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Referrer-Policy", "no-referrer");
    res.set("Cache-Control", "no-cache");
    next();
  });
  const serve = (...dir) => express.static(path.join(root, ...dir), { index: false });
  app.use("/css", serve("public", "css"));
  app.use("/fonts", serve("public", "fonts"));
  app.use("/assets", serve("public", "assets"));
  app.use("/js/shared", serve("public", "js", "shared"));
  app.use("/party/css", serve("party", "css"));
  app.use("/party/js", serve("party", "js"));
  // The big screen draws the snake board with the arcade's canvas helpers; phones don't need them.
  if (drawHelpers) {
    app.get("/js/engine/draw.js", (req, res) => res.sendFile("draw.js", { root: path.join(root, "public", "js", "engine") }));
  }
  // `root` keeps this working when the project sits inside a folder whose name starts with a dot.
  app.get("/", (req, res) => res.sendFile(page, { root: path.join(root, "party") }));
  app.use((req, res) => res.status(404).type("text").send("NOT FOUND"));
  // Never show a stack trace (with this laptop's paths) on the public port.
  app.use((err, req, res, next) => {
    res.status(err.status ?? 500).type("text").send(err.status === 404 ? "NOT FOUND" : "SOMETHING WENT WRONG");
  });
  return app;
}

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}

export function createPartyServer({
  clock = Date.now,
  pingEveryMs = PING_EVERY_MS,
  snapshotEveryMs = SNAPSHOT_EVERY_MS,
  roundTiming = {},
  snakeTiming = {},
  gameEveryMs = GAME_EVERY_MS,
  random,
} = {}) {
  const room = createRoom();
  // Both games keep their own round; the big screen picks which one is on.
  const rounds = { tap: createRound(roundTiming), snake: createSnakeRound(snakeTiming, { random }) };
  let game = "tap";
  const current = () => rounds[game];
  const phones = new Map(); // clientId -> its current socket
  const screens = new Set();
  const kickedOffline = new Set();
  let join = { url: null, qr: null, tunnel: "off" };
  let timers = [];

  const phoneHttp = http.createServer(webApp("phone.html", { localOnly: false }));
  const screenHttp = http.createServer(webApp("screen.html", { localOnly: true, drawHelpers: true }));

  const phoneWss = new WebSocketServer({ server: phoneHttp, path: "/ws", maxPayload: MAX_MESSAGE_BYTES });
  const screenWss = new WebSocketServer({
    server: screenHttp,
    path: "/ws",
    maxPayload: MAX_MESSAGE_BYTES,
    // Only the big screen page itself may connect, not some other page open in the browser.
    verifyClient: ({ origin, req }) => {
      if (!isLocalHost(req.headers.host)) return false;
      try {
        return new URL(origin).host === req.headers.host;
      } catch {
        return false;
      }
    },
  });

  // Without these, a port that's already taken crashes the process before index.js can
  // explain it; listen() still sees the error through the HTTP server.
  phoneWss.on("error", () => {});
  screenWss.on("error", () => {});

  function toScreens(msg) {
    const data = JSON.stringify(msg);
    for (const ws of screens) if (ws.readyState === ws.OPEN) ws.send(data);
  }

  function snapshotMessage() {
    const now = clock();
    return { t: "state", ...room.snapshot(now), round: { game, ...current().snapshot(now) } };
  }

  // ---------- Rounds ----------
  // The host is the phone that joined first; it can start rounds from the phone.
  function roundMessage(clientId, present, now) {
    const host = present[0] ?? null;
    return {
      t: "round",
      game,
      ...current().viewFor(clientId, now),
      host: host?.clientId === clientId,
      hostName: host?.name ?? null,
      players: present.length,
      minPlayers: MIN_PLAYERS,
    };
  }

  // Every phone gets its own view whenever the round or the line-up changes.
  function roundToPhones() {
    const now = clock();
    const present = room.present();
    for (const [clientId, ws] of phones) send(ws, roundMessage(clientId, present, now));
  }

  function startRound() {
    const present = room.present();
    const players = present.map(({ clientId, slot, color, name }) => ({ clientId, slot, color, name }));
    const result = current().start(players, clock());
    if (result.error) return result;
    roundToPhones();
    toScreens(snapshotMessage());
    if (game === "snake") toScreens({ t: "arena", ...rounds.snake.frame() });
    return result;
  }

  // Someone left the party (kicked, left, or gone too long): out of both games' rounds.
  function removeFromRounds(clientId) {
    const now = clock();
    rounds.tap.remove(clientId);
    if (rounds.snake.remove(clientId, now)) {
      const frame = rounds.snake.frame();
      if (frame) toScreens({ t: "arena", ...frame });
    }
  }

  // SNAKE ROYALE runs on the server: step the board when it's due, show it on the big
  // screen, and tell phones when something happened to them.
  function runSnake() {
    const snake = rounds.snake;
    if (game !== "snake" || (snake.phase !== "countdown" && snake.phase !== "playing")) return;
    const now = clock();
    if (snake.tick(now)) lineupChanged();
    const stepped = snake.advance(now);
    if (!stepped) return;
    toScreens({ t: "arena", ...stepped.frame });
    if (stepped.deaths.length > 0 || stepped.over) {
      lineupChanged();
      return;
    }
    if (stepped.grew.length === 0) return;
    const present = room.present();
    for (const clientId of stepped.grew) {
      const ws = phones.get(clientId);
      if (ws) send(ws, roundMessage(clientId, present, now));
    }
  }

  function lineupChanged() {
    roundToPhones();
    toScreens(snapshotMessage());
  }

  function joinMessage() {
    return { t: "join", ...join, maxPlayers: MAX_PLAYERS };
  }

  // Ends a phone's connection without the close handler treating it as a dropout.
  function dropPhone(clientId, msg, code, reason) {
    const ws = phones.get(clientId);
    phones.delete(clientId);
    if (!ws) {
      // Removed while offline: remember it, or its automatic rejoin would take a fresh spot.
      if (msg.t === "kicked") {
        kickedOffline.add(clientId);
        if (kickedOffline.size > MAX_REMEMBERED_KICKS) kickedOffline.delete(kickedOffline.values().next().value);
      }
      return;
    }
    ws.conn.clientId = null;
    send(ws, msg);
    ws.close(code, reason);
  }

  // ---------- Phones ----------
  function handlePhone(ws, conn, msg) {
    const now = clock();

    if (msg.t === "join") {
      if (typeof msg.clientId !== "string" || !CLIENT_ID.test(msg.clientId)) {
        return send(ws, { t: "error", message: "RELOAD THE PAGE AND TRY AGAIN." });
      }
      if (conn.clientId && conn.clientId !== msg.clientId) return;
      const checked = normalizeName(msg.name);
      if (checked.error) return send(ws, { t: "error", message: checked.error });
      const network = NETWORKS.has(msg.network) ? msg.network : "unknown";

      // A phone coming back to a spot that's gone is told so, instead of quietly getting a new one.
      if (!room.player(msg.clientId)) {
        if (kickedOffline.delete(msg.clientId)) return send(ws, { t: "kicked" });
        if (msg.rejoin === true) return send(ws, { t: "expired" });
      }

      // The same phone is back on a new connection before the old one was noticed as
      // dead (a network switch does this). That's still a dropout, so record it as one.
      const old = phones.get(msg.clientId);
      if (old && old !== ws) {
        old.conn.pending.forEach(() => room.recordMissedPing(msg.clientId, now));
        room.leave(msg.clientId, now);
        phones.delete(msg.clientId);
        old.conn.clientId = null;
        old.close(4001, "replaced");
      }

      const result = room.join({ clientId: msg.clientId, name: checked.name, network }, now);
      if (result.full) return send(ws, { t: "full" });

      conn.clientId = msg.clientId;
      conn.pending.clear();
      conn.late.clear();
      phones.set(msg.clientId, ws);

      const { player } = result;
      send(ws, {
        t: "joined",
        slot: player.slot,
        color: player.color,
        name: player.name,
        rejoined: result.rejoined,
        taps: player.taps,
        updateHz: UPDATE_HZ,
      });
      lineupChanged();
      return;
    }

    // Everything else needs a joined phone.
    const clientId = conn.clientId;
    if (!clientId) return;

    switch (msg.t) {
      case "pong": {
        const sentAt = conn.pending.get(msg.id) ?? conn.late.get(msg.id);
        if (sentAt === undefined) return;
        conn.pending.delete(msg.id);
        conn.late.delete(msg.id);
        conn.lastRtt = now - sentAt;
        room.recordPing(clientId, conn.lastRtt);
        return;
      }
      case "pause":
      case "resume": {
        room.setPaused(clientId, msg.t === "pause");
        // Pings sent while the page was asleep come back late for reasons that aren't the network.
        if (msg.t === "resume") {
          conn.pending.clear();
          conn.late.clear();
        }
        toScreens(snapshotMessage());
        return;
      }
      case "update": {
        const player = room.player(clientId);
        const x = Number(msg.x);
        if (!player || !Number.isFinite(x)) return;
        room.recordUpdate(clientId, now);
        toScreens({ t: "u", slot: player.slot, x: Math.min(1, Math.max(0, x)) });
        return;
      }
      case "tap": {
        const player = room.recordTap(clientId);
        if (!player) return;
        toScreens({ t: "tap", slot: player.slot, taps: player.taps });
        send(ws, { t: "tapped", taps: player.taps });
        return;
      }
      case "progress": {
        // A phone's MASH BATTLE bar, about 10 times a second during a round (and again
        // after a dropout, until the server has confirmed its final bar).
        if (rounds.tap.tick(now)) roundToPhones();
        const before = rounds.tap.entry(clientId);
        const tapsBefore = before?.taps ?? 0;
        const wasFull = before?.finishMs != null;
        const report = rounds.tap.report(clientId, msg, now);
        // Tells the phone this report arrived, so it can stop resending it.
        if (Number.isSafeInteger(msg.seq)) send(ws, { t: "ack", round: msg.round, seq: msg.seq, status: report.status });
        const { entry } = report;
        // A capped final bar still moves on the big screen while the phone resends it.
        if (report.status !== "saved" && report.status !== "capped") return;
        if (entry.taps > tapsBefore) room.recordTap(clientId, entry.taps - tapsBefore);
        const full = entry.finishMs !== null;
        toScreens({ t: "bar", slot: entry.slot, level: entry.level, full });
        // A late result changes the rankings; the first full bar tells everyone who did it.
        if (report.late) lineupChanged();
        else if (full && !wasFull) roundToPhones();
        return;
      }
      case "turn": {
        // SNAKE ROYALE steering. No reply: a turn that's late is better lost than resent.
        rounds.snake.turn(clientId, msg, now);
        return;
      }
      case "start": {
        // Only the host phone can start; everyone else waits for it (or the big screen).
        if (room.present()[0]?.clientId !== clientId) return;
        const result = startRound();
        if (result.error) send(ws, { t: "notice", message: result.error });
        return;
      }
      case "network": {
        if (NETWORKS.has(msg.network)) room.setNetwork(clientId, msg.network);
        return;
      }
      case "leave": {
        const player = room.player(clientId);
        if (player) room.kick(player.slot);
        removeFromRounds(clientId);
        dropPhone(clientId, { t: "left" }, 1000, "left");
        lineupChanged();
        return;
      }
      default:
    }
  }

  phoneWss.on("connection", (ws) => {
    const now = clock();
    const conn = {
      clientId: null,
      openedAt: now,
      lastHeard: now,
      pending: new Map(), // ping id -> sent at
      late: new Map(), // pings past PING_TIMEOUT_MS that may still be answered
      nextPing: 1,
      lastRtt: null,
      tokens: MESSAGE_BURST,
      refilledAt: now,
    };
    ws.conn = conn;
    // Attached first: a socket with no error listener crashes the process on a bad frame.
    ws.on("error", () => {});

    if (phoneWss.clients.size > MAX_PHONE_SOCKETS) {
      ws.terminate();
      return;
    }

    ws.on("message", (data, isBinary) => {
      const at = clock();
      conn.lastHeard = at;
      conn.tokens = Math.min(MESSAGE_BURST, conn.tokens + ((at - conn.refilledAt) / 1000) * MAX_MESSAGES_PER_SEC);
      conn.refilledAt = at;
      if (isBinary || conn.tokens < 1) {
        ws.close(1008, "too many messages");
        return;
      }
      conn.tokens -= 1;
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        ws.close(1007, "bad message");
        return;
      }
      if (msg && typeof msg.t === "string") handlePhone(ws, conn, msg);
    });

    ws.on("close", () => {
      if (conn.clientId && phones.get(conn.clientId) === ws) {
        phones.delete(conn.clientId);
        room.leave(conn.clientId, clock());
        // A dropout keeps its round score; the host may have changed.
        lineupChanged();
      }
    });
  });

  function pingPhones() {
    const now = clock();
    const verdicts = new Map();
    for (const p of room.snapshot(now).players) if (p) verdicts.set(p.slot, p.verdict);

    for (const ws of phoneWss.clients) {
      const conn = ws.conn;
      if (!conn.clientId) {
        if (now - conn.openedAt > JOIN_TIMEOUT_MS) ws.terminate();
        continue;
      }
      for (const [id, sentAt] of conn.pending) {
        if (now - sentAt > PING_TIMEOUT_MS) {
          conn.pending.delete(id);
          conn.late.set(id, sentAt);
          room.recordMissedPing(conn.clientId, now);
        }
      }
      for (const [id, sentAt] of conn.late) {
        if (now - sentAt > DEAD_AFTER_MS) conn.late.delete(id);
      }
      if (now - conn.lastHeard > DEAD_AFTER_MS) {
        ws.terminate();
        continue;
      }
      const id = conn.nextPing;
      conn.nextPing += 1;
      conn.pending.set(id, now);
      const player = room.player(conn.clientId);
      send(ws, {
        t: "ping",
        id,
        rtt: conn.lastRtt,
        verdict: player ? verdicts.get(player.slot) : null,
      });
    }
    const gone = room.sweep(now);
    for (const player of gone) removeFromRounds(player.clientId);
    if (gone.length > 0) lineupChanged();
  }

  // ---------- Big screen ----------
  screenWss.on("connection", (ws) => {
    screens.add(ws);
    send(ws, joinMessage());
    send(ws, snapshotMessage());
    const frame = game === "snake" && rounds.snake.phase !== "lobby" ? rounds.snake.frame() : null;
    if (frame) send(ws, { t: "arena", ...frame });

    ws.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }
      if (msg?.t === "kick" && Number.isInteger(msg.slot)) {
        const player = room.kick(msg.slot);
        if (player) {
          removeFromRounds(player.clientId);
          dropPhone(player.clientId, { t: "kicked" }, 4002, "removed");
        }
      } else if (msg?.t === "clear") {
        for (const player of room.clear()) dropPhone(player.clientId, { t: "kicked" }, 4002, "removed");
        rounds.tap.reset();
        rounds.snake.reset();
      } else if (msg?.t === "start") {
        const result = startRound();
        if (result.error) send(ws, { t: "notice", message: result.error });
        return;
      } else if (msg?.t === "lobby") {
        if (!current().toLobby()) return;
      } else if (msg?.t === "game") {
        // Which game the next round plays. Not while a round is on.
        if (!GAMES.has(msg.game) || msg.game === game) return;
        const { phase } = current();
        if (phase !== "lobby" && phase !== "results") {
          send(ws, { t: "notice", message: "FINISH THIS ROUND FIRST." });
          return;
        }
        current().toLobby();
        game = msg.game;
      } else if (msg?.t === "end") {
        // END ROUND: a SNAKE ROYALE has no time limit, so the booth can stop one.
        if (game !== "snake" || !rounds.snake.end(clock())) return;
      } else {
        return;
      }
      lineupChanged();
    });
    ws.on("close", () => screens.delete(ws));
    ws.on("error", () => {});
  });

  return {
    room,

    // Where phones should go. tunnel: "live" | "starting" | "down" | "missing" | "lan" | "off"
    async setJoin(url, tunnel) {
      const qr = url
        ? await QRCode.toString(url, {
            type: "svg",
            margin: 0,
            errorCorrectionLevel: "M",
            color: { dark: "#111111", light: "#ffffff" },
          })
        : null;
      join = { url, qr, tunnel };
      toScreens(joinMessage());
    },

    async listen({ phonePort = 3100, phoneHost = "127.0.0.1", screenPort = 3101 } = {}) {
      const ports = {
        phone: await listen(phoneHttp, phonePort, phoneHost),
        screen: await listen(screenHttp, screenPort, "127.0.0.1"),
      };
      timers = [
        setInterval(pingPhones, pingEveryMs),
        setInterval(() => {
          const now = clock();
          const tapChanged = rounds.tap.tick(now);
          const snakeChanged = rounds.snake.tick(now);
          if (tapChanged || snakeChanged) roundToPhones();
          toScreens(snapshotMessage());
        }, snapshotEveryMs),
        setInterval(runSnake, gameEveryMs),
      ];
      return ports;
    },

    async close() {
      timers.forEach(clearInterval);
      kickedOffline.clear();
      for (const ws of [...phoneWss.clients, ...screenWss.clients]) ws.terminate();
      phoneWss.close();
      screenWss.close();
      await Promise.all([
        new Promise((resolve) => phoneHttp.close(resolve)),
        new Promise((resolve) => screenHttp.close(resolve)),
      ]);
    },
  };
}
