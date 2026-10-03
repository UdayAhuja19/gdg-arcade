// PICTIONARY audit: the edge cases and failure modes, game rules first, then the server with real
// sockets (bad messages, two tabs, a restart, a crash in a handler, too many phones).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { createGame, judge, givesAway, hintCount, keyOf, pattern, MAX_PLAYERS, GUESS_MIN, GUESS_MAX } from "../server/pictionary/game.js";
import { EASY, MEDIUM, HARD, ALIASES } from "../server/pictionary/words.js";
import { createPictionaryServer } from "../server/pictionary/server.js";
import { isBlocked, NAME_MAX } from "../public/js/shared/names.js";

const WORDS = { easy: ["cat", "sun", "dog"], medium: ["elephant", "camel", "pirate"], hard: ["ice cream", "lighthouse", "snow globe"] };
const newGame = (timing = {}) => createGame({ random: () => 0, words: WORDS, timing });
const ids = (n) => Array.from({ length: n }, (_, i) => `p${i}`);
function fill(game, n) {
  for (const id of ids(n)) game.join({ clientId: id, name: id.toUpperCase() }, 0);
}
const team = (game, n, t) => ids(n).filter((id) => game.player(id)?.team === t);
const drawerId = (game, n) => ids(n).find((id) => game.player(id).name === game.screenView(0).turn.drawer);

function drawing(game, n, index = 1) {
  fill(game, n);
  game.start(0);
  game.pick(drawerId(game, n), index, 0);
  game.beginDrawing(0);
}

// ---------------------------------------------------------------- the word list
test("every word works: unique, drawable length, safe, guessable, and never fully hinted", () => {
  const all = [...EASY, ...MEDIUM, ...HARD];
  assert.equal(new Set(all).size, all.length, "no word twice");
  assert.ok(EASY.length >= 60 && MEDIUM.length >= 60 && HARD.length >= 60, "enough words for several games");
  for (const word of all) {
    assert.equal(word, word.toLowerCase().trim(), word);
    assert.match(word, /^[a-z]+( [a-z]+)*$/, `only letters and single spaces: ${word}`);
    assert.ok(word.length <= 24, `fits the projector: ${word}`);
    assert.equal(isBlocked(word), false, `safe: ${word}`);
    assert.equal(judge(word, word), "correct");
    assert.equal(judge(word.toUpperCase().replace(" ", ""), word), "correct", `without the space: ${word}`);
    assert.ok(hintCount(word) < keyOf(word).length / 2 + 1, `hints leave most letters hidden: ${word}`);
  }
});

test("other names count as correct, belong to a real word, and never clash with another word", () => {
  const all = [...EASY, ...MEDIUM, ...HARD];
  const keys = new Set(all.map(keyOf));
  for (const [word, aliases] of Object.entries(ALIASES)) {
    assert.ok(all.includes(word), `alias for a word in the lists: ${word}`);
    for (const alias of aliases) {
      assert.equal(judge(alias, word), "correct", `${alias} for ${word}`);
      assert.equal(judge(alias.toUpperCase(), word), "correct");
      assert.ok(!keys.has(keyOf(alias)), `${alias} is another word's answer`);
      assert.equal(isBlocked(alias), false, `safe: ${alias}`);
    }
  }
  assert.equal(judge("aeroplanes", "airplane"), "close", "a plural of an alias is close, like any plural");
  assert.equal(judge("hamburgr", "burger"), "close", "a typo of an alias is close");
  assert.equal(judge("pizza", "burger"), "wrong");
  assert.equal(givesAway("HAMBURGE", "burger"), true, "a near miss on an alias stays off the projector");
});

// ---------------------------------------------------------------- joining and teams
test("someone joining mid-turn only counts for their team once they guess", () => {
  const game = newGame();
  drawing(game, 12); // 2 per team, red draws
  const [b1, b2] = team(game, 12, 1);
  game.guess(b1, "elephant", 0); // 300
  game.guess(b2, "elephant", 0); // 300
  game.join({ clientId: "late", name: "LATE" }, 1000); // goes to the smallest team online
  const lateTeam = game.player("late").team;
  game.skipTurn(2000);
  const points = game.screenView(2000).turn.teamPoints;
  assert.equal(points[1], 300, "blue averages 300");
  if (lateTeam !== 0) assert.equal(points[lateTeam], 0, "the late joiner's team isn't dragged down or up");
  assert.equal(game.screenView(2000).turn.eligibleTotal, 10, "the late joiner isn't counted");
});

