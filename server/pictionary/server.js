// PICTIONARY: two small web servers sharing one game, like the party test.
//
//   phone port  (tunnelled) : the join page and up to MAX_PLAYERS phones guessing
//   screen port (this laptop): the projector, where the drawer draws and the host runs the game
//
// The drawing never crosses the network: it's drawn on the laptop and shown on the projector.
// Only words, guesses and the game state do. Messages are small JSON objects with a "t" field.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer } from "ws";
import { createGame, MAX_PLAYERS, TEAMS } from "./game.js";
import { brandedQr } from "./qr.js";
import { normalizeName } from "../../public/js/shared/names.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// Phones answer every ping; one that's silent this long is gone even if the socket never closed.
const PING_EVERY_MS = 2000;
const DEAD_AFTER_MS = 12_000;
const JOIN_TIMEOUT_MS = 60_000;
// How often the clock is checked (hints, the end of a turn) and the projector refreshed.
const TICK_MS = 100;
const SCREEN_EVERY_MS = 250;
const SCREEN_HEARTBEAT_MS = 1000;
const MAX_MESSAGE_BYTES = 512;
// A phone sends a pong every 2s and a guess at most every 0.6s; the burst covers a stalled phone.
const MAX_MESSAGES_PER_SEC = 20;
const MESSAGE_BURST = 60;
// Every player plus room for phones reconnecting before their old socket is noticed as dead.
const MAX_PHONE_SOCKETS = MAX_PLAYERS + 50;
const CLIENT_ID = /^[A-Za-z0-9-]{8,64}$/;
// Teams are saved to disk so a restart (a crash, Ctrl+C, the laptop lid) doesn't reshuffle them.
// A save older than this is from another day and is ignored.
const SAVE_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const SAVE_EVERY_MS = 1000;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isLocalHost(hostHeader) {
  try {
    return LOCAL_HOSTS.has(new URL(`http://${hostHeader}`).hostname);
  } catch {
    return false;
  }
}

