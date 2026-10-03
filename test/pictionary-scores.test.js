// The hello, world! scoreboard (server/pictionary/scores.js) and its page's API on the projector port.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openScores } from "../server/pictionary/scores.js";
import { createPictionaryServer } from "../server/pictionary/server.js";

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gdg-scores-")), "scores.db");
const ROSTER = [
  { clientId: "a", name: "AISHA", team: 0 },
  { clientId: "b", name: "OMAR", team: 1 },
  { clientId: "c", name: "SARA", team: 0 },
];

test("the tally adds, edits and deletes rows, and totals every team", async () => {
  const s = await openScores(":memory:");
  const pic = s.addTally({ label: " pictionary ", points: [300, 250, 0, 120, 90, 10] }, 1);
  const feud = s.addTally({ label: "Family Feud", points: [100, 0, 50, 0, 0, 200] }, 2);
  let snap = s.snapshot();
  assert.deepEqual(snap.tally.map((r) => r.label), ["PICTIONARY", "FAMILY FEUD"]);
  assert.deepEqual(snap.totals, [400, 250, 50, 120, 90, 210]);

  assert.deepEqual(s.updateTally(feud.id, { label: "FAMILY FEUD", points: [100, 0, 50, 0, 0, 20] }, 3), { id: feud.id });
  assert.deepEqual(s.snapshot().totals, [400, 250, 50, 120, 90, 30]);

  assert.deepEqual(s.deleteTally(pic.id), { id: pic.id });
  snap = s.snapshot();
  assert.deepEqual(snap.tally.map((r) => r.label), ["FAMILY FEUD"]);
  assert.deepEqual(snap.totals, [100, 0, 50, 0, 0, 20]);
  assert.equal(s.deleteTally(pic.id).error, "THAT ROW IS GONE.");
});

test("a tally row needs a name and a whole number for every team", async () => {
  const s = await openScores(":memory:");
  assert.equal(s.addTally({ label: "", points: [0, 0, 0, 0, 0, 0] }, 1).error, "NAME THE GAME.");
  assert.equal(s.addTally({ label: "X".repeat(41), points: [0, 0, 0, 0, 0, 0] }, 1).error, "KEEP THE NAME UNDER 40 LETTERS.");
  assert.equal(s.addTally({ label: "FEUD", points: [1, 2, 3] }, 1).error, "GIVE EVERY TEAM A SCORE.");
  assert.equal(s.addTally({ label: "FEUD", points: [1, 2, 3, 4, 5, 1.5] }, 1).error, "SCORES MUST BE WHOLE NUMBERS.");
  assert.equal(s.addTally({ label: "FEUD", points: [1, 2, 3, 4, 5, "6"] }, 1).error, "SCORES MUST BE WHOLE NUMBERS.");
  assert.equal(s.snapshot().tally.length, 0);
});

test("the teams stay on record after REMOVE EVERYONE; a player removed by name leaves their team", async () => {
  const s = await openScores(":memory:");
  s.recordRoster(ROSTER, 1);
  s.recordRoster([], 2); // the host pressed REMOVE EVERYONE
  assert.deepEqual(s.snapshot().teams.map((t) => t.members), [["AISHA", "SARA"], ["OMAR"], [], [], [], []]);
  s.markRemoved("c", 3);
  assert.deepEqual(s.snapshot().teams[0].members, ["AISHA"]);
  // Moved by BALANCE TEAMS: the latest team counts.
  s.recordRoster([{ clientId: "a", name: "AISHA", team: 4 }], 4);
  assert.deepEqual(s.snapshot().teams.map((t) => t.members), [[], ["OMAR"], [], [], ["AISHA"], []]);
});

test("a finished game is saved once, and the record survives reopening the file", async () => {
  const file = tmpFile();
  let s = await openScores(file);
  const game = { id: 42, endedAt: 1000, turns: 12, settings: { rounds: 2 }, ranking: [{ team: 1, score: 500, rank: 1 }, { team: 0, score: 300, rank: 2 }], top: [{ name: "OMAR", team: 1, points: 290 }] };
  s.recordGame(game);
  s.recordGame({ ...game, ranking: [{ team: 0, score: 999, rank: 1 }] });
  s.recordRoster(ROSTER, 1);
  s.addTally({ label: "FAMILY FEUD", points: [1, 2, 3, 4, 5, 6] }, 1);
  s.close();

  s = await openScores(file);
  const snap = s.snapshot();
  assert.equal(snap.games.length, 1);
  assert.deepEqual(snap.games[0].ranking, [{ team: 1, score: 500, rank: 1 }, { team: 0, score: 300, rank: 2 }]);
  assert.deepEqual(snap.games[0].top, [{ name: "OMAR", team: 1, points: 290 }]);
  assert.equal(snap.teams[0].members.length, 2);
  assert.deepEqual(snap.totals, [1, 2, 3, 4, 5, 6]);
  const csv = s.csv();
  assert.match(csv, /^TALLY\nGAME,RED,BLUE,YELLOW,GREEN,BLACK,WHITE\nFAMILY FEUD,1,2,3,4,5,6\nTOTAL,1,2,3,4,5,6\n/);
  assert.match(csv, /\nRED,AISHA\n/);
  s.close();
});