test("a late joiner who guesses does count, and a phone that reconnects isn't counted twice", () => {
  const game = newGame();
  drawing(game, 12);
  const [y1] = team(game, 12, 2);
  game.setConnected(y1, false);
  game.join({ clientId: y1, name: "AGAIN" }, 500);
  assert.equal(game.screenView(500).turn.eligibleTotal, 10);
  game.join({ clientId: "late-red", name: "LATE" }, 1000); // teams are even, so this one goes to red (drawing)
  game.join({ clientId: "late", name: "LATE" }, 1000); // and this one to blue
  assert.equal(game.guess("late-red", "elephant", 1000).status, "drawing-team");
  assert.equal(game.guess("late", "elephant", 1000).status, "correct");
  assert.equal(game.screenView(1000).turn.eligibleTotal, 11);
});

test("duplicate names get a number and stay within the name limit", () => {
  const game = newGame();
  game.join({ clientId: "a", name: "ALI" }, 0);
  game.join({ clientId: "b", name: "ALI" }, 0);
  game.join({ clientId: "c", name: "ALI" }, 0);
  assert.deepEqual(["a", "b", "c"].map((id) => game.player(id).name), ["ALI", "ALI 2", "ALI 3"]);
  game.join({ clientId: "a", name: "ALI" }, 0);
  assert.equal(game.player("a").name, "ALI", "coming back keeps your own name");
  const long = "A".repeat(NAME_MAX);
  game.join({ clientId: "d", name: long }, 0);
  game.join({ clientId: "e", name: long }, 0);
  assert.equal(game.player("e").name.length, NAME_MAX);
  assert.ok(game.player("e").name.endsWith(" 2"));
});

test("the roster is saved and restored: same teams, everyone offline until they reconnect", () => {
  const game = newGame();
  fill(game, 9);
  const saved = game.roster();
  const back = newGame();
  assert.equal(back.restore([...saved, { clientId: "p0", name: "DUP", team: 0 }, { bad: true }, { clientId: "x", name: "X", team: 9 }, null]), 9);
  assert.equal(back.screenView(0).online, 0);
  assert.equal(back.join({ clientId: "p4", name: "P4" }, 0).rejoined, true);
  assert.equal(back.player("p4").team, game.player("p4").team);
  assert.equal(back.restore("nonsense"), 0);
  const full = newGame();
  assert.equal(full.restore(Array.from({ length: MAX_PLAYERS + 20 }, (_, i) => ({ clientId: `r${i}`, name: `R${i}`, team: i % 6 }))), MAX_PLAYERS);
});

// ---------------------------------------------------------------- words and guesses
test("a word the first drawer saw never comes back when the host swaps the drawer", () => {
  const game = newGame();
  fill(game, 12);
  game.start(0);
  const first = drawerId(game, 12);
  game.pick(first, 0, 100); // "cat"
  game.skipDrawer(200);
  const second = drawerId(game, 12);
  assert.notEqual(second, first);
  assert.ok(!game.phoneView(second, 200).turn.choices.includes("cat"));
});

test("wrong guesses that give the answer away stay off the projector", () => {
  const game = newGame();
  drawing(game, 12); // elephant
  const [a] = team(game, 12, 1);
  // Only "wrong" guesses can reach the projector, and only through `shown`.
  const shown = (text, at) => {
    const r = game.guess(a, text, at);
    return r.status === "wrong" ? r.shown : `(${r.status})`;
  };
  assert.equal(shown("elepha", 1000), "(close)", "two letters short: close, so it's private anyway");
  assert.equal(shown("elep", 2000), null, "a chunk of the word");
  assert.equal(shown("elephantine", 3000), null, "the word inside a longer guess");
  assert.equal(shown("elefunt", 4000), null, "a near miss (three letters off: not close, but too helpful to show)");
  assert.equal(shown("giraffe", 5000), "GIRAFFE", "an honest wrong guess still shows");
  assert.equal(givesAway("cream", "ice cream"), true);
  assert.equal(givesAway("cat", "caterpillar"), false, "short guesses that happen to be inside aren't hidden");
  assert.equal(givesAway("dog", "elephant"), false);
});

