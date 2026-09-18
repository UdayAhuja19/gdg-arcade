// The big screen for the party. The lobby is built for the people watching: the next game's
// name, a big QR code, a preview of the game playing itself and a seat per player. STATS
// swaps in the connection numbers for each phone. Rounds of MASH BATTLE, SNAKE ROYALE or SPLIT
// SECOND play over the lobby.
import { fmt, isBullseye, signed } from "../../js/shared/split-second.js";
import { legText as lightsLegText, fmt as fmtReaction } from "../../js/shared/lights-out.js";
import { createLobbyDemo } from "./lobby-demo.js";
import { createSnakeBoard } from "./snake-board.js";

const $ = (id) => document.getElementById(id);
const playersEl = $("players");
const playerTpl = $("player-tpl");
const emptyTpl = $("empty-tpl");

// Each slot's brand shape peeks from behind its card.
const SHAPES = { red: "circle", blue: "flower", yellow: "blob", green: "triangle", black: "capsule" };
const SLOT_COLORS = ["red", "blue", "yellow", "green", "black"];
const NETWORK_LABEL = { wifi: "WI-FI", cellular: "MOBILE DATA", unknown: "NETWORK ?" };
const SPARK_MAX_MS = 500;
const RECONNECT_MS = 1000;

const TUNNEL_TEXT = {
  live: "",
  starting: "STARTING THE TUNNEL…",
  down: "THE TUNNEL DROPPED. GETTING A NEW LINK…",
  missing: "CLOUDFLARED ISN'T INSTALLED. RUN: BREW INSTALL CLOUDFLARED",
  lan: "SAME WI-FI ONLY. NO TUNNEL.",
  off: "THIS LAPTOP ONLY. OPEN THE LINK IN NEW BROWSER WINDOWS, SIDE BY SIDE.",
  stopped: "",
};

let ws = null;
let maxPlayers = 5;
let presentCount = 0;
// Whether each slot's phone is connected right now, for the snake legend.
let connectedSlots = [];
let noticeUntil = 0;
const GO_SHOWN_MS = 800;
// slot -> { el, key }, so a card is only rebuilt when a different player takes the slot
const cards = [];