test("the scores page's API: reads, writes from the page itself, and nothing from another site", async () => {
  const scores = await openScores(":memory:");
  const server = createPictionaryServer({ scores, tickMs: 50, pingEveryMs: 1000 });
  const { screen } = await server.listen({ phonePort: 0, screenPort: 0 });
  const base = `http://localhost:${screen}`;
  const json = { "Content-Type": "application/json", Origin: base };
  try {
    const page = await fetch(`${base}/scores`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<title>SCORES/);

    let res = await fetch(`${base}/api/tally`, { method: "POST", headers: json, body: JSON.stringify({ label: "family feud", points: [10, 20, 0, 0, 0, 5] }) });
    assert.equal(res.status, 200);
    const added = await res.json();
    assert.deepEqual(added.totals, [10, 20, 0, 0, 0, 5]);

    res = await fetch(`${base}/api/tally/${added.id}`, { method: "PUT", headers: json, body: JSON.stringify({ label: "FAMILY FEUD", points: [10, 20, 0, 0, 0, 50] }) });
    assert.deepEqual((await res.json()).totals, [10, 20, 0, 0, 0, 50]);

    res = await fetch(`${base}/api/tally`, { method: "POST", headers: json, body: JSON.stringify({ label: "", points: [] }) });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, "NAME THE GAME.");

    // Another website open in the same browser can't change the tally.
    res = await fetch(`${base}/api/tally`, { method: "POST", headers: { ...json, Origin: "https://evil.example" }, body: JSON.stringify({ label: "X", points: [1, 1, 1, 1, 1, 1] }) });
    assert.equal(res.status, 403);
    res = await fetch(`${base}/api/tally/${added.id}`, { method: "DELETE" });
    assert.equal(res.status, 403, "no Origin header: refused");
    res = await fetch(`${base}/api/tally`, { method: "POST", headers: { Origin: base, "Content-Type": "text/plain" }, body: JSON.stringify({ label: "X", points: [1, 1, 1, 1, 1, 1] }) });
    assert.equal(res.status, 415, "a plain form post isn't JSON");

    res = await fetch(`${base}/api/scores.csv`);
    assert.match(res.headers.get("content-disposition"), /hello-world-scores\.csv/);
    assert.match(await res.text(), /FAMILY FEUD,10,20,0,0,0,50/);

    res = await fetch(`${base}/api/tally/${added.id}`, { method: "DELETE", headers: { Origin: base } });
    assert.deepEqual((await res.json()).tally, []);
  } finally {
    await server.close();
    scores.close();
  }
});

test("the phone port has no scores page or API", async () => {
  const scores = await openScores(":memory:");
  const server = createPictionaryServer({ scores, tickMs: 50, pingEveryMs: 1000 });
  const { phone } = await server.listen({ phonePort: 0, screenPort: 0 });
  try {
    assert.equal((await fetch(`http://localhost:${phone}/scores`)).status, 404);
    assert.equal((await fetch(`http://localhost:${phone}/api/scores`)).status, 404);
  } finally {
    await server.close();
    scores.close();
  }
});

test("a real game's teams and results land in the scoreboard by themselves", { timeout: 15_000 }, async () => {
  const { default: WebSocket } = await import("ws");
  const scores = await openScores(":memory:");
  const server = createPictionaryServer({ scores, timing: { pickMs: 300, readyMs: 300, revealMs: 200 }, tickMs: 20, pingEveryMs: 1000 });
  const ports = await server.listen({ phonePort: 0, screenPort: 0 });
  const open = (url, options) =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(url, options);
      ws.once("open", () => resolve(ws));
      ws.once("error", reject);
    });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    const screen = await open(`ws://127.0.0.1:${ports.screen}/ws`, { origin: `http://127.0.0.1:${ports.screen}` });
    const phones = await Promise.all(Array.from({ length: 4 }, () => open(`ws://127.0.0.1:${ports.phone}/ws`)));
    phones.forEach((ws, i) => ws.send(JSON.stringify({ t: "join", clientId: `phone-000${i}-abcd`, name: `PLAYER ${i}` })));
    await wait(1300); // the roster is written to the scoreboard once a second
    assert.equal(scores.snapshot().teams.reduce((n, t) => n + t.members.length, 0), 4);

    screen.send(JSON.stringify({ t: "start" }));
    await wait(200);
    screen.send(JSON.stringify({ t: "end" }));
    await wait(200);
    const { games } = scores.snapshot();
    assert.equal(games.length, 1, "the finished game was saved");
    assert.equal(games[0].ranking.length > 0, true);
    for (const ws of [screen, ...phones]) ws.close();
  } finally {
    await server.close();
    scores.close();
  }
});
