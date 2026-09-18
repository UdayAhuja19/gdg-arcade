// API tests against a throwaway database (gdg_arcade_test).
// They skip themselves if MySQL isn't reachable with the .env credentials.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

process.env.DB_NAME = "gdg_arcade_test";
process.env.ADMIN_PIN = "4321";

const { createApp } = await import("../server/app.js");
const { getPool, closePool } = await import("../server/db.js");

let db = null;
let server = null;
let base = "";

before(async () => {
  db = await getPool();
  if (!db) return;
  await db.query("DELETE FROM runs");
  await db.query("DELETE FROM players");
  server = createApp().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server?.close();
  if (db) await db.query("DROP DATABASE IF EXISTS gdg_arcade_test");
  await closePool();
});

async function call(method, path, body, headers = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

const needsDb = (name, fn) =>
  test(name, async (t) => {
    if (!db) return t.skip("MySQL not reachable: fill in .env to run API tests");
    await fn();
  });

needsDb("the same name in any case is one player", async () => {
  const a = await call("POST", "/api/players", { name: "Sara K" });
  const b = await call("POST", "/api/players", { name: "  sara   k" });
  assert.equal(a.status, 200);
  assert.equal(a.body.player.name, "SARA K");
  assert.equal(b.body.player.id, a.body.player.id);
});

needsDb("a name in use is reported, in any case", async () => {
  const exists = async (name) => (await call("GET", `/api/players/exists?name=${encodeURIComponent(name)}`)).body.exists;
  assert.equal(await exists("Taken Name"), false);
  await call("POST", "/api/players", { name: "Taken Name" });
  assert.equal(await exists("  taken   NAME"), true);
  assert.equal(await exists("Taken"), false);
  assert.equal((await call("GET", "/api/players/exists?name=x")).status, 422);
});

needsDb("bad names are refused", async () => {
  assert.equal((await call("POST", "/api/players", { name: "x" })).status, 422);
  assert.equal((await call("POST", "/api/players", { name: "f.u.c.k" })).status, 422);
});

needsDb("a normal score saves once", async () => {
  const { body: { player } } = await call("POST", "/api/players", { name: "Runner" });
  const run = (await call("POST", "/api/runs", { playerId: player.id, game: "dino" })).body;
  const done = await call("POST", `/api/runs/${run.runId}/finish`, { token: run.token, score: 50 });
  assert.equal(done.status, 200);
  assert.equal(done.body.isNewBest, true);
  assert.equal(done.body.rank, 1);
  assert.equal(done.body.top3[0].name, "RUNNER");

  const again = await call("POST", `/api/runs/${run.runId}/finish`, { token: run.token, score: 60 });
  assert.equal(again.status, 409);
});

needsDb("a score that arrives too fast is refused and the run is closed", async () => {
  const { body: { player } } = await call("POST", "/api/players", { name: "Speedy" });
  const run = (await call("POST", "/api/runs", { playerId: player.id, game: "dino" })).body;
  const cheat = await call("POST", `/api/runs/${run.runId}/finish`, { token: run.token, score: 5000 });
  assert.equal(cheat.status, 422);
  const retry = await call("POST", `/api/runs/${run.runId}/finish`, { token: run.token, score: 10 });
  assert.equal(retry.status, 409);
});

needsDb("a wrong token can't finish someone else's run", async () => {
  const { body: { player } } = await call("POST", "/api/players", { name: "Owner" });
  const run = (await call("POST", "/api/runs", { playerId: player.id, game: "snake" })).body;
  const res = await call("POST", `/api/runs/${run.runId}/finish`, { token: "0".repeat(48), score: 10 });
  assert.equal(res.status, 404);
});

needsDb("leaderboard shows each player's best, earliest wins ties, top 3 only", async () => {
  const ids = {};
  for (const name of ["ALPHA", "BRAVO", "CHARLIE", "DELTA", "ECHO"]) {
    const [r] = await db.execute("INSERT INTO players (name, name_key) VALUES (?, ?)", [name, name.toLowerCase()]);
    ids[name] = r.insertId;
  }
  const rows = [
    ["ALPHA", 100, "2026-09-20 10:00:00", 0],
    ["ALPHA", 300, "2026-09-20 10:05:00", 0],
    ["BRAVO", 300, "2026-09-20 10:01:00", 0],
    ["CHARLIE", 200, "2026-09-20 10:02:00", 0],
    ["DELTA", 50, "2026-09-20 10:03:00", 0],
    ["ECHO", 999, "2026-09-20 10:04:00", 1],
  ];
  for (const [name, score, at, hidden] of rows) {
    await db.execute(
      "INSERT INTO runs (player_id, game, token, score, started_at, finished_at, hidden) VALUES (?, 'flappy', ?, ?, ?, ?, ?)",
      [ids[name], "t".repeat(48), score, at, at, hidden]
    );
  }

  const { body } = await call("GET", `/api/leaderboard?game=flappy&playerId=${ids.DELTA}`);
  assert.deepEqual(
    body.top3.map((r) => [r.name, r.score]),
    [["BRAVO", 300], ["ALPHA", 300], ["CHARLIE", 200]]
  );
  assert.deepEqual(body.me, { best: 50, rank: 4 });

  const all = await call("GET", "/api/leaderboard");
  assert.equal(all.body.boards.flappy.length, 3);
  assert.deepEqual(Object.keys(all.body.boards).sort(), ["dino", "flappy", "memory", "snake", "stack"]);
});

needsDb("admin needs the PIN and hiding a player removes them from the board", async () => {
  assert.equal((await call("GET", "/api/admin/overview")).status, 401);
  const pin = { "x-admin-pin": "4321" };
  const overview = await call("GET", "/api/admin/overview", null, pin);
  assert.equal(overview.status, 200);

  const board = (await call("GET", "/api/leaderboard?game=flappy")).body.top3;
  const bravo = board[0];
  assert.equal((await call("POST", `/api/admin/players/${bravo.playerId}/hide`, {}, pin)).status, 200);
  const after = (await call("GET", "/api/leaderboard?game=flappy")).body.top3;
  assert.equal(after[0].name, "ALPHA");
  assert.ok(!after.some((r) => r.name === "BRAVO"));

  assert.equal((await call("POST", "/api/admin/reset", { confirm: "nope" }, pin)).status, 400);
});