// ---------- Join panel ----------
function renderJoin(msg) {
  maxPlayers = msg.maxPlayers ?? maxPlayers;
  const qr = $("qr");
  const url = $("join-url");
  if (msg.qr) {
    qr.innerHTML = msg.qr;
    qr.querySelector("svg")?.setAttribute("aria-hidden", "true");
    qr.hidden = false;
  } else {
    qr.replaceChildren();
    qr.hidden = true;
  }
  url.hidden = !msg.url;
  url.textContent = msg.url ? msg.url.replace(/^https?:\/\//, "").toUpperCase() : "";
  const status = $("join-status");
  status.textContent = TUNNEL_TEXT[msg.tunnel] ?? "";
  status.hidden = !status.textContent;
  status.dataset.tunnel = msg.tunnel;
}

// ---------- Player cards ----------
function field(el, name, value) {
  const node = el.querySelector(`[data-f="${name}"]`);
  const text = String(value);
  if (node && node.textContent !== text) node.textContent = text;
}

function emptyCard(slot) {
  const el = emptyTpl.content.firstElementChild.cloneNode(true);
  el.dataset.color = SLOT_COLORS[slot];
  el.querySelector(".player__badge").textContent = slot + 1;
  field(el, "n", slot + 1);
  return el;
}

function playerCard(p) {
  const el = playerTpl.content.firstElementChild.cloneNode(true);
  el.dataset.color = p.color;
  el.querySelector(".player__badge").textContent = p.slot + 1;
  el.querySelector(".player__peek use").setAttribute("href", `assets/shapes.svg#${SHAPES[p.color]}`);
  el.querySelector(".player__kick").addEventListener("click", () => {
    send({ t: "kick", slot: p.slot });
  });
  return el;
}

function sparkline(svg, pings) {
  const bars = pings.map((ms, i) => {
    const h = Math.max(2, Math.round((Math.min(ms, SPARK_MAX_MS) / SPARK_MAX_MS) * 40));
    const cls = ms > 250 ? ' class="spark__slow"' : "";
    return `<rect${cls} x="${i * 10 + 1}" y="${40 - h}" width="8" height="${h}" rx="2"/>`;
  });
  svg.innerHTML = bars.join("");
}

function updateCard(el, p) {
  el.querySelector(".player__name").textContent = p.name;
  el.querySelector(".player__net").textContent = NETWORK_LABEL[p.network] ?? NETWORK_LABEL.unknown;
  el.classList.toggle("is-down", !p.connected);

  field(el, "ping", p.connected && p.ping != null ? p.ping : "—");
  field(el, "median", p.median ?? "—");
  field(el, "p95", p.p95 ?? "—");
  field(el, "ups", p.connected && !p.paused ? `${p.updatesPerSec}/10` : "—");
  field(el, "stutters", p.stutters);
  field(el, "missed", p.missedPings);
  field(el, "rejoins", p.reconnects);
  field(el, "taps", p.taps);

  const verdict =
    p.verdict === "RECONNECTING" ? `RECONNECTING… ${Math.ceil((p.rejoinInMs ?? 0) / 1000)}S` : p.verdict;
  field(el, "verdict", verdict);
  el.querySelector(".player__verdict").dataset.verdict = p.verdict;

  const key = p.recentPings.join(",");
  const spark = el.querySelector(".spark");
  if (spark.dataset.key !== key) {
    spark.dataset.key = key;
    sparkline(spark, p.recentPings);
  }
}

function renderPlayers(players) {
  for (let slot = 0; slot < maxPlayers; slot += 1) {
    const p = players[slot] ?? null;
    // A new player in the slot gets a fresh card (and a fresh pop-in).
    const key = p ? `${p.joinedAt}:${p.name}` : "empty";
    let card = cards[slot];
    if (!card || card.key !== key) {
      const el = p ? playerCard(p) : emptyCard(slot);
      if (p) el.classList.add("pop-in");
      if (card) card.el.replaceWith(el);
      else playersEl.append(el);
      card = { el, key };
      cards[slot] = card;
    }
    if (p) updateCard(card.el, p);
  }

  presentCount = players.filter((p) => p?.connected).length;
  connectedSlots = players.map((p) => Boolean(p?.connected));
  const open = players.filter((p) => p === null).length;
  $("slots-left").textContent =
    open === 0 ? "PARTY FULL · NEXT ROUND SOON" : `${open} ${open === 1 ? "SEAT" : "SEATS"} OPEN`;
}

// ---------- Rounds ----------
const GAME_NAMES = { tap: "MASH BATTLE", snake: "SNAKE ROYALE", split: "SPLIT SECOND", lights: "LIGHTS OUT" };
const COUNTDOWN_RULES = {
  tap: "USE EVERY FINGER. THE FULLER YOUR BAR, THE FASTER IT DRAINS. FIRST TO FILL IT WINS.",
  split: "3 ROUNDS. HIT THE TARGET TIME WITH THE NUMBERS HIDDEN. LOWEST TOTAL ERROR WINS.",
  lights: "3 STARTS. FIVE RED LIGHTS, THEN LIGHTS OUT: TAP. FASTEST TOTAL WINS. JUMP STARTS COST 1.000.",
};
const COLOR_NAMES = { red: "RED", blue: "BLUE", yellow: "YELLOW", green: "GREEN", black: "BLACK" };

function roundPillText(r) {
  const players = `${presentCount} ${presentCount === 1 ? "PLAYER" : "PLAYERS"}`;
  switch (r.phase) {
    case "countdown":
      return `ROUND ${r.number} · GET READY`;
    case "playing":
      if (r.game === "snake") {
        if (r.over) return `ROUND ${r.number} · ${r.winner ? `${r.winner} WINS!` : r.draw ? "DRAW!" : "GAME OVER"}`;
        return `ROUND ${r.number} · ${r.alive} ALIVE`;
      }
      if (r.game === "lights") return `ROUND ${r.number} · START ${r.leg + 1} OF ${r.legs}`;
      if (r.game === "split") {
        const leg = `${r.leg + 1} OF ${r.legs}`;
        if (r.stage === "run") return `ROUND ${r.number} · ${leg} · ${Math.ceil(r.endsInMs / 1000)}S LEFT`;
        return `ROUND ${r.number} · ${leg}`;
      }
      if (r.winner) return `ROUND ${r.number} · ${r.winner} FILLED IT!`;
      return r.endsInMs > 0 ? `ROUND ${r.number} · ${Math.ceil(r.endsInMs / 1000)}S LEFT` : `ROUND ${r.number} · TIME!`;
    case "results":
      return `ROUND ${r.number} · RESULTS`;
    default:
      return `LOBBY · ${players}`;
  }
}

const barText = (entry) =>
  entry.finishMs !== null ? `FULL IN ${(entry.finishMs / 1000).toFixed(1)}S` : `${Math.round(entry.level)}%`;

const clockText = (ms) => {
  const sec = Math.floor(ms / 1000);
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
};

// Under the name on a SNAKE ROYALE result row.
function snakeDetail(entry, aliveCount) {
  if (entry.alive) return aliveCount === 1 ? "LAST ONE STANDING" : "STILL ALIVE";
  return `OUT AT ${clockText(entry.outAtMs ?? 0)}`;
}

// What happened to a snake, for the legend: "HIT THE WALL", "RAN INTO BLUE", …
function causeText(cause) {
  const other = COLOR_NAMES[cause?.color] ?? "A SNAKE";
  switch (cause?.type) {
    case "wall":
      return "HIT THE WALL";
    case "self":
      return "RAN INTO ITSELF";
    case "body":
      return `RAN INTO ${other}`;
    case "head":
      return `HEAD-ON WITH ${other}`;
    case "left":
      return "LEFT THE PARTY";
    default:
      return "OUT";
  }
}

function renderResults(r) {
  $("results-round").textContent = `ROUND ${r.number} · ${GAME_NAMES[r.game]}`;
  const top = r.results[0];
  const winnerText =
    r.game === "tap" ? (top ? `${top.name} WINS!` : "") : r.winner ? `${r.winner} WINS!` : r.draw ? "DRAW!" : "";
  $("results-winner").hidden = !winnerText;
  $("results-winner").textContent = winnerText;
  const aliveCount = r.results.filter((entry) => entry.alive).length;
  const rows = r.results.map((entry) => {
    const row = document.createElement("li");
    row.className = "board__row";
    row.dataset.color = entry.color;
    const rank = document.createElement("span");
    rank.className = "board__rank";
    rank.textContent = entry.rank;
    const name = document.createElement("span");
    name.className = "board__name";
    name.textContent = entry.name;
    const score = document.createElement("span");
    score.className = "board__score";
    score.textContent =
      r.game === "snake"
        ? `LENGTH ${entry.length}`
        : r.game === "split"
          ? `${fmt(entry.total)} OFF`
          : r.game === "lights"
            ? fmtReaction(entry.total)
            : barText(entry);
    row.append(rank, name, score);
    if (r.game === "snake" || r.game === "split" || r.game === "lights") {
      const detail = document.createElement("span");
      detail.className = "board__detail";
      detail.textContent =
        r.game === "snake"
          ? snakeDetail(entry, aliveCount)
          : r.game === "lights"
            ? entry.legs.map((l) => lightsLegText(l)).join(" · ")
            : splitDetail(entry, r.targets);
      row.classList.add("board__row--detail");
      row.append(detail);
    }
    return row;
  });
  if (rows.length === 0) {
    const row = document.createElement("li");
    row.className = "board__row board__row--empty";
    row.innerHTML = '<span class="board__rank">–</span><span class="board__name">NOBODY PLAYED THIS ROUND</span><span></span>';
    rows.push(row);
  }
  $("results-board").replaceChildren(...rows);
}

// One tall bar per player in the round, keyed by slot.
const laneEls = new Map();

function buildLanes(r) {
  const key = `${r.number}:${r.bars.map((b) => `${b.slot}${b.name}`).join(",")}`;
  const lanes = $("battle-lanes");
  if (lanes.dataset.key === key) return;
  lanes.dataset.key = key;
  laneEls.clear();
  const cols = r.bars.map((b) => {
    const col = document.createElement("div");
    col.className = "battle-col";
    col.dataset.color = b.color;
    col.innerHTML =
      '<p class="badge battle-col__badge" hidden>FULL!</p>' +
      '<div class="battle-col__track"><div class="battle-col__fill"></div></div>' +
      '<p class="battle-col__pct t-score">0%</p><p class="battle-col__name"></p>';
    col.querySelector(".battle-col__name").textContent = b.name;
    laneEls.set(b.slot, col);
    return col;
  });
  lanes.replaceChildren(...cols);
}

function setLane(slot, level, full) {
  const col = laneEls.get(slot);
  if (!col) return;
  const shown = full ? 100 : level;
  col.style.setProperty("--level", shown);
  const pct = `${Math.floor(shown)}%`;
  const pctEl = col.querySelector(".battle-col__pct");
  if (pctEl.textContent !== pct) pctEl.textContent = pct;
  const badge = col.querySelector(".battle-col__badge");
  if (full && badge.hidden) {
    badge.hidden = false;
    badge.classList.add("pop-in");
  }
  col.classList.toggle("is-full", full);
}

// ---------- Lobby ----------
const HERO = {
  lights: { words: ["<LIGHTS", "OUT>"], tag: "FIVE RED LIGHTS. WHEN THEY GO OUT, TAP. FASTEST OVER 3 STARTS WINS." },
  split: { words: ["<SPLIT", "SECOND>"], tag: "STOP THE CLOCK DEAD ON. YOUR PHONE HIDES THE NUMBERS. THE SCREEN DOESN'T." },
  tap: { words: ["<MASH", "BATTLE>"], tag: "USE EVERY FINGER. THE FULLER YOUR BAR, THE FASTER IT DRAINS." },
  snake: { words: ["<SNAKE", "ROYALE>"], tag: "STEER WITH YOUR PHONE. EAT TO GROW. LAST SNAKE STANDING WINS." },
};
const demo = createLobbyDemo($("demo"));
const STATS_KEY = "gdg-party-stats";
let statsOn = false;
try {
  statsOn = localStorage.getItem(STATS_KEY) === "1";
} catch {
  // No storage (private window): stats start hidden.
}

function showGame(game) {
  const hero = HERO[game];
  if (!hero || document.body.dataset.game === game) return;
  $("hero-word-1").textContent = hero.words[0];
  $("hero-word-2").textContent = hero.words[1];
  $("hero-tag").textContent = hero.tag;
  document.body.dataset.game = game;
  demo.setGame(game);
}

function setStats(on) {
  statsOn = on;
  document.body.classList.toggle("show-stats", on);
  $("stats").setAttribute("aria-pressed", String(on));
  try {
    localStorage.setItem(STATS_KEY, on ? "1" : "0");
  } catch {
    // Not remembered; it still works for this visit.
  }
  syncDemo();
}

// The preview only runs while the lobby is what people see.
function syncDemo() {
  demo.setActive($("overlay").hidden && !statsOn);
}

function renderRound(r) {
  const running = r.phase === "countdown" || r.phase === "playing";
  showGame(r.game);
  const pill = $("round-pill");
  if (performance.now() > noticeUntil) {
    const text = roundPillText(r);
    if (pill.textContent !== text) pill.textContent = text;
  }
  pill.dataset.phase = r.phase;

  const start = $("start");
  start.disabled = running || presentCount < r.minPlayers;
  start.textContent = r.phase === "results" ? "<PLAY AGAIN>" : "<START>";
  start.title =
    presentCount < r.minPlayers ? `NEEDS ${r.minPlayers} ${r.minPlayers === 1 ? "PLAYER" : "PLAYERS"}` : `START ${GAME_NAMES[r.game]}`;
  $("rematch").disabled = presentCount < r.minPlayers;

  for (const btn of document.querySelectorAll(".game-switch [data-game]")) {
    btn.setAttribute("aria-pressed", String(btn.dataset.game === r.game));
    btn.disabled = running;
  }

  if (r.game === "snake") {
    renderSnake(r);
    syncDemo();
    return;
  }
  if (r.game === "split") {
    renderSplit(r);
    syncDemo();
    return;
  }
  if (r.game === "lights") {
    renderLights(r);
    syncDemo();
    return;
  }
  $("snake").hidden = true;
  $("split").hidden = true;
  $("lights").hidden = true;

  // Countdown, GO! for a moment, then the bars.
  const elapsed = r.durationMs - r.endsInMs;
  const showCountdown = r.phase === "countdown" || (r.phase === "playing" && elapsed < GO_SHOWN_MS);
  const showBattle = r.phase === "playing" && !showCountdown;
  const showResults = r.phase === "results";
  $("overlay").hidden = !showCountdown && !showBattle && !showResults;
  $("countdown").hidden = !showCountdown;
  $("battle").hidden = !showBattle;
  $("results").hidden = !showResults;

  if (showCountdown) {
    $("cd-game").textContent = GAME_NAMES[r.game];
    $("cd-rule").textContent = COUNTDOWN_RULES[r.game] ?? "";
    $("cd-round").textContent = r.number;
    $("cd-number").textContent = r.phase === "countdown" ? Math.max(1, Math.ceil(r.startsInMs / 1000)) : "GO!";
  }
  if (running) {
    buildLanes(r);
    for (const b of r.bars) setLane(b.slot, b.level, b.finishMs !== null);
    $("battle-round").textContent = `ROUND ${r.number} · MASH BATTLE`;
    const timer = r.endsInMs > 0 ? String(Math.ceil(r.endsInMs / 1000)) : "TIME!";
    if ($("battle-timer").textContent !== timer) $("battle-timer").textContent = timer;
    $("battle-winner").hidden = !r.winner;
    if (r.winner) $("battle-winner").textContent = `${r.winner} FILLED IT!`;
  }
  showResultsCard(r, showResults);
  syncDemo();
}

function showResultsCard(r, show) {
  const resultsKey = show ? `${r.game}:${r.number}:${JSON.stringify(r.results)}` : "";
  if (show && $("results").dataset.key !== resultsKey) {
    $("results").dataset.key = resultsKey;
    renderResults(r);
  }
}

// ---------- Rounds: SNAKE ROYALE ----------
const board = createSnakeBoard($("snake-board"));
const legendRows = new Map(); // slot -> row

function renderLegend(players) {
  const legend = $("snake-legend");
  const key = players.map((p) => `${p.slot}${p.name}`).join(",");
  if (legend.dataset.key !== key) {
    legend.dataset.key = key;
    legendRows.clear();
    const rows = players.map((p) => {
      const row = document.createElement("li");
      row.className = "legend__row";
      row.dataset.color = p.color;
      row.innerHTML =
        '<span class="legend__swatch" aria-hidden="true"></span><span class="legend__name"></span>' +
        '<span class="legend__len t-score"></span><span class="legend__status"></span>';
      row.querySelector(".legend__name").textContent = p.name;
      legendRows.set(p.slot, row);
      return row;
    });
    legend.replaceChildren(...rows);
  }
  for (const p of players) {
    const row = legendRows.get(p.slot);
    row.classList.toggle("is-out", !p.alive);
    setLegendLength(p.slot, p.length);
    const status = p.alive
      ? connectedSlots[p.slot] === false
        ? `${COLOR_NAMES[p.color]} · PHONE OFFLINE`
        : `${COLOR_NAMES[p.color]} · ALIVE`
      : `OUT · ${causeText(p.cause)}`;
    const statusEl = row.querySelector(".legend__status");
    if (statusEl.textContent !== status) statusEl.textContent = status;
  }
}

function setLegendLength(slot, length) {
  const el = legendRows.get(slot)?.querySelector(".legend__len");
  const text = String(length);
  if (el && el.textContent !== text) el.textContent = text;
}

function renderSnake(r) {
  const running = r.phase === "countdown" || r.phase === "playing";
  const showResults = r.phase === "results";
  const section = $("snake");
  const wasHidden = section.hidden;
  $("overlay").hidden = !running && !showResults;
  $("countdown").hidden = true;
  $("battle").hidden = true;
  $("split").hidden = true;
  $("lights").hidden = true;
  section.hidden = !running;
  $("results").hidden = !showResults;
  showResultsCard(r, showResults);
  if (!running) return;
  if (wasHidden) board.refit();

  $("snake-round").textContent = `ROUND ${r.number} · SNAKE ROYALE`;
  const alive = `${r.alive} ALIVE`;
  if ($("snake-alive").textContent !== alive) $("snake-alive").textContent = alive;
  $("snake-end").disabled = r.phase !== "playing" || r.over;
  const winner = r.over ? (r.winner ? `${r.winner} WINS!` : r.draw ? "DRAW!" : "GAME OVER") : "";
  $("snake-winner").hidden = !winner;
  if ($("snake-winner").textContent !== winner) $("snake-winner").textContent = winner;

  // 3-2-1 over the board (with everyone's name next to their snake), then GO! for a moment.
  const countdown = $("snake-countdown");
  const showGo = r.phase === "playing" && !r.over && r.elapsedMs < GO_SHOWN_MS;
  countdown.hidden = r.phase !== "countdown" && !showGo;
  const number = r.phase === "countdown" ? String(Math.max(1, Math.ceil(r.startsInMs / 1000))) : "GO!";
  if (countdown.textContent !== number) countdown.textContent = number;
  board.setNames(r.players);
  board.setTags(r.phase === "countdown");
  renderLegend(r.players);
}

// ---------- Rounds: SPLIT SECOND ----------
// Each player's lane runs a clock of its own for the crowd while their run is going (the
// phones show no numbers), then shows the time their phone measured the moment it lands.
const splitLanes = new Map(); // slot -> { el, runAt (performance.now() of the run's start, or null) }
let splitFrame = 0;
let splitTarget = 0; // the current leg's target, for errors shown between snapshots

// "1.00 +0.04 · 3.00 MISS · 5.00 −0.12" under a name in the results.
function splitDetail(entry, targets = []) {
  return (entry.legs ?? [])
    .map((leg, i) => `${fmt(targets[i] ?? 0)} ${leg ? signed(leg.ms, targets[i]) : "MISS"}`)
    .join(" · ");
}

// Green within the bullseye, yellow within a quarter second, red beyond.
const errorLevel = (error) => (isBullseye(error) ? "good" : error <= 250 ? "ok" : "bad");

function buildSplitLanes(r) {
  const key = `${r.number}:${r.players.map((p) => `${p.slot}${p.name}`).join(",")}`;
  const lanes = $("split-lanes");
  if (lanes.dataset.key === key) return;
  lanes.dataset.key = key;
  splitLanes.clear();
  const cols = r.players.map((p) => {
    const col = document.createElement("article");
    col.className = "split-col";
    col.dataset.color = p.color;
    col.innerHTML =
      '<p class="split-col__name"></p>' +
      '<p class="split-col__clock t-score">0.00</p>' +
      '<p class="pill pill--sm split-col__off" hidden></p>' +
      '<p class="split-col__runs"></p>' +
      '<p class="split-col__total t-score"></p>';
    col.querySelector(".split-col__name").textContent = p.name;
    splitLanes.set(p.slot, { el: col, runAt: null });
    return col;
  });
  lanes.replaceChildren(...cols);
}

function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

// One lane from the server's view of that player (every snapshot).
function paintLane(p, r) {
  const lane = splitLanes.get(p.slot);
  if (!lane) return;
  const { el } = lane;
  const reveal = r.stage === "reveal";
  const leg = reveal ? p.legs[r.leg] : null;
  // Keep the screen's own clock in step with the server's view of the run.
  lane.runAt = r.stage === "run" && p.running ? performance.now() - (p.runForMs ?? 0) : null;
  const shown = reveal ? leg : p.ms === null ? null : { ms: p.ms, error: p.error };
  el.classList.toggle("is-running", lane.runAt !== null);
  el.classList.toggle("is-locked", p.locked && r.stage === "run");
  if (lane.runAt === null) setText(el.querySelector(".split-col__clock"), shown ? fmt(shown.ms) : reveal ? "MISS" : "–");
  const off = el.querySelector(".split-col__off");
  off.hidden = !shown;
  if (shown) {
    setText(off, signed(shown.ms, r.targetMs));
    off.dataset.level = errorLevel(shown.error);
  }
  const runs = r.stage === "run" ? (p.locked ? "LOCKED IN" : p.runs ? `RUN ${p.runs}` : "NOT STARTED") : "";
  setText(el.querySelector(".split-col__runs"), runs);
  setText(el.querySelector(".split-col__total"), r.leg > 0 || reveal ? `TOTAL ${fmt(p.total)}` : "");
}

function tickSplitClocks() {
  splitFrame = 0;
  let any = false;
  const now = performance.now();
  for (const lane of splitLanes.values()) {
    if (lane.runAt === null) continue;
    any = true;
    setText(lane.el.querySelector(".split-col__clock"), fmt(now - lane.runAt));
  }
  if (any && !$("split").hidden) splitFrame = requestAnimationFrame(tickSplitClocks);
}

function startSplitClocks() {
  if (!splitFrame) splitFrame = requestAnimationFrame(tickSplitClocks);
}

function renderSplit(r) {
  const running = r.phase === "countdown" || r.phase === "playing";
  const showCountdown = r.phase === "countdown";
  const showSplit = r.phase === "playing";
  const showResults = r.phase === "results";
  $("overlay").hidden = !running && !showResults;
  $("countdown").hidden = !showCountdown;
  $("battle").hidden = true;
  $("snake").hidden = true;
  $("lights").hidden = true;
  $("split").hidden = !showSplit;
  $("results").hidden = !showResults;
  showResultsCard(r, showResults);
  if (showCountdown) {
    $("cd-game").textContent = GAME_NAMES.split;
    $("cd-rule").textContent = COUNTDOWN_RULES.split;
    $("cd-round").textContent = r.number;
    // Round 1's target is already known: show it big, the 3-2-1 comes with the round.
    $("cd-number").textContent = fmt(r.targetMs);
    $("cd-rule").textContent = `ROUND 1 OF ${r.legs}: STOP THE CLOCK AT ${fmt(r.targetMs)}. NUMBERS HIDDEN ON THE PHONES.`;
  }
  if (!showSplit) return;

  buildSplitLanes(r);
  splitTarget = r.targetMs;
  setText($("split-round"), `ROUND ${r.leg + 1} OF ${r.legs} · SPLIT SECOND`);
  setText($("split-target"), `STOP AT ${fmt(r.targetMs)}`);
  // Before each window: the target alone for a moment, then 3-2-1.
  const setLeft = Math.ceil(r.setInMs / 1000);
  const timer =
    r.stage === "run" ? String(Math.ceil(r.endsInMs / 1000)) : r.stage === "set" ? (setLeft > 3 ? "READY" : String(Math.max(1, setLeft))) : "TIME!";
  setText($("split-timer"), timer);
  const banner = $("split-banner");
  const last = r.leg + 1 >= r.legs;
  const bannerText =
    r.stage === "set"
      ? `ROUND ${r.leg + 1} OF ${r.legs} · THE TARGET IS ${fmt(r.targetMs)}`
      : r.stage === "reveal"
        ? last
          ? "THE LAST ROUND'S TIMES · RESULTS NEXT"
          : "THE TIMES · TOTALS SO FAR"
        : "";
  banner.hidden = !bannerText;
  setText(banner, bannerText);
  $("split").dataset.stage = r.stage;
  for (const p of r.players) paintLane(p, r);
  startSplitClocks();
}

// A run starting or stopping, or a lock, the moment a phone sends it.
function onSplit(msg) {
  const lane = splitLanes.get(msg.slot);
  if (!lane) return;
  if (msg.event === "start") {
    lane.runAt = performance.now();
    lane.el.classList.add("is-running");
    lane.el.querySelector(".split-col__off").hidden = true;
    setText(lane.el.querySelector(".split-col__runs"), `RUN ${msg.runs}`);
    startSplitClocks();
    return;
  }
  lane.runAt = null;
  lane.el.classList.remove("is-running");
  if (msg.ms !== null) {
    // The phone's own time replaces the screen's: that's the one that counts.
    setText(lane.el.querySelector(".split-col__clock"), fmt(msg.ms));
    const off = lane.el.querySelector(".split-col__off");
    off.hidden = false;
    setText(off, signed(msg.ms, splitTarget));
    off.dataset.level = errorLevel(msg.error ?? 0);
  }
  if (msg.locked) {
    lane.el.classList.add("is-locked");
    setText(lane.el.querySelector(".split-col__runs"), "LOCKED IN");
  }
}

// ---------- Rounds: LIGHTS OUT ----------
// The big gantry runs on the same schedule as the phones. The server is this laptop, so a server
// time converts straight to this page's clock.
const lightsLanes = new Map(); // slot -> lane element
let lightsSchedule = null; // { lightTimes, outAt } in server time
let lightsFrame = 0;
const serverToLocal = (t) => performance.now() + (t - Date.now());

function paintBigGantry(on) {
  $("lights-gantry")
    .querySelectorAll(".gantry__light")
    .forEach((bulb, i) => bulb.classList.toggle("is-on", i < on));
}

function tickGantry() {
  lightsFrame = 0;
  if (!lightsSchedule || $("lights").hidden) return;
  const now = performance.now();
  const out = now >= serverToLocal(lightsSchedule.outAt);
  const on = lightsSchedule.lightTimes.filter((t) => serverToLocal(t) <= now).length;
  paintBigGantry(out ? 0 : on);
  if (!out) lightsFrame = requestAnimationFrame(tickGantry);
}

function buildLightsLanes(r) {
  const key = `${r.number}:${r.players.map((p) => `${p.slot}${p.name}`).join(",")}`;
  const lanes = $("lights-lanes");
  if (lanes.dataset.key === key) return;
  lanes.dataset.key = key;
  lightsLanes.clear();
  lanes.replaceChildren(
    ...r.players.map((p) => {
      const col = document.createElement("article");
      col.className = "split-col lights-col";
      col.dataset.color = p.color;
      col.innerHTML =
        '<p class="split-col__name"></p><p class="split-col__clock t-score">–</p>' +
        '<p class="pill pill--sm split-col__off" hidden></p><p class="split-col__total t-score"></p>';
      col.querySelector(".split-col__name").textContent = p.name;
      lightsLanes.set(p.slot, col);
      return col;
    })
  );
}

// A reaction on a lane: the lane fills in the player's colour; a jump start or no tap says so in red.
function paintReaction(col, leg) {
  const clock = col.querySelector(".split-col__clock");
  const off = col.querySelector(".split-col__off");
  if (!leg) {
    setText(clock, "–");
    off.hidden = true;
    return;
  }
  setText(clock, leg.jump || leg.ms === null ? "–" : fmtReaction(leg.ms));
  off.hidden = !(leg.jump || leg.ms === null);
  if (!off.hidden) {
    setText(off, lightsLegText(leg));
    off.dataset.level = "bad";
  }
  col.classList.toggle("is-running", !leg.jump && leg.ms !== null);
}

function renderLights(r) {
  const running = r.phase === "countdown" || r.phase === "playing";
  const showCountdown = r.phase === "countdown";
  const showLights = r.phase === "playing";
  const showResults = r.phase === "results";
  $("overlay").hidden = !running && !showResults;
  $("countdown").hidden = !showCountdown;
  $("battle").hidden = true;
  $("snake").hidden = true;
  $("split").hidden = true;
  $("lights").hidden = !showLights;
  $("results").hidden = !showResults;
  showResultsCard(r, showResults);
  if (showCountdown) {
    $("cd-game").textContent = GAME_NAMES.lights;
    $("cd-rule").textContent = COUNTDOWN_RULES.lights;
    $("cd-round").textContent = r.number;
    $("cd-number").textContent = Math.max(1, Math.ceil(r.startsInMs / 1000));
  }
  if (!showLights) return;
  buildLightsLanes(r);
  setText($("lights-round"), `START ${r.leg + 1} OF ${r.legs} · LIGHTS OUT`);
  const status =
    r.stage === "grid" ? "WATCH THE LIGHTS" : r.stage === "go" ? "LIGHTS OUT!" : r.leg + 1 >= r.legs ? "RESULTS NEXT" : "TOTALS SO FAR";
  setText($("lights-status"), status);
  if ((r.stage === "grid" || r.stage === "go") && r.outAt) {
    lightsSchedule = { lightTimes: r.lightTimes, outAt: r.outAt };
    if (!lightsFrame) lightsFrame = requestAnimationFrame(tickGantry);
  } else {
    lightsSchedule = null;
    paintBigGantry(0);
  }
  for (const p of r.players) {
    const col = lightsLanes.get(p.slot);
    if (!col) continue;
    const leg = p.legs[r.leg];
    if (r.stage === "grid" && !p.pressed) {
      paintReaction(col, null);
      col.classList.remove("is-running");
    } else if (leg) {
      paintReaction(col, leg);
    }
    setText(col.querySelector(".split-col__total"), r.leg > 0 || r.stage === "reveal" ? `TOTAL ${fmtReaction(p.total)}` : "");
  }
}

// A tap the moment it arrives: the reaction goes straight up on that player's lane.
function onLightsTap(msg) {
  const col = lightsLanes.get(msg.slot);
  if (col) paintReaction(col, { ms: msg.ms, jump: msg.jump });
}

function onArena(frame) {
  board.setFrame(frame);
  for (const snake of frame.snakes) setLegendLength(snake.slot, snake.length);
}

function showNotice(message) {
  const pill = $("round-pill");
  pill.textContent = message;
  noticeUntil = performance.now() + 3000;
}

function renderVerdict(verdict) {
  const el = $("verdict");
  if (el.textContent !== verdict.text) el.textContent = verdict.text;
  el.dataset.level = verdict.level;
}

function moveDot(slot, x) {
  const el = cards[slot]?.el;
  el?.querySelector(".lane")?.style.setProperty("--x", x);
}

function flashTap(slot, taps) {
  const el = cards[slot]?.el;
  if (!el) return;
  field(el, "taps", taps);
  const badge = el.querySelector(".player__badge");
  badge.classList.remove("is-tap");
  // Restart the animation on every tap.
  void badge.offsetWidth;
  badge.classList.add("is-tap");
}

// ---------- Connection ----------
function send(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function connect() {
  const url = new URL("ws", location.href);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const sock = new WebSocket(url);
  ws = sock;
  sock.onopen = () => {
    $("offline").hidden = true;
  };
  sock.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.t === "u") moveDot(msg.slot, msg.x);
    else if (msg.t === "state") {
      renderPlayers(msg.players);
      renderVerdict(msg.verdict);
      renderRound(msg.round);
    } else if (msg.t === "bar") setLane(msg.slot, msg.level, msg.full);
    else if (msg.t === "arena") onArena(msg);
    else if (msg.t === "split") onSplit(msg);
    else if (msg.t === "lights") onLightsTap(msg);
    else if (msg.t === "tap") flashTap(msg.slot, msg.taps);
    else if (msg.t === "join") renderJoin(msg);
    else if (msg.t === "notice") showNotice(msg.message);
  };
  sock.onclose = () => {
    if (ws !== sock) return;
    ws = null;
    // Nothing on screen is live any more: no QR to a dead link, no green verdicts.
    $("offline").hidden = false;
    renderJoin({ tunnel: "stopped" });
    $("slots-left").textContent = "";
    renderVerdict({ level: "bad", text: "PARTY SERVER OFFLINE" });
    $("overlay").hidden = true;
    syncDemo();
    $("start").disabled = true;
    for (const btn of document.querySelectorAll(".game-switch [data-game]")) btn.disabled = true;
    for (const card of cards) card?.el.classList.add("is-down");
    setTimeout(connect, RECONNECT_MS);
  };
}

// The marquee loops by sliding half its width, so it needs two copies of the tips.
const tips = $("tips-track");
tips.append(...[...tips.children].map((el) => el.cloneNode(true)));

$("start").addEventListener("click", () => send({ t: "start" }));
$("rematch").addEventListener("click", () => send({ t: "start" }));
$("to-lobby").addEventListener("click", () => send({ t: "lobby" }));
$("snake-end").addEventListener("click", () => {
  if (confirm("End this round now? The longest snake still alive wins.")) send({ t: "end" });
});
for (const btn of document.querySelectorAll(".game-switch [data-game]")) {
  btn.addEventListener("click", () => send({ t: "game", game: btn.dataset.game }));
}

$("clear").addEventListener("click", () => {
  if (confirm("Remove every phone from the party?")) send({ t: "clear" });
});

$("stats").addEventListener("click", () => setStats(!statsOn));

renderPlayers(new Array(maxPlayers).fill(null));
showGame("tap");
setStats(statsOn);
connect();