function webApp(page, { localOnly, routes }) {
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    // The projector only answers to localhost, so another website can't reach it through a DNS trick.
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
  app.use("/pictionary/css", serve("pictionary", "css"));
  app.use("/pictionary/js", serve("pictionary", "js"));
  app.get("/", (req, res) => res.sendFile(page, { root: path.join(root, "pictionary") }));
  routes?.(app);
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

export function createPictionaryServer({ clock = Date.now, random, timing, tickMs = TICK_MS, pingEveryMs = PING_EVERY_MS, savePath = null, scores = null } = {}) {
  const game = createGame({ random, timing });
  let saveDirty = false;
  let restored = 0;
  let savedGameId = null;

  if (savePath) {
    try {
      const stat = fs.statSync(savePath);
      if (Date.now() - stat.mtimeMs < SAVE_MAX_AGE_MS) restored = game.restore(JSON.parse(fs.readFileSync(savePath, "utf8")).players);
    } catch {
      // No save yet, or a broken one: start empty.
    }
  }

  function save() {
    if (!saveDirty) return;
    saveDirty = false;
    const roster = game.roster();
    // The permanent record of who was in which team (the scoreboard keeps everyone, even after
    // REMOVE EVERYONE; the save file below is only for bringing a restarted game back).
    try {
      scores?.recordRoster(roster, Date.now());
    } catch (err) {
      console.error("PICTIONARY: couldn't record the teams:", err.message);
    }
    if (!savePath) return;
    const data = JSON.stringify({ savedAt: new Date().toISOString(), players: roster });
    // A few kilobytes at most, so it's written at once: no two saves can race, and the save on
    // shutdown is finished before the process exits. Written to a temporary file and renamed,
    // so a crash mid-write never leaves half a file.
    try {
      fs.writeFileSync(`${savePath}.tmp`, data);
      fs.renameSync(`${savePath}.tmp`, savePath);
    } catch (err) {
      console.error("PICTIONARY: couldn't save the teams:", err.message);
    }
  }

  // A game just reached its results: keep them on the scoreboard (once per game).
  function recordResults() {
    if (!scores || game.phase !== "results" || savedGameId === game.gameId) return;
    const view = game.screenView(clock());
    if (!view.results) return;
    savedGameId = game.gameId;
    try {
      scores.recordGame({ id: game.gameId, endedAt: Date.now(), turns: view.results.turns, settings: view.settings, ranking: view.results.ranking, top: view.results.top });
      console.log(`${new Date().toLocaleTimeString()} SCORES: saved this game's results.`);
    } catch (err) {
      console.error("PICTIONARY: couldn't save the results:", err.message);
    }
  }
  const phones = new Map(); // clientId -> its current socket
  const screens = new Set();
  let join = { url: null, qr: null, tunnel: "off" };
  let screenDirty = true;
  let lastScreenAt = 0;
  let timers = [];

  const phoneHttp = http.createServer(webApp("phone.html", { localOnly: false }));
  const screenHttp = http.createServer(webApp("screen.html", { localOnly: true, routes: scoreRoutes }));
  const phoneWss = new WebSocketServer({ server: phoneHttp, path: "/ws", maxPayload: MAX_MESSAGE_BYTES });
  const screenWss = new WebSocketServer({
    server: screenHttp,
    path: "/ws",
    maxPayload: MAX_MESSAGE_BYTES,
    // Only the projector page itself may connect, not some other page open in the browser.
    verifyClient: ({ origin, req }) => {
      if (!isLocalHost(req.headers.host)) return false;
      try {
        return new URL(origin).host === req.headers.host;
      } catch {
        return false;
      }
    },
  });
  // Without these, a port that's already taken crashes the process before index.js can explain it.
  phoneWss.on("error", () => {});
  screenWss.on("error", () => {});

  // A bug in one message mustn't stop the game for a hundred people: log it and carry on.
  function safely(fn) {
    try {
      fn();
    } catch (err) {
      console.error("PICTIONARY: something went wrong handling a message:", err);
    }
  }

  // ---------- The scores page (projector port only, so only this laptop can reach it) ----------
  function scoreRoutes(app) {
    app.get("/scores", (req, res) => res.sendFile("scores.html", { root: path.join(root, "pictionary") }));
    // Changes must come from the scores page itself, as JSON: another website open in this
    // browser can't send those (the browser stops it), so it can't touch the tally.
    app.use("/api", (req, res, next) => {
      if (!scores) return res.status(503).json({ error: "THE SCOREBOARD ISN'T AVAILABLE ON THIS LAPTOP." });
      if (req.method === "GET") return next();
      let sameOrigin = false;
      try {
        sameOrigin = new URL(req.headers.origin).host === req.headers.host;
      } catch {
        sameOrigin = false;
      }
      if (!sameOrigin) return res.status(403).json({ error: "FORBIDDEN" });
      if (req.method !== "DELETE" && !req.is("application/json")) return res.status(415).json({ error: "SEND JSON." });
      next();
    });
    app.use("/api", express.json({ limit: "8kb" }));
    const rowId = (req) => (/^\d{1,9}$/.test(req.params.id) ? Number(req.params.id) : null);
    const reply = (res, result) => (result.error ? res.status(400).json(result) : res.json({ ...result, ...scores.snapshot() }));
    app.get("/api/scores", (req, res) => res.json(scores.snapshot()));
    app.get("/api/scores.csv", (req, res) => res.attachment("hello-world-scores.csv").type("text/csv").send(scores.csv()));
    app.post("/api/tally", (req, res) => reply(res, scores.addTally(req.body, Date.now())));
    app.put("/api/tally/:id", (req, res) => {
      const id = rowId(req);
      reply(res, id === null ? { error: "THAT ROW IS GONE." } : scores.updateTally(id, req.body, Date.now()));
    });
    app.delete("/api/tally/:id", (req, res) => {
      const id = rowId(req);
      reply(res, id === null ? { error: "THAT ROW IS GONE." } : scores.deleteTally(id));
    });
  }

  // ---------- Sending ----------
  function toScreens(msg) {
    const data = JSON.stringify(msg);
    for (const ws of screens) if (ws.readyState === ws.OPEN) ws.send(data);
  }

  function screenState() {
    screenDirty = false;
    lastScreenAt = clock();
    toScreens({ t: "state", ...game.screenView(lastScreenAt) });
  }

  function viewTo(clientId) {
    const ws = phones.get(clientId);
    if (ws) send(ws, { t: "view", ...game.phoneView(clientId, clock()) });
  }

  // The game moved on (a new phase, a hint, the end of a turn): every phone gets its own view.
  function changed() {
    const now = clock();
    for (const [clientId, ws] of phones) send(ws, { t: "view", ...game.phoneView(clientId, now) });
    screenState();
    recordResults();
  }

  function dropPhone(clientId, msg, code, reason) {
    const ws = phones.get(clientId);
    phones.delete(clientId);
    if (!ws) return;
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
      // Coming back to a spot that's gone (removed, or the game was cleared): say so.
      if (msg.rejoin === true && !game.player(msg.clientId)) return send(ws, { t: "expired" });

      // The same phone on a new connection before the old one was noticed as dead.
      const old = phones.get(msg.clientId);
      if (old && old !== ws) {
        old.conn.clientId = null;
        old.close(4001, "replaced");
      }
      const result = game.join({ clientId: msg.clientId, name: checked.name }, now);
      if (result.full) return send(ws, { t: "full" });
      conn.clientId = msg.clientId;
      phones.set(msg.clientId, ws);
      const { player } = result;
      send(ws, { t: "joined", name: player.name, team: player.team, rejoined: result.rejoined });
      viewTo(msg.clientId);
      screenDirty = true;
      saveDirty = true;
      return;
    }

    const clientId = conn.clientId;
    if (!clientId) return;

    switch (msg.t) {
      case "pong":
        return;
      case "pick": {
        if (msg.turn !== game.turnNumber) return;
        const result = game.pick(clientId, msg.index, now);
        if (result.status === "saved") changed();
        else viewTo(clientId);
        return;
      }
      case "guess": {
        const seq = Number.isSafeInteger(msg.seq) ? msg.seq : null;
        const result = msg.turn === game.turnNumber ? game.guess(clientId, msg.text, now) : { status: "not-now" };
        send(ws, { t: "guessed", seq, status: result.status, points: result.points ?? null });
        const player = game.player(clientId);
        if (result.status === "wrong" && result.shown) {
          toScreens({ t: "feed", kind: "wrong", id: clientId, name: player.name, team: player.team, text: result.shown });
        } else if (result.status === "correct") {
          toScreens({ t: "feed", kind: "correct", id: clientId, name: player.name, team: player.team, points: result.points });
          if (result.ended) changed();
          else {
            viewTo(clientId);
            screenDirty = true;
          }
        }
        return;
      }
      case "leave": {
        game.kick(clientId, now);
        saveDirty = true;
        dropPhone(clientId, { t: "left" }, 1000, "left");
        changed();
        return;
      }
      default:
    }
  }

  phoneWss.on("connection", (ws) => {
    const now = clock();
    const conn = { clientId: null, openedAt: now, lastHeard: now, tokens: MESSAGE_BURST, refilledAt: now };
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
      if (msg && typeof msg.t === "string") safely(() => handlePhone(ws, conn, msg));
    });
    ws.on("close", () => {
      if (conn.clientId && phones.get(conn.clientId) === ws) {
        phones.delete(conn.clientId);
        game.setConnected(conn.clientId, false);
        screenDirty = true;
      }
    });
  });

  function pingPhones() {
    const now = clock();
    for (const ws of phoneWss.clients) {
      const conn = ws.conn;
      if (!conn.clientId) {
        if (now - conn.openedAt > JOIN_TIMEOUT_MS) ws.terminate();
        continue;
      }
      if (now - conn.lastHeard > DEAD_AFTER_MS) {
        ws.terminate();
        continue;
      }
      send(ws, { t: "ping", s: now });
    }
  }

  // ---------- Projector ----------
  // Everything the host does that changes the game is logged, so a surprise can be traced afterwards.
  const LOGGED = new Set(["start", "settings", "balance", "kick", "skipDrawer", "skipTurn", "next", "hold", "end", "lobby", "clear"]);

  function handleScreen(ws, msg) {
    const now = clock();
    if (LOGGED.has(msg.t)) {
      const detail = msg.t === "kick" ? ` ${game.player(msg.id)?.name ?? msg.id}` : msg.t === "settings" ? ` ${JSON.stringify({ rounds: msg.rounds, drawSeconds: msg.drawSeconds })}` : "";
      console.log(`${new Date(now).toLocaleTimeString()} HOST: ${msg.t}${detail}`);
    }
    const notice = (message) => send(ws, { t: "notice", message });
    switch (msg.t) {
      case "start": {
        const result = game.start(now);
        if (result.error) return notice(result.error);
        break;
      }
      case "settings":
        if (!game.setSettings({ rounds: msg.rounds, drawSeconds: msg.drawSeconds })) return;
        break;
      case "balance": {
        const moved = game.balance();
        saveDirty = true;
        notice(moved === 0 ? "TEAMS ARE ALREADY EVEN." : `MOVED ${moved} ${moved === 1 ? "PLAYER" : "PLAYERS"}.`);
        break;
      }
      case "kick": {
        if (typeof msg.id !== "string") return;
        if (!game.kick(msg.id, now)) return;
        dropPhone(msg.id, { t: "kicked" }, 4002, "removed");
        safely(() => scores?.markRemoved(msg.id, Date.now()));
        saveDirty = true;
        break;
      }
      case "drawing":
        // The first stroke starts the clock.
        if (!game.beginDrawing(now)) return;
        break;
      case "skipDrawer": {
        const result = game.skipDrawer(now);
        if (result.error) return notice(result.error);
        break;
      }
      case "skipTurn":
        if (!game.skipTurn(now)) return;
        break;
      case "next":
        if (!game.next(now)) return;
        break;
      case "hold":
        game.setHold(msg.on === true);
        break;
      case "end":
        if (!game.end(now)) return;
        break;
      case "lobby":
        game.toLobby();
        break;
      case "clear":
        // Never in the middle of a game.
        if (game.phase !== "lobby" && game.phase !== "results") return notice("END THE GAME FIRST.");
        for (const clientId of [...phones.keys()]) dropPhone(clientId, { t: "kicked" }, 4002, "removed");
        game.clear();
        saveDirty = true;
        break;
      default:
        return;
    }
    changed();
  }

  screenWss.on("connection", (ws) => {
    ws.on("error", () => {});
    screens.add(ws);
    send(ws, { t: "join", ...join, teams: TEAMS, maxPlayers: MAX_PLAYERS });
    send(ws, { t: "state", ...game.screenView(clock()) });
    ws.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }
      if (msg && typeof msg.t === "string") safely(() => handleScreen(ws, msg));
    });
    ws.on("close", () => screens.delete(ws));
  });

  function tick() {
    safely(runTick);
  }

  function runTick() {
    const now = clock();
    if (game.tick(now)) {
      changed();
      return;
    }
    if (screenDirty ? now - lastScreenAt >= SCREEN_EVERY_MS : now - lastScreenAt >= SCREEN_HEARTBEAT_MS) screenState();
  }

  return {
    game,
    phoneCount: () => phones.size,
    // How many players came back from the save file when the server started.
    restored: () => restored,

    // Where phones should go. tunnel: "live" | "starting" | "down" | "missing" | "lan" | "off"
    async setJoin(url, tunnel) {
      const qr = url ? brandedQr(url) : null;
      join = { url, qr, tunnel };
      toScreens({ t: "join", ...join, teams: TEAMS, maxPlayers: MAX_PLAYERS });
    },

    async listen({ phonePort = 3200, phoneHost = "127.0.0.1", screenPort = 3201 } = {}) {
      const ports = {
        phone: await listen(phoneHttp, phonePort, phoneHost),
        screen: await listen(screenHttp, screenPort, "127.0.0.1"),
      };
      timers = [setInterval(pingPhones, pingEveryMs), setInterval(tick, tickMs), setInterval(() => safely(save), SAVE_EVERY_MS)];
      return ports;
    },

    async close() {
      timers.forEach(clearInterval);
      save();
      for (const ws of [...phoneWss.clients, ...screenWss.clients]) ws.terminate();
      phoneWss.close();
      screenWss.close();
      await Promise.all([new Promise((r) => phoneHttp.close(r)), new Promise((r) => screenHttp.close(r))]);
    },
  };
}