test("words aren't repeated in a game until the list runs out", () => {
  const game = createGame({ random: () => 0.5, words: WORDS, timing: { revealMs: 0 } });
  fill(game, 6);
  game.setSettings({ rounds: 1 });
  game.start(0);
  const seen = [];
  let now = 0;
  while (game.phase !== "results") {
    const id = drawerId(game, 6);
    const view = game.phoneView(id, now).turn;
    for (const w of view.choices) seen.push(w);
    game.pick(id, 0, now);
    game.skipTurn(now);
    now += 10;
    game.tick(now);
  }
  // 6 turns × 3 choices from 9 words: the first 3 turns can't repeat anything.
  assert.equal(new Set(seen.slice(0, 9)).size, 9);
});

test("points fall from 300 to 100 over the turn, never outside that", () => {
  const game = newGame();
  drawing(game, 12);
  const [a, b] = team(game, 12, 1);
  assert.equal(game.guess(a, "elephant", 0).points, GUESS_MAX);
  assert.equal(game.guess(b, "elephant", 80_000 - 1).points, GUESS_MIN);
});

test("guesses and picks at the wrong moment are refused", () => {
  const game = newGame();
  fill(game, 12);
  game.start(0);
  const [b] = team(game, 12, 1);
  assert.equal(game.guess(b, "cat", 0).status, "not-now", "before the drawing");
  assert.equal(game.pick(b, 0, 0).status, "not-now", "only the drawer picks");
  game.tick(15_000); // picked for them
  assert.equal(game.pick(drawerId(game, 12), 1, 15_001).status, "not-now", "too late to pick");
  game.beginDrawing(16_000);
  assert.equal(game.beginDrawing(16_001), false, "the clock only starts once");
  game.skipTurn(17_000);
  assert.equal(game.guess(b, "cat", 17_100).status, "not-now", "after the reveal");
  assert.equal(game.guess("nobody", "cat", 17_100).status, "ignored");
  assert.equal(game.setSettings({ rounds: 3 }), false, "settings only between games");
});

test("hints never show every letter, even for the shortest words", () => {
  for (const word of [...EASY, ...MEDIUM, ...HARD]) {
    const letters = [...word].map((c, i) => (c === " " ? -1 : i)).filter((i) => i >= 0);
    const shown = pattern(word, letters.slice(0, hintCount(word)));
    assert.ok(shown.includes("_"), word);
  }
});

// ---------------------------------------------------------------- people leaving
test("a removed guesser still counts for their team; a removed drawer mid-drawing changes nothing", () => {
  const game = newGame();
  drawing(game, 12);
  const [b1, b2] = team(game, 12, 1);
  game.guess(b1, "elephant", 0);
  game.kick(b1, 1000);
  game.kick(drawerId(game, 12) ?? "none", 1000);
  assert.equal(game.phase, "draw");
  game.skipTurn(2000);
  assert.equal(game.screenView(2000).turn.teamPoints[1], 150, "(300 + 0) / 2 with the removed player");
  assert.ok(b2);
});

test("when only one team is left online, the game ends at the next turn", () => {
  const game = newGame({ revealMs: 0 });
  drawing(game, 6);
  for (const id of ids(6).slice(1)) game.setConnected(id, false);
  game.skipTurn(1000);
  game.tick(1000);
  assert.equal(game.phase, "results");
});

test("ending during the word pick: results with no turn played; play again starts clean", () => {
  const game = newGame();
  fill(game, 12);
  game.start(0);
  game.end(10);
  assert.equal(game.screenView(10).results.turns, 0);
  assert.ok(game.screenView(10).results.ranking.every((r) => r.rank === 1), "all tied on 0");
  assert.deepEqual(game.start(20), { ok: true });
  assert.equal(game.screenView(20).turn.number, 1);
  assert.ok(game.screenView(20).teams.every((t) => t.score === 0));
});

test("the drawer's team can't be the only one: a solo team can't start a game", () => {
  const game = newGame();
  game.join({ clientId: "solo-1", name: "A" }, 0);
  game.join({ clientId: "solo-2", name: "B" }, 0);
  game.setConnected("solo-2", false);
  assert.deepEqual(game.start(0), { error: "NEED PLAYERS IN AT LEAST 2 TEAMS." });
});

// ---------------------------------------------------------------- the server, with real sockets
function open(url, options) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, options);
    ws.messages = [];
    ws.on("message", (data) => ws.messages.push(JSON.parse(data)));
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await wait(10);
  }
}
const last = (ws, t) => [...ws.messages].reverse().find((m) => m.t === t);
const send = (ws, msg) => ws.send(typeof msg === "string" ? msg : JSON.stringify(msg));
const closed = (ws) => new Promise((resolve) => ws.once("close", (code) => resolve(code)));

async function boot(options = {}) {
  const server = createPictionaryServer({ tickMs: 20, ...options });
  const ports = await server.listen({ phonePort: 0, screenPort: 0 });
  const phoneUrl = `ws://127.0.0.1:${ports.phone}/ws`;
  const screen = await open(`ws://127.0.0.1:${ports.screen}/ws`, { origin: `http://127.0.0.1:${ports.screen}` });
  const phone = async (id, name = id) => {
    const ws = await open(phoneUrl);
    send(ws, { t: "join", clientId: `phone-${id}`, name });
    await until(() => last(ws, "joined"));
    return ws;
  };
  return { server, ports, phoneUrl, screen, phone };
}

test("bad messages: not JSON, binary, too big, unknown types, and host commands from a phone", async () => {
  const { server, screen, phone, phoneUrl } = await boot();
  try {
    const a = await phone("aaaaaaa1");
    const b = await phone("bbbbbbb2");
    for (const t of ["start", "kick", "drawing", "end", "clear", "settings"]) send(a, { t, id: "phone-bbbbbbb2", rounds: 3 });
    send(a, { t: "nonsense" });
    send(a, { t: "guess", text: { not: "a string" }, turn: 1, seq: 1 });
    await wait(100);
    assert.equal(server.game.phase, "lobby", "a phone can't start the game");
    assert.equal(server.game.player("phone-bbbbbbb2").connected, true, "or remove anyone");
    assert.equal(server.game.settings.rounds, 2);

    const notJson = await open(phoneUrl);
    const c1 = closed(notJson);
    send(notJson, "{not json");
    assert.equal(await c1, 1007);
    const binary = await open(phoneUrl);
    const c2 = closed(binary);
    binary.send(Buffer.from([1, 2, 3]));
    assert.equal(await c2, 1008);
    const big = await open(phoneUrl);
    const c3 = closed(big);
    send(big, { t: "guess", text: "x".repeat(2000) });
    assert.equal(await c3, 1009);
    const badId = await open(phoneUrl);
    send(badId, { t: "join", clientId: "short", name: "OK" });
    await until(() => last(badId, "error"));
    assert.equal(server.game.size, 2);
    [a, b, badId].forEach((ws) => ws.close());
  } finally {
    screen.close();
    await server.close();
  }
});

test("the same phone in a second tab takes over; the first is told with code 4001", async () => {
  const { server, screen, phone } = await boot();
  try {
    const first = await phone("samephone1");
    const gone = closed(first);
    const second = await phone("samephone1");
    assert.equal(await gone, 4001);
    await wait(50);
    assert.equal(server.game.player("phone-samephone1").connected, true, "still online through the new tab");
    assert.equal(server.phoneCount(), 1);
    second.close();
  } finally {
    screen.close();
    await server.close();
  }
});

test("a guess for an earlier turn doesn't count", async () => {
  const { server, screen, phone } = await boot();
  try {
    const phones = [];
    for (let i = 0; i < 6; i += 1) phones.push(await phone(`turnpho${i}`));
    send(screen, { t: "start" });
    await until(() => server.game.phase === "pick");
    const turn = server.game.turnNumber;
    send(screen, { t: "skipTurn" });
    send(screen, { t: "next" });
    await until(() => server.game.turnNumber === turn + 1);
    const guesser = phones.find((_, i) => server.game.player(`phone-turnpho${i}`).team !== server.game.screenView(0).turn.team);
    send(guesser, { t: "guess", text: "anything", turn, seq: 7 });
    const ack = await until(() => guesser.messages.find((m) => m.t === "guessed" && m.seq === 7));
    assert.equal(ack.status, "not-now");
    phones.forEach((ws) => ws.close());
  } finally {
    screen.close();
    await server.close();
  }
});

test("a bug in one message doesn't stop the game for everyone", async () => {
  const { server, screen, phone } = await boot();
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  try {
    const a = await phone("crashpho1");
    const join = server.game.join;
    server.game.join = (...args) => {
      if (args[0].name === "CRASH") throw new Error("boom");
      return join(...args);
    };
    const crasher = new WebSocket(a.url);
    await new Promise((r) => crasher.once("open", r));
    send(crasher, { t: "join", clientId: "phone-crashpho9", name: "crash" });
    await until(() => errors.length > 0);
    const b = await phone("crashpho2");
    assert.ok(last(b, "joined"), "the server still answers");
    assert.ok(errors[0].includes("boom"));
    [a, b, crasher].forEach((ws) => ws.close());
  } finally {
    console.error = original;
    screen.close();
    await server.close();
  }
});

test("removing a player tells their phone (4002) and frees the name", async () => {
  const { server, screen, phone } = await boot();
  try {
    const a = await phone("kickpho1", "ALI");
    const b = await phone("kickpho2", "ALI");
    assert.equal(last(b, "joined").name, "ALI 2");
    const gone = closed(a);
    send(screen, { t: "kick", id: "phone-kickpho1" });
    assert.equal(await gone, 4002);
    assert.ok(a.messages.some((m) => m.t === "kicked"));
    assert.equal(server.game.player("phone-kickpho1"), null);
    b.close();
  } finally {
    screen.close();
    await server.close();
  }
});

test("teams survive a restart through the save file; an old or broken save is ignored", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pictionary-"));
  const savePath = path.join(dir, "teams.json");
  try {
    const one = await boot({ savePath });
    const phones = [];
    for (let i = 0; i < 4; i += 1) phones.push(await one.phone(`savepho${i}`));
    const teams = [0, 1, 2, 3].map((i) => one.server.game.player(`phone-savepho${i}`).team);
    phones.forEach((ws) => ws.close());
    one.screen.close();
    await one.server.close();
    assert.equal(JSON.parse(fs.readFileSync(savePath, "utf8")).players.length, 4);

    const two = await boot({ savePath });
    assert.equal(two.server.restored(), 4);
    const back = await open(two.phoneUrl);
    send(back, { t: "join", clientId: "phone-savepho2", name: "SAVEPHO2", rejoin: true });
    const joined = await until(() => last(back, "joined"));
    assert.equal(joined.team, teams[2]);
    assert.equal(joined.rejoined, true);
    // REMOVE EVERYONE empties the save too.
    send(two.screen, { t: "clear" });
    await until(() => two.server.game.size === 0);
    back.close();
    two.screen.close();
    await two.server.close();
    assert.equal(JSON.parse(fs.readFileSync(savePath, "utf8")).players.length, 0);

    fs.writeFileSync(savePath, "{ broken");
    const three = await boot({ savePath });
    assert.equal(three.server.restored(), 0);
    three.screen.close();
    await three.server.close();

    fs.writeFileSync(savePath, JSON.stringify({ players: [{ clientId: "phone-old00001", name: "OLD", team: 0 }] }));
    const old = new Date(Date.now() - 13 * 60 * 60 * 1000);
    fs.utimesSync(savePath, old, old);
    const four = await boot({ savePath });
    assert.equal(four.server.restored(), 0, "a save from another day is ignored");
    four.screen.close();
    await four.server.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test(`more sockets than ${MAX_PLAYERS} + 50 are refused, so the laptop can't be swamped`, async () => {
  const { server, screen, phoneUrl } = await boot();
  try {
    const sockets = await Promise.all(Array.from({ length: MAX_PLAYERS + 50 }, () => open(phoneUrl)));
    const extra = await open(phoneUrl);
    assert.equal(await closed(extra), 1006, "terminated straight away");
    sockets.forEach((ws) => ws.close());
  } finally {
    screen.close();
    await server.close();
  }
});

test("REMOVE EVERYONE is refused in the middle of a game", async () => {
  const { server, screen, phone } = await boot();
  const original = console.log;
  console.log = () => {};
  try {
    const a = await phone("clearpho1");
    const b = await phone("clearpho2");
    send(screen, { t: "start" });
    await until(() => server.game.phase === "pick");
    send(screen, { t: "clear" });
    const notice = await until(() => screen.messages.find((m) => m.t === "notice"));
    assert.equal(notice.message, "END THE GAME FIRST.");
    assert.equal(server.game.size, 2);
    send(screen, { t: "end" });
    send(screen, { t: "clear" });
    await until(() => server.game.size === 0);
    [a, b].forEach((ws) => ws.close());
  } finally {
    console.log = original;
    screen.close();
    await server.close();
  }
});
