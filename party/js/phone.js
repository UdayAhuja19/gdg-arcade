// A phone in the party connection test. It joins the room, answers pings, sends a
// fake game update 10 times a second (a dot sliding back and forth), and sends a tap
// whenever the big button is pressed. It rejoins by itself after a dropout.
// In rounds it plays MASH BATTLE (its own bar) or steers in SNAKE ROYALE (the laptop runs
// the board; this phone only sends turns).
import { normalizeName } from "../../js/shared/names.js";
import { LEGS, fmt, signed } from "../../js/shared/split-second.js";
import { legText as lightsLegText, fmt as fmtReaction } from "../../js/shared/lights-out.js";
import { BAR_FULL, createBar } from "../../js/shared/tap-battle.js";

// Name and network are remembered on this phone. The player id is per tab, so two tabs
// (or two browser windows on the laptop) are two different players.
const STORE_KEY = "gdg-party";
const ID_KEY = "gdg-party-id";
// Set while this tab is in the party, so a reload rejoins straight away.
const JOINED_KEY = "gdg-party-joined";
const RETRY_MIN_MS = 500;
const RETRY_MAX_MS = 4000;
// Stop retrying after this long without getting back in (the tunnel link probably changed).
const GIVE_UP_MS = 30_000;
// The server pings every second, so this much silence means the connection is stuck.
const STALE_OPEN_MS = 3500;
const STALE_CONNECTING_MS = 6000;
const SLIDE_PERIOD_MS = 4000;
// How long GO! shows once a round starts.
const GO_SHOWN_MS = 700;

const $ = (id) => document.getElementById(id);
const views = { join: $("view-join"), play: $("view-play"), msg: $("view-msg") };
const form = $("join-form");
const nameInput = $("name");
const nameError = $("name-error");
const joinBtn = $("join-btn");
const tapBtn = $("tap");
const pad = $("pad");
const splitZone = $("split-zone");
const lightsPad = $("lights-pad");
const splitBtn = $("split-btn");
const splitLock = $("split-lock");

const COLOR_NAMES = { red: "RED", blue: "BLUE", yellow: "YELLOW", green: "GREEN", black: "BLACK" };

function readStore() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY)) ?? {};
  } catch {
    return {};
  }
}

function writeStore(patch) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ ...readStore(), ...patch }));
  } catch {
    // Private mode: the phone just won't remember its name.
  }
}

function sessionGet(key) {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function sessionSet(key, value) {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {
    // Storage blocked: a reload will just show the join form again.
  }
}

function newClientId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  // randomUUID needs https; the same-Wi-Fi test runs over plain http.
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
}

const stored = readStore();
const clientId = sessionGet(ID_KEY) ?? newClientId();
sessionSet(ID_KEY, clientId);

let name = stored.name ?? "";
let network = detectNetwork() ?? stored.network ?? null;
let ws = null;
let wantOnline = false;
let joined = null;
let retryMs = RETRY_MIN_MS;
let retryTimer = 0;
let offlineSince = 0;
let lastHeardAt = 0;
let updateTimer = 0;
let wakeLock = null;
let taps = 0;
// The latest round message, and this phone's own MASH BATTLE while a round is on.
let round = null;
let battle = null; // see newBattle()
let noteUntil = 0;

// A message in the round note for a few seconds, over whatever the round says.
function notice(message) {
  $("round-note").textContent = message;
  noteUntil = performance.now() + 4000;
}

// ---------- Views ----------
function show(view) {
  for (const [key, el] of Object.entries(views)) el.hidden = key !== view;
  setInGame();
}

// From this phone's 3-2-1 until the round is back in the lobby, the page locks to one screen
// with no scrolling: just the player's colour, the round status and the controls.
function setInGame() {
  const r = round;
  const inGame =
    !views.play.hidden &&
    !!r &&
    (r.phase === "countdown" || r.phase === "playing" ? !!r.inRound : r.phase === "results" && !!r.result);
  if (document.body.classList.contains("in-game") === inGame) return;
  document.body.classList.toggle("in-game", inGame);
  if (inGame) window.scrollTo(0, 0);
}

function showMessage(title, text, action, onAction) {
  $("msg-title").textContent = title;
  $("msg-text").textContent = text;
  const btn = $("msg-action");
  btn.textContent = `<${action}>`;
  btn.onclick = onAction;
  show("msg");
}

function showJoin(error = "") {
  nameInput.value = name;
  nameError.textContent = error;
  nameInput.setAttribute("aria-invalid", error ? "true" : "false");
  joinBtn.disabled = false;
  joinBtn.textContent = "<JOIN>";
  setNetworkRadios();
  show("join");
}

function setConn(text, state) {
  const el = $("conn");
  el.textContent = text;
  el.dataset.state = state;
}

// ---------- Network type ----------
function detectNetwork() {
  const type = navigator.connection?.type;
  if (type === "wifi" || type === "ethernet") return "wifi";
  if (type === "cellular") return "cellular";
  return null;
}

function setNetworkRadios() {
  for (const input of document.querySelectorAll('input[name="network"], input[name="network-live"]')) {
    input.checked = input.value === network;
  }
}

function changeNetwork(value) {
  network = value;
  writeStore({ network });
  setNetworkRadios();
  if (joined) sendMsg({ t: "network", network });
}

navigator.connection?.addEventListener?.("change", () => {
  const detected = detectNetwork();
  if (detected && detected !== network) changeNetwork(detected);
});

for (const input of document.querySelectorAll('input[name="network-live"]')) {
  input.addEventListener("change", () => changeNetwork(input.value));
}

// ---------- Connection ----------
function sendMsg(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function connect() {
  clearTimeout(retryTimer);
  if (!wantOnline || (ws && ws.readyState <= WebSocket.OPEN)) return;

  const url = new URL("ws", location.href);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const sock = new WebSocket(url);
  ws = sock;
  lastHeardAt = performance.now();

  sock.onopen = () => {
    // Left (or replaced) while this connection was still opening.
    if (ws !== sock || !wantOnline) {
      sock.close();
      return;
    }
    retryMs = RETRY_MIN_MS;
    lastHeardAt = performance.now();
    sock.send(
      JSON.stringify({
        t: "join",
        clientId,
        name,
        network: network ?? "unknown",
        // Lets the server say "your spot is gone" instead of handing out a new one.
        rejoin: joined !== null || sessionGet(JOINED_KEY) === "1",
      })
    );
  };
  sock.onmessage = (event) => {
    if (ws !== sock) return;
    lastHeardAt = performance.now();
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    handle(msg);
  };
  sock.onclose = (event) => {
    if (ws !== sock) return;
    ws = null;
    stopUpdates();
    if (!wantOnline) return;
    if (event.code === 4001) {
      // The same player joined again from another tab; this one steps aside.
      goOffline();
      forget();
      showMessage("OPEN ELSEWHERE", "THIS PHONE JOINED THE PARTY FROM ANOTHER TAB.", "PLAY HERE", startJoin);
      return;
    }
    retryLater();
  };
}

function retryLater() {
  const now = performance.now();
  offlineSince ||= now;
  if (now - offlineSince > GIVE_UP_MS) {
    const wasJoined = joined !== null;
    goOffline();
    forget();
    showMessage(
      "LOST IT",
      wasJoined
        ? "CAN'T REACH THE PARTY ANY MORE. SCAN THE QR CODE ON THE BIG SCREEN AGAIN."
        : "CAN'T REACH THE PARTY. TRY MOBILE DATA, THEN SCAN THE QR CODE AGAIN.",
      "TRY AGAIN",
      startJoin
    );
    return;
  }
  if (joined) setConn("RECONNECTING…", "down");
  else joinBtn.textContent = "CONNECTING…";
  retryTimer = setTimeout(connect, retryMs);
  retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
}

// A connection can hang without ever closing (Wi-Fi drops while the phone still thinks
// it's on it). No word from the server for a few seconds means start a fresh one.
setInterval(() => {
  if (!ws || !wantOnline || document.hidden) return;
  const limit = ws.readyState === WebSocket.OPEN ? STALE_OPEN_MS : STALE_CONNECTING_MS;
  if (performance.now() - lastHeardAt < limit) return;
  const stale = ws;
  ws = null;
  stopUpdates();
  stale.close();
  retryMs = RETRY_MIN_MS;
  retryLater();
}, 1000);

function goOffline() {
  wantOnline = false;
  clearTimeout(retryTimer);
  offlineSince = 0;
  stopUpdates();
  releaseWakeLock();
  const sock = ws;
  ws = null;
  sock?.close();
}

// Out of the party for good: a reload shows the join form, not an automatic rejoin.
function forget() {
  joined = null;
  round = null;
  dropBattle();
  sessionSet(JOINED_KEY, null);
  delete document.body.dataset.color;
}

function handle(msg) {
  switch (msg.t) {
    case "joined": {
      joined = msg;
      offlineSince = 0;
      sessionSet(JOINED_KEY, "1");
      document.body.dataset.color = msg.color;
      $("you").textContent = `${msg.name}: YOU'RE ${COLOR_NAMES[msg.color] ?? ""}`;
      taps = msg.taps;
      renderRound();
      setConn("CONNECTED", "up");
      syncClock();
      setNetworkRadios();
      show("play");
      if (document.hidden) {
        sendMsg({ t: "pause" });
      } else {
        startUpdates();
        keepAwake();
      }
      if (!msg.rejoined) navigator.vibrate?.(40);
      break;
    }
    case "ping":
      sendMsg({ t: "pong", id: msg.id });
      $("ping").textContent = msg.rtt == null ? "—" : `${Math.round(msg.rtt)} MS`;
      if (msg.verdict && msg.verdict !== "PAUSED") {
        $("verdict").textContent = msg.verdict;
        $("verdict").dataset.verdict = msg.verdict;
      }
      break;
    case "tapped":
      taps = msg.taps;
      renderRound();
      break;
    case "round":
      onRound(msg);
      break;
    case "ack":
      onAck(msg);
      break;
    case "notice":
      notice(msg.message);
      break;
    case "sync":
      onSync(msg);
      break;
    case "error":
      goOffline();
      forget();
      showJoin(msg.message);
      break;
    case "full":
      goOffline();
      forget();
      showMessage("FULL", "5 PHONES ARE ALREADY IN THE PARTY. WAIT FOR A SPOT, THEN TRY AGAIN.", "TRY AGAIN", startJoin);
      break;
    case "kicked":
      goOffline();
      forget();
      showMessage("REMOVED", "THE BOOTH CLEARED YOUR SPOT. JOIN AGAIN WHEN YOU'RE READY.", "JOIN AGAIN", () => showJoin());
      break;
    case "expired":
      goOffline();
      forget();
      showMessage("TIMED OUT", "YOUR SPOT WAS FREED WHILE YOU WERE AWAY.", "JOIN AGAIN", () => showJoin());
      break;
    default:
  }
}

// ---------- Rounds: MASH BATTLE ----------
// The phone runs its own bar on its own clock, so a tap counts the moment it happens.
// Nothing gets lost on the way to the server:
//   - the bar is saved in this tab's storage on every tap, so a reload (or a crashed
//     browser tab) picks it up exactly where it was;
//   - every report is numbered and the server confirms it; the final bar is resent
//     until the server has it, even after a dropout and even once the results are up.
const BATTLE_KEY = "gdg-party-battle";
const PROGRESS_EVERY_MS = 100;
// Once the bar can't change any more, how often to resend it until it's confirmed.
const RESEND_FINAL_MS = 1000;
// Only say "SENDING…" once the server has been quiet about our reports for this long.
const UNCONFIRMED_MS = 800;
const RULE = "USE EVERY FINGER. THE FULLER YOUR BAR, THE FASTER IT DRAINS. FIRST TO FILL IT WINS.";
let frame = 0;

function newBattle(msg, now) {
  const endAt = now + msg.endsInMs;
  const startAt = endAt - msg.durationMs;
  // Nothing saved in this tab (storage blocked, say): carry on from what the server last had.
  const saved = msg.level > 0 ? { level: msg.level, taps: msg.taps, lastAt: now - startAt } : null;
  return {
    number: msg.number,
    startAt,
    endAt,
    // performance.now() starts again with every page, so the start is also kept as a wall-clock time.
    startEpoch: Date.now() + (startAt - now),
    bar: createBar(startAt, saved),
    seq: 0, // number of the last report sent
    sentAt: 0,
    ackedSeq: 0, // newest report the server confirmed
    ackedAt: 0,
    finalSeq: 0, // first report sent once the bar was final
    delivered: false, // the server has the final bar
    lost: false, // the server said it came too late
  };
}

function saveBattle() {
  if (!battle) return;
  const { number, startEpoch, startAt, endAt, bar, seq, finalSeq, delivered, lost } = battle;
  const saved = { clientId, number, startEpoch, durationMs: endAt - startAt, bar: bar.save(), seq, finalSeq, delivered, lost };
  sessionSet(BATTLE_KEY, JSON.stringify(saved));
}

function loadBattle() {
  let saved;
  try {
    saved = JSON.parse(sessionGet(BATTLE_KEY));
  } catch {
    return null;
  }
  if (!saved || saved.clientId !== clientId || !saved.bar) return null;
  const startAt = performance.now() + (saved.startEpoch - Date.now());
  return {
    number: saved.number,
    startAt,
    endAt: startAt + saved.durationMs,
    startEpoch: saved.startEpoch,
    bar: createBar(startAt, saved.bar),
    seq: saved.seq,
    sentAt: 0,
    ackedSeq: 0,
    ackedAt: 0,
    finalSeq: saved.finalSeq,
    delivered: saved.delivered,
    lost: saved.lost,
  };
}

function dropBattle() {
  battle = null;
  sessionSet(BATTLE_KEY, null);
}

function onRound(msg) {
  const now = performance.now();
  const before = round;
  round = msg;
  roundAt = now;
  const running = msg.phase === "countdown" || msg.phase === "playing";
  const tapBattle = msg.game === "tap";
  if (msg.game === "snake") onSnakeRound(before, msg, now);
  if (msg.game === "split") onSplitRound(msg, now);
  if (msg.game === "lights") onLightsRound(msg, now);
  // A bar from an older round (or a restarted server, or another game) can't count any more.
  if (battle && (!tapBattle || battle.number !== msg.number || !msg.inRound)) dropBattle();
  if (tapBattle && running && msg.inRound && !battle) {
    battle = newBattle(msg, now);
    saveBattle();
  }
  if (battle && !running) {
    // The round ended early (someone filled their bar): this bar stops where it is.
    if (battleState(now) === "playing") {
      battle.endAt = now;
      saveBattle();
    }
    // Round over and the server has this phone's bar: nothing left to keep.
    if (battle.delivered) dropBattle();
  }
  if (battle) {
    sendDue(now);
    if (!frame) frame = requestAnimationFrame(battleFrame);
  }
  renderRound();
}

function onAck(msg) {
  if (split && msg.round === split.number) onSplitAck(msg);
  if (lights && msg.round === lights.number) onLightsAck(msg);
  if (!battle || msg.round !== battle.number) return;
  battle.ackedSeq = Math.max(battle.ackedSeq, msg.seq);
  battle.ackedAt = performance.now();
  const aboutFinal = battle.finalSeq > 0 && msg.seq >= battle.finalSeq;
  if (msg.status === "final" || (aboutFinal && msg.status === "saved")) {
    battle.delivered = true;
  } else if (aboutFinal && (msg.status === "too-late" || msg.status === "rejected")) {
    battle.delivered = true;
    battle.lost = true;
  }
  saveBattle();
  if (battle.delivered && round && round.phase !== "countdown" && round.phase !== "playing") {
    dropBattle();
    renderRound();
  }
}

function battleState(now) {
  if (!battle) return null;
  if (now < battle.startAt) return "countdown";
  if (battle.bar.filledMs !== null) return "full";
  if (now < battle.endAt) return "playing";
  return "time";
}

function barLevel(now) {
  // The bar stops draining at the time limit.
  return battle.bar.level(Math.min(now, battle.endAt));
}

function sendProgress(now) {
  if (!joined || now < battle.startAt || battle.delivered) return;
  const state = battleState(now);
  const final = state === "full" || state === "time";
  battle.sentAt = now;
  battle.seq += 1;
  if (final && !battle.finalSeq) battle.finalSeq = battle.seq;
  const level = Math.round(barLevel(now) * 10) / 10;
  saveBattle();
  sendMsg({
    t: "progress",
    round: battle.number,
    seq: battle.seq,
    level,
    taps: battle.bar.taps,
    done: battle.bar.filledMs !== null,
    ms: battle.bar.filledMs,
    final,
  });
}

// While playing: 10 reports a second. Once final: straight away, then once a second until confirmed.
function sendDue(now) {
  if (!battle || battle.delivered) return;
  const state = battleState(now);
  const final = state === "full" || state === "time";
  const due = final
    ? !battle.finalSeq || now - battle.sentAt >= RESEND_FINAL_MS
    : now - battle.sentAt >= PROGRESS_EVERY_MS;
  if (due) sendProgress(now);
}

function battleFrame() {
  frame = 0;
  if (!battle) return;
  sendDue(performance.now());
  renderRound();
  frame = requestAnimationFrame(battleFrame);
}

function syncState(now) {
  if (!battle || now < battle.startAt) return null;
  if (battle.lost) return ["lost", "SENT TOO LATE TO COUNT"];
  if (battle.delivered) return ["ok", "SAVED ON THIS PHONE · SENT"];
  if (ws?.readyState !== WebSocket.OPEN) return ["offline", "SAVED ON THIS PHONE · SENDS WHEN YOU'RE BACK ONLINE"];
  if (now - battle.ackedAt > UNCONFIRMED_MS) return ["sending", "SAVED ON THIS PHONE · SENDING…"];
  return ["ok", "SAVED ON THIS PHONE · SENT"];
}

function setBar(level) {
  $("bar-fill").style.width = `${Math.max(0, Math.min(100, (level / BAR_FULL) * 100))}%`;
  const text = `${Math.floor(level)}%`;
  if ($("bar-label").textContent !== text) $("bar-label").textContent = text;
}

function renderRound() {
  const now = performance.now();
  setInGame();
  const game = round?.game ?? "tap";
  tapBtn.hidden = game !== "tap";
  pad.hidden = game !== "snake";
  splitZone.hidden = game !== "split";
  lightsPad.hidden = game !== "lights";
  if (game === "snake") {
    renderSnake(now);
    return;
  }
  if (game === "split") {
    renderSplit(now);
    return;
  }
  if (game === "lights") {
    renderLights(now);
    return;
  }
  const status = $("round-status");
  const note = $("round-note");
  const result = $("result");
  const label = $("tap-label");
  const count = $("tap-count");
  const barEl = $("bar");
  const syncEl = $("sync");
  // The live bar only while the round is on; afterwards the server's result is shown.
  const live = round && (round.phase === "countdown" || round.phase === "playing");
  const state = live ? battleState(now) : null;

  let statusText = "JOINING THE LOBBY…";
  let noteText = "";
  let labelText = "TAP";
  let countText = String(taps);
  let showBar = false;

  if (round) {
    const players = `${round.players} ${round.players === 1 ? "PLAYER" : "PLAYERS"} IN`;

    const mine = round.phase === "results" ? round.result : null;
    result.hidden = !mine;
    if (mine) {
      result.textContent = mine.rank === 1 ? "YOU WON!" : `YOU'RE #${mine.rank}`;
      result.dataset.rank = mine.rank;
    }

    if (state) {
      showBar = true;
      const level = barLevel(now);
      setBar(level);
      countText = `${Math.floor(level)}%`;
      const someoneElse = round.winner && !round.youWon;
      if (state === "countdown") {
        statusText = "GET READY…";
        noteText = RULE;
        labelText = String(Math.ceil((battle.startAt - now) / 1000));
      } else if (state === "playing") {
        statusText = someoneElse ? `${round.winner} FILLED IT!` : `${Math.ceil((battle.endAt - now) / 1000)}S LEFT`;
        noteText = "FASTER! THE FULLER IT GETS, THE FASTER IT DRAINS.";
        labelText = now - battle.startAt < GO_SHOWN_MS ? "GO!" : "TAP!";
      } else if (state === "full") {
        statusText = `FULL IN ${(battle.bar.filledMs / 1000).toFixed(1)}S!`;
        noteText = "WAITING FOR THE RESULTS…";
        labelText = "FULL!";
      } else {
        statusText = "TIME!";
        noteText = "WAITING FOR THE RESULTS…";
        labelText = "TIME!";
      }
    } else if (round.phase === "countdown" || round.phase === "playing") {
      statusText = "BATTLE IN PROGRESS";
      noteText = "YOU'RE IN THE NEXT ONE. WATCH THE BIG SCREEN.";
    } else if (round.phase === "results" && battle && !battle.delivered) {
      showBar = true;
      setBar(barLevel(now));
      statusText = "SENDING YOUR BAR…";
      noteText = "YOUR RESULT WILL SHOW UP IN A MOMENT.";
    } else if (mine) {
      showBar = true;
      setBar(mine.finishMs !== null ? BAR_FULL : mine.level);
      statusText =
        mine.finishMs !== null
          ? `FULL IN ${(mine.finishMs / 1000).toFixed(1)}S · ${mine.rank} OF ${mine.of}`
          : `BAR ${mine.level}% · ${mine.rank} OF ${mine.of}`;
      noteText = "THE BIG SCREEN STARTS THE NEXT ONE.";
    } else {
      statusText = `LOBBY · ${players}`;
      noteText = `THE BIG SCREEN STARTS THE ROUND. ${RULE}`;
    }
  }

  barEl.hidden = !showBar;
  const sync = syncState(now);
  syncEl.hidden = !sync || !showBar;
  if (sync) {
    syncEl.dataset.state = sync[0];
    if (syncEl.textContent !== sync[1]) syncEl.textContent = sync[1];
  }
  if (status.textContent !== statusText) status.textContent = statusText;
  if (now > noteUntil && note.textContent !== noteText) note.textContent = noteText;
  if (label.textContent !== labelText) label.textContent = labelText;
  if (count.textContent !== countText) count.textContent = countText;
  tapBtn.classList.toggle("is-waiting", state === "countdown" || state === "full" || state === "time");
}

// Clears a server notice after a few seconds, and keeps the snake countdown ticking.
setInterval(() => {
  const now = performance.now();
  const snakeClock = round?.game === "snake" && (round.phase === "countdown" || now - playingSince < GO_SHOWN_MS + 250);
  const splitClock =
    (round?.game === "split" || round?.game === "lights") && (round.phase === "countdown" || round.phase === "playing");
  if ((!battle && now < noteUntil + 200) || snakeClock || splitClock) renderRound();
}, 250);

// ---------- Clock sync ----------
// LIGHTS OUT turns every screen's lights off at the same moment, so this phone needs to know how
// far its clock is from the server's. It sends its own time, the server answers with its own;
// the answer from the quickest round trip is the most accurate.
let clockOffset = null; // server time minus this phone's performance.now(), or null
let bestSyncRtt = Infinity;

function syncClock(samples = 5) {
  bestSyncRtt = Infinity;
  for (let i = 0; i < samples; i += 1) setTimeout(() => sendMsg({ t: "sync", c: performance.now() }), i * 120);
}

function onSync(msg) {
  const now = performance.now();
  const rtt = now - msg.c;
  if (rtt < 0 || rtt > bestSyncRtt) return;
  bestSyncRtt = rtt;
  clockOffset = msg.s + rtt / 2 - now;
}

// A server time on this phone's clock. Before any sync, the message's own send time stands in.
const toLocal = (serverTime) => serverTime - (clockOffset ?? 0);

// ---------- Rounds: LIGHTS OUT ----------
// Five lights come on a second apart, then all go out after a random hold: tap as fast as you
// can. The server sends the schedule ahead; this phone turns its lights off at that moment on its
// own clock, and times the reaction from the frame the lights actually went off.
const LIGHTS_RULE = "FIVE RED LIGHTS COME ON. WHEN THEY ALL GO OUT, TAP. TAP EARLY AND IT'S A JUMP START.";
const RESEND_TAP_MS = 500;
let lights = null; // { number, leg, lightTimes, outAt (local), outPaintedAt, pressed, result, seq, sentAt, acked, msg }
let lightsFrame = 0;

function onLightsRound(msg, now) {
  const live = msg.phase === "playing" && (msg.stage === "grid" || msg.stage === "go") && msg.inRound;
  if (lights && (lights.number !== msg.number || lights.leg !== msg.leg)) lights = null;
  if (!live) {
    if (lights && msg.stage === "reveal") lights.done = true;
    return;
  }
  if (clockOffset === null) clockOffset = msg.serverNow - now; // until a sync answers
  if (!lights) {
    lights = { number: msg.number, leg: msg.leg, lightTimes: [], outAt: 0, outPaintedAt: null, pressed: msg.pressed, result: null, seq: 0, sentAt: 0, acked: msg.pressed, msg: null };
    if (msg.stage === "grid") syncClock();
  }
  lights.serverLights = msg.lightTimes;
  lights.serverOut = msg.outAt;
  if (!lightsFrame) lightsFrame = requestAnimationFrame(lightsTick);
}

// Every frame while a start is on: how many lights are lit, and the frame they went out.
function lightsTick(frameAt) {
  lightsFrame = 0;
  if (!lights || lights.done) return;
  const now = performance.now();
  const on = lights.serverLights.filter((t) => toLocal(t) <= now).length;
  const out = now >= toLocal(lights.serverOut);
  if (out && lights.outPaintedAt === null) lights.outPaintedAt = now;
  paintGantry(out ? 0 : on);
  if (!lights.pressed || !lights.acked) lightsFrame = requestAnimationFrame(lightsTick);
  if (lights.pressed && !lights.acked && now - lights.sentAt > RESEND_TAP_MS) sendTap();
}

function paintGantry(on) {
  const bulbs = lightsPad.querySelectorAll(".gantry__light");
  bulbs.forEach((bulb, i) => bulb.classList.toggle("is-on", i < on));
}

function sendTap() {
  lights.sentAt = performance.now();
  lights.seq += 1;
  lights.sentSeq = lights.seq;
  sendMsg({ t: "lights", round: lights.number, leg: lights.leg, seq: lights.seq, ...lights.msg });
}

function pressLights() {
  const now = performance.now();
  if (!lights || lights.pressed || lights.done) {
    if (round && (round.phase === "lobby" || round.phase === "results")) {
      sendMsg({ t: "tap" });
      navigator.vibrate?.(12);
    }
    return;
  }
  if (!lights.serverLights || now < toLocal(lights.serverLights[0])) return; // nothing lit yet
  lights.pressed = true;
  // Normally the reaction runs from the frame the lights went off. If no frame has run since
  // (a busy or throttled phone), the scheduled lights out stands in.
  const outLocal = toLocal(lights.serverOut);
  if (lights.outPaintedAt === null && now >= outLocal) lights.outPaintedAt = outLocal;
  if (lights.outPaintedAt === null) {
    lights.msg = { jump: true };
    lights.result = { ms: null, jump: true };
    navigator.vibrate?.([200, 60, 200]);
  } else {
    const ms = Math.round(now - lights.outPaintedAt);
    lights.msg = { ms };
    lights.result = { ms, jump: false };
    navigator.vibrate?.(20);
  }
  sendTap();
  if (!lightsFrame) lightsFrame = requestAnimationFrame(lightsTick);
  renderRound();
}

function onLightsAck(msg) {
  if (msg.seq !== lights.sentSeq) return;
  lights.acked = true;
  if (msg.status === "saved" || msg.status === "final") return;
  // too-late / rejected: the server didn't take it; the reveal will say what counted.
}

function renderLights(now) {
  const r = round;
  $("bar").hidden = true;
  $("sync").hidden = true;
  const status = $("round-status");
  const note = $("round-note");
  const label = $("lights-label");
  const result = $("result");
  const legLine = `START ${r.leg + 1} OF ${r.legs ?? 3}`;
  const since = now - roundAt;
  const secs = (ms) => Math.max(0, Math.ceil((ms - since) / 1000));
  const mine = r.phase === "results" ? r.result : null;
  result.hidden = !mine;
  if (mine) {
    result.textContent = mine.rank === 1 ? (r.youWon ? "YOU WON!" : r.draw ? "DRAW!" : "GAME OVER") : `YOU'RE #${mine.rank}`;
    result.dataset.rank = mine.rank;
  }
  let statusText;
  let noteText = "";
  let labelText = "TAP WHEN THE LIGHTS GO OUT";
  let off = true;

  if (r.phase === "countdown" && r.inRound) {
    statusText = "GET READY";
    noteText = LIGHTS_RULE;
  } else if (r.phase === "playing" && r.inRound && (r.stage === "grid" || r.stage === "go")) {
    statusText = legLine;
    noteText = "WATCH THE LIGHTS. DON'T MOVE UNTIL THEY'RE ALL OUT.";
    off = false;
    const mineNow = lights?.result;
    if (mineNow) {
      labelText = mineNow.jump ? "JUMP START!" : fmtReaction(mineNow.ms);
      noteText = mineNow.jump ? "YOU WENT BEFORE LIGHTS OUT. +1.000" : "WAIT FOR THE OTHERS…";
    }
  } else if (r.phase === "playing" && r.inRound && r.stage === "reveal") {
    const leg = r.mine;
    labelText = lightsLegText(leg);
    statusText = `${legLine} · ${lightsLegText(leg)}`;
    const place = r.standing ? ` · ${r.standing.rank} OF ${r.standing.of}` : "";
    const next = r.leg + 1 >= (r.legs ?? 3) ? "RESULTS" : "NEXT START";
    noteText = `TOTAL ${fmtReaction(r.total)}${place} · ${next} IN ${secs(r.revealInMs)}S`;
  } else if (r.phase === "countdown" || r.phase === "playing") {
    statusText = "LIGHTS OUT IN PROGRESS";
    noteText = "YOU'RE IN THE NEXT ONE. WATCH THE BIG SCREEN.";
  } else if (mine) {
    statusText = `TOTAL ${fmtReaction(mine.total)} · ${mine.rank} OF ${mine.of}`;
    noteText = mine.legs.map((l) => lightsLegText(l)).join(" · ");
    labelText = fmtReaction(mine.total);
  } else {
    statusText = "NEXT: LIGHTS OUT";
    const players = `${r.players} ${r.players === 1 ? "PLAYER" : "PLAYERS"} IN`;
    noteText = `${r.phase === "lobby" ? "LOBBY · " : ""}${players}. THE BIG SCREEN STARTS THE ROUND. ${LIGHTS_RULE}`;
  }
  if (off) paintGantry(0);
  if (status.textContent !== statusText) status.textContent = statusText;
  if (now > noteUntil && note.textContent !== noteText) note.textContent = noteText;
  if (label.textContent !== labelText) label.textContent = labelText;
}

lightsPad.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  pressLights();
});
lightsPad.addEventListener("keydown", (event) => {
  if ((event.key === " " || event.key === "Enter") && !event.repeat) {
    event.preventDefault();
    pressLights();
  }
});

// ---------- Rounds: SPLIT SECOND ----------
// Three rounds, each with a target. In each round's window this phone starts and stops its own
// clock as often as the player likes, showing no numbers, then locks the last run in. The clock
// is this phone's (a press counts the moment it happens); the laptop only checks it. Start and
// stop are sent once; a lock is resent until the laptop confirms it.
const SPLIT_KEY = "gdg-party-split";
const SPLIT_RULE = "START THE CLOCK, STOP IT WHEN YOU THINK IT'S TIME. NO NUMBERS: COUNT IT IN YOUR HEAD.";
let split = null; // { number, leg, runStartAt, runStartEpoch, runs, stopped, locked, seq, lockSeq, lockSentAt, delivered }

function newSplit(msg) {
  return { number: msg.number, leg: msg.leg, runStartAt: null, runStartEpoch: null, runs: 0, stopped: false, locked: false, seq: 0, lockSeq: 0, lockSentAt: 0, delivered: false };
}

function saveSplit() {
  if (!split) return sessionSet(SPLIT_KEY, null);
  const { runStartAt, ...kept } = split;
  sessionSet(SPLIT_KEY, JSON.stringify({ clientId, ...kept }));
}

// After a reload: a run that was going keeps going, from the same moment.
function loadSplit() {
  try {
    const saved = JSON.parse(sessionGet(SPLIT_KEY));
    if (!saved || saved.clientId !== clientId) return null;
    const { clientId: _, ...kept } = saved;
    const runStartAt = kept.runStartEpoch === null ? null : performance.now() - (Date.now() - kept.runStartEpoch);
    return { ...kept, runStartAt };
  } catch {
    return null;
  }
}

function sendSplit(event, ms) {
  split.seq += 1;
  sendMsg({ t: "split", round: split.number, leg: split.leg, seq: split.seq, event, ms });
  return split.seq;
}

function onSplitRound(msg, now) {
  const inWindow = msg.phase === "playing" && msg.stage === "run" && msg.inRound;
  // A new round, a new leg or another game: start clean.
  if (split && (split.number !== msg.number || split.leg !== msg.leg || !msg.inRound)) split = null;
  if (!split && inWindow) split = newSplit(msg);
  if (split && !inWindow && msg.stage !== "run") {
    // The window closed: a run still going no longer counts.
    split.runStartAt = null;
    split.runStartEpoch = null;
  }
  if (split && msg.locked) {
    split.locked = true;
    split.delivered = true;
  }
  saveSplit();
  if (split?.locked && !split.delivered) resendLock(now);
}

function onSplitAck(msg) {
  if (!split.lockSeq || msg.seq !== split.lockSeq) return;
  if (msg.status === "saved" || msg.status === "final") {
    split.delivered = true;
  } else {
    // The laptop had nothing to lock (the stop was lost): run it again.
    split.locked = false;
    split.lockSeq = 0;
    split.stopped = false;
    notice("THAT DIDN'T REACH THE SCREEN. RUN IT AGAIN, THEN LOCK IT IN.");
  }
  saveSplit();
  renderRound();
}

function resendLock(now) {
  if (!split || !split.locked || split.delivered || now - split.lockSentAt < RESEND_FINAL_MS) return;
  split.lockSentAt = now;
  split.lockSeq = sendSplit("lock");
}

function splitWindowOpen() {
  return round?.game === "split" && round.phase === "playing" && round.stage === "run" && round.inRound && split && !split.locked;
}

function pressSplit() {
  const now = performance.now();
  if (!splitWindowOpen()) {
    // Between rounds a press flashes this player's card on the big screen.
    if (round && (round.phase === "lobby" || round.phase === "results")) {
      sendMsg({ t: "tap" });
      navigator.vibrate?.(12);
    }
    return;
  }
  if (split.runStartAt === null) {
    split.runStartAt = now;
    split.runStartEpoch = Date.now();
    split.runs += 1;
    sendSplit("start");
    navigator.vibrate?.(10);
  } else {
    const ms = Math.round(now - split.runStartAt);
    split.runStartAt = null;
    split.runStartEpoch = null;
    split.stopped = true;
    sendSplit("stop", ms);
    navigator.vibrate?.([10, 40, 10]);
  }
  saveSplit();
  renderRound();
}

function lockSplit() {
  if (!splitWindowOpen() || !split.stopped || split.runStartAt !== null) return;
  split.locked = true;
  split.lockSentAt = performance.now();
  split.lockSeq = sendSplit("lock");
  navigator.vibrate?.([60, 40, 160]);
  saveSplit();
  renderRound();
}

setInterval(() => resendLock(performance.now()), 500);

function renderSplit(now) {
  const r = round;
  $("bar").hidden = true;
  $("sync").hidden = true;
  const status = $("round-status");
  const note = $("round-note");
  const label = $("split-label");
  const runsEl = $("split-runs");
  const result = $("result");
  const legText = `ROUND ${r.leg + 1} OF ${r.legs ?? LEGS}`;
  const since = now - roundAt;
  const secs = (ms) => Math.max(0, Math.ceil((ms - since) / 1000));

  let statusText;
  let noteText = "";
  let labelText = "–";
  let runsText = "";
  let waiting = true;
  let canLock = false;
  const mine = r.phase === "results" ? r.result : null;
  result.hidden = !mine;
  if (mine) {
    result.textContent = mine.rank === 1 ? (r.youWon ? "YOU WON!" : r.draw ? "DRAW!" : "GAME OVER") : `YOU'RE #${mine.rank}`;
    result.dataset.rank = mine.rank;
  }

  if (r.phase === "countdown" && r.inRound) {
    statusText = `GET READY · ${legText}`;
    noteText = SPLIT_RULE;
    labelText = "READY";
  } else if (r.phase === "playing" && r.inRound && r.stage === "set") {
    // The target on its own first, then 3-2-1 into the window.
    const left = secs(r.setInMs);
    statusText = legText;
    noteText = "COUNT IT IN YOUR HEAD. RETRY ALL YOU LIKE, THEN LOCK IT IN.";
    labelText = left > 3 ? "READY" : String(Math.max(1, left));
  } else if (r.phase === "playing" && r.inRound && r.stage === "run") {
    statusText = legText;
    const left = `${secs(r.endsInMs)}S LEFT`;
    if (split?.locked) {
      labelText = "LOCKED";
      noteText = split.delivered ? `LOCKED IN · WAIT FOR THE OTHERS · ${left}` : "LOCKING IN…";
    } else if (split?.runStartAt !== null && split?.runStartAt !== undefined) {
      labelText = "STOP";
      waiting = false;
      noteText = `COUNTING… · ${left}`;
    } else {
      labelText = split?.runs ? "AGAIN" : "START";
      waiting = false;
      canLock = Boolean(split?.stopped);
      noteText = split?.stopped ? `HAPPY WITH THAT ONE? LOCK IT IN, OR GO AGAIN · ${left}` : `PRESS START, THEN STOP AT ${fmt(r.targetMs)} · ${left}`;
    }
    runsText = split?.runs ? `RUN ${split.runs}` : "";
  } else if (r.phase === "playing" && r.inRound && r.stage === "reveal") {
    // Now, and only now, the player sees what they did.
    const seen = r.reveal;
    labelText = seen ? fmt(seen.ms) : "MISS";
    statusText = seen ? `YOU GOT ${fmt(seen.ms)} · ${signed(seen.ms, r.targetMs)}` : "NO TIME LOCKED IN";
    const next = r.leg + 1 >= (r.legs ?? LEGS) ? "RESULTS" : "NEXT ROUND";
    noteText = `TOTAL ${fmt(r.total)} OFF · ${next} IN ${secs(r.revealInMs)}S`;
  } else if (r.phase === "countdown" || r.phase === "playing") {
    statusText = "SPLIT SECOND IN PROGRESS";
    noteText = "YOU'RE IN THE NEXT ONE. WATCH THE BIG SCREEN.";
  } else if (mine) {
    statusText = `TOTAL ${fmt(mine.total)} OFF · ${mine.rank} OF ${mine.of}`;
    noteText = "THE BIG SCREEN STARTS THE NEXT ONE.";
    labelText = fmt(mine.total);
  } else {
    statusText = "NEXT: SPLIT SECOND";
    const players = `${r.players} ${r.players === 1 ? "PLAYER" : "PLAYERS"} IN`;
    noteText = `${r.phase === "lobby" ? "LOBBY · " : ""}${players}. THE BIG SCREEN STARTS THE ROUND. ${SPLIT_RULE}`;
  }

  // The target, big, whenever there's one to aim at.
  const goal = $("split-goal");
  const showGoal = Boolean(r.targetMs) && r.inRound && (r.phase === "countdown" || r.phase === "playing");
  goal.hidden = !showGoal;
  if (showGoal) {
    const goalText = fmt(r.targetMs);
    if ($("split-goal-time").textContent !== goalText) $("split-goal-time").textContent = goalText;
  }
  if (status.textContent !== statusText) status.textContent = statusText;
  if (now > noteUntil && note.textContent !== noteText) note.textContent = noteText;
  if (label.textContent !== labelText) label.textContent = labelText;
  if (runsEl.textContent !== runsText) runsEl.textContent = runsText;
  runsEl.hidden = !runsText;
  splitBtn.classList.toggle("is-waiting", waiting);
  splitBtn.classList.toggle("is-running", split?.runStartAt !== null && split?.runStartAt !== undefined && splitWindowOpen());
  splitLock.disabled = !canLock;
  splitLock.hidden = !(r.phase === "playing" && r.inRound && r.stage === "run");
}

splitBtn.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  pressSplit();
  splitBtn.classList.add("is-pressed");
});
for (const type of ["pointerup", "pointercancel", "pointerleave"]) {
  splitBtn.addEventListener(type, () => splitBtn.classList.remove("is-pressed"));
}
splitBtn.addEventListener("keydown", (event) => {
  if ((event.key === " " || event.key === "Enter") && !event.repeat) {
    event.preventDefault();
    pressSplit();
  }
});
splitLock.addEventListener("click", lockSplit);

// ---------- Rounds: SNAKE ROYALE ----------
// The laptop runs the board and the big screen shows it. This phone sends turns straight
// away and never resends them: a turn that arrives late would steer somewhere unwanted.
const SWIPE_PX = 22; // finger travel that counts as a turn
const SNAKE_RULE = "SLIDE ON THE PAD TO STEER. WATCH THE BIG SCREEN.";
let roundAt = 0; // when the latest round message arrived
let playingSince = -Infinity; // when this phone saw the snake round start

function onSnakeRound(before, msg, now) {
  const sameRound = before?.game === "snake" && before.number === msg.number;
  if (msg.phase === "playing" && !(sameRound && before.phase === "playing")) playingSince = now;
  if (!sameRound || !msg.inRound) return;
  if (before.alive && !msg.alive && msg.phase === "playing") navigator.vibrate?.([200, 60, 200]);
  else if (msg.length > before.length) navigator.vibrate?.(15);
}

const clockText = (ms) => {
  const sec = Math.floor((ms ?? 0) / 1000);
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
};

function outText(cause) {
  const other = cause?.name ?? COLOR_NAMES[cause?.color] ?? "A SNAKE";
  switch (cause?.type) {
    case "wall":
      return "YOU HIT THE WALL";
    case "self":
      return "YOU RAN INTO YOURSELF";
    case "body":
      return `YOU RAN INTO ${other}`;
    case "head":
      return `HEAD-ON WITH ${other}`;
    default:
      return "YOU'RE OUT";
  }
}

// Can this phone's turns move a snake right now?
const steering = () =>
  round?.game === "snake" && round.phase === "playing" && round.inRound && round.alive && !round.over;

function renderSnake(now) {
  const r = round;
  const players = `${r.players} ${r.players === 1 ? "PLAYER" : "PLAYERS"} IN`;
  const between = r.phase === "lobby" || r.phase === "results";
  $("bar").hidden = true;
  $("sync").hidden = true;

  const mine = r.phase === "results" ? r.result : null;
  const result = $("result");
  result.hidden = !mine;
  if (mine) {
    result.textContent = mine.rank === 1 ? (r.youWon ? "YOU WON!" : r.draw ? "DRAW!" : "GAME OVER") : `YOU'RE #${mine.rank}`;
    result.dataset.rank = mine.rank;
  }

  let statusText;
  let noteText;
  let center = "–";

  if (r.phase === "countdown" && r.inRound) {
    const left = Math.max(1, Math.ceil((r.startsInMs - (now - roundAt)) / 1000));
    statusText = `GET READY… YOU'RE ${COLOR_NAMES[joined?.color] ?? ""}, ${r.spawn}`;
    noteText = `KEEP THIS SCREEN ON. ${SNAKE_RULE}`;
    center = String(left);
  } else if (r.phase === "playing" && r.inRound) {
    center = r.alive ? String(r.length) : "OUT";
    if (r.over) {
      statusText = r.youWon ? "YOU WON!" : r.draw ? "DRAW!" : r.winner ? `${r.winner} WINS!` : "GAME OVER";
      noteText = "RESULTS IN A MOMENT…";
    } else if (r.alive) {
      statusText = `LENGTH ${r.length}`;
      noteText = "WATCH THE BIG SCREEN.";
      if (now - playingSince < GO_SHOWN_MS) center = "GO!";
    } else {
      statusText = `OUT! ${outText(r.cause)}`;
      noteText = "WAIT FOR THE NEXT ROUND.";
    }
  } else if (r.phase === "countdown" || r.phase === "playing") {
    statusText = "SNAKE ROYALE IN PROGRESS";
    noteText = "YOU'RE IN THE NEXT ONE. WATCH THE BIG SCREEN.";
  } else if (mine) {
    statusText = `${mine.alive ? "STILL ALIVE" : `OUT AT ${clockText(mine.outAtMs)}`} · LENGTH ${mine.length} · ${mine.rank} OF ${mine.of}`;
    noteText = "THE BIG SCREEN STARTS THE NEXT ONE.";
    center = String(mine.length);
  } else {
    statusText = "NEXT: SNAKE ROYALE";
    const who = r.phase === "lobby" ? `LOBBY · ${players}.` : `${players}.`;
    noteText = `${who} THE BIG SCREEN STARTS THE ROUND. ${SNAKE_RULE}`;
  }

  const status = $("round-status");
  const note = $("round-note");
  if (status.textContent !== statusText) status.textContent = statusText;
  if (now > noteUntil && note.textContent !== noteText) note.textContent = noteText;
  const centerEl = $("pad-center");
  if (centerEl.textContent !== center) centerEl.textContent = center;
  pad.classList.toggle("is-waiting", !steering());
  if (between) flashArrow(null);
}

// Lights the edge arrow for the latest turn, and keeps it lit until the next one.
function flashArrow(dir) {
  for (const edge of pad.querySelectorAll("[data-dir]")) {
    edge.classList.toggle("is-on", edge.dataset.dir === dir);
  }
}

function steer(dir) {
  flashArrow(dir);
  if (steering()) {
    sendMsg({ t: "turn", round: round.number, dir });
    navigator.vibrate?.(10);
  }
}

// Trackpad: one finger at a time. The finger turns the snake each time it travels SWIPE_PX
// in a new direction from where it last turned (so an L-shaped slide is two turns). Travel
// the same way as the last turn just moves the anchor, so a long slide never drifts sideways.
// A tap between rounds flashes this player's card on the big screen.
const padDot = $("pad-dot");
let swipe = null;

function moveDot(event) {
  const box = pad.getBoundingClientRect();
  padDot.style.translate = `${event.clientX - box.left}px ${event.clientY - box.top}px`;
}

pad.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  if (swipe) return;
  swipe = { id: event.pointerId, x: event.clientX, y: event.clientY, last: null };
  moveDot(event);
  padDot.hidden = false;
  pad.classList.add("is-touching");
  if (round && (round.phase === "lobby" || round.phase === "results")) {
    sendMsg({ t: "tap" });
    navigator.vibrate?.(10);
  }
  try {
    pad.setPointerCapture(event.pointerId);
  } catch {
    // Some browsers refuse capture for a pointer that already ended; the slide still works.
  }
});

pad.addEventListener("pointermove", (event) => {
  if (!swipe || event.pointerId !== swipe.id) return;
  moveDot(event);
  const dx = event.clientX - swipe.x;
  const dy = event.clientY - swipe.y;
  if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_PX) return;
  const dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : dy > 0 ? "down" : "up";
  swipe.x = event.clientX;
  swipe.y = event.clientY;
  if (dir === swipe.last) return;
  swipe.last = dir;
  steer(dir);
});

for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
  pad.addEventListener(type, (event) => {
    if (swipe?.id !== event.pointerId) return;
    swipe = null;
    padDot.hidden = true;
    pad.classList.remove("is-touching");
  });
}

// Keyboard (a laptop window standing in for a phone): arrows or WASD.
const KEY_DIRS = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  w: "up",
  s: "down",
  a: "left",
  d: "right",
};

document.addEventListener("keydown", (event) => {
  if (views.play.hidden || round?.game !== "snake" || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
  const dir = KEY_DIRS[event.key.length === 1 ? event.key.toLowerCase() : event.key];
  if (!dir) return;
  event.preventDefault();
  steer(dir);
  if (round && (round.phase === "lobby" || round.phase === "results")) sendMsg({ t: "tap" });
});


// ---------- Fake game updates ----------
function startUpdates() {
  stopUpdates();
  const hz = joined?.updateHz ?? 10;
  updateTimer = setInterval(() => {
    const phase = (performance.now() % SLIDE_PERIOD_MS) / SLIDE_PERIOD_MS;
    const x = phase < 0.5 ? phase * 2 : 2 - phase * 2;
    sendMsg({ t: "update", x: Math.round(x * 1000) / 1000 });
  }, 1000 / hz);
}

function stopUpdates() {
  clearInterval(updateTimer);
  updateTimer = 0;
}

// ---------- Screen stays on while in the party ----------
async function keepAwake() {
  if (!("wakeLock" in navigator) || document.hidden || wakeLock || !joined) return;
  try {
    const lock = await navigator.wakeLock.request("screen");
    if (!joined || wakeLock) {
      // Left the party (or got a lock twice) while this request was pending.
      lock.release().catch(() => {});
      return;
    }
    wakeLock = lock;
    lock.addEventListener("release", () => {
      if (wakeLock === lock) wakeLock = null;
    });
  } catch {
    // Not allowed here (plain http, or low battery mode): the phone may dim.
  }
}

function releaseWakeLock() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

// ---------- Actions ----------
function startJoin() {
  const checked = normalizeName(name);
  if (checked.error) {
    showJoin(checked.error);
    return;
  }
  if (views.join.hidden) showJoin();
  joinBtn.disabled = true;
  joinBtn.textContent = "JOINING…";
  wantOnline = true;
  retryMs = RETRY_MIN_MS;
  offlineSince = 0;
  connect();
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const checked = normalizeName(nameInput.value);
  if (checked.error) {
    showJoin(checked.error);
    nameInput.focus();
    return;
  }
  const picked = form.querySelector('input[name="network"]:checked');
  if (picked) network = picked.value;
  name = checked.name;
  writeStore({ name, network });
  nameInput.blur();
  startJoin();
});

nameInput.addEventListener("input", () => {
  if (nameError.textContent) {
    nameError.textContent = "";
    nameInput.setAttribute("aria-invalid", "false");
  }
});

function tap() {
  const now = performance.now();
  if (battle) {
    // Taps before GO, after TIME, once the bar is full, or after the round ended don't count.
    const live = round && (round.phase === "countdown" || round.phase === "playing");
    if (!live || battleState(now) !== "playing") return;
    battle.bar.tap(now);
    saveBattle();
    if (battle.bar.filledMs !== null) {
      navigator.vibrate?.([60, 40, 160]);
      sendDue(now);
    } else {
      navigator.vibrate?.(8);
    }
    renderRound();
    return;
  }
  sendMsg({ t: "tap" });
  navigator.vibrate?.(12);
}

tapBtn.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  tap();
  tapBtn.classList.add("is-pressed");
});
for (const type of ["pointerup", "pointercancel", "pointerleave"]) {
  tapBtn.addEventListener(type, () => tapBtn.classList.remove("is-pressed"));
}
// Keyboard users: pointerdown already covers touch and mouse.
tapBtn.addEventListener("keydown", (event) => {
  if ((event.key === " " || event.key === "Enter") && !event.repeat) {
    event.preventDefault();
    tap();
  }
});

$("leave").addEventListener("click", () => {
  const sock = ws;
  if (sock?.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ t: "leave" }));
  // Detach first so a quick JOIN gets a fresh connection; the old one closes once
  // the leave message has had a moment to go out.
  ws = null;
  goOffline();
  forget();
  if (sock) setTimeout(() => sock.close(), 300);
  showJoin();
});

// Locked screen or another app: tell the server, so a sleeping page isn't counted as lag.
// Coming back: carry on, and reconnect straight away if the connection dropped meanwhile.
function onVisible() {
  lastHeardAt = performance.now();
  if (!wantOnline) return;
  if (ws && ws.readyState > WebSocket.OPEN) ws = null;
  if (!ws) {
    retryMs = RETRY_MIN_MS;
    offlineSince = 0;
    connect();
    return;
  }
  if (joined && ws.readyState === WebSocket.OPEN) {
    sendMsg({ t: "resume" });
    startUpdates();
    keepAwake();
  }
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    onVisible();
    return;
  }
  stopUpdates();
  if (joined) sendMsg({ t: "pause" });
});
// Leaving the page (reload, closing the tab): make sure the latest bar is saved.
window.addEventListener("pagehide", () => {
  saveBattle();
  saveSplit();
});

// Back from the back/forward cache: its connection was closed while it was stored.
window.addEventListener("pageshow", (event) => {
  if (event.persisted) onVisible();
});
window.addEventListener("online", () => {
  if (wantOnline && !ws) connect();
});

// Stop double-tap zoom from getting in the way.
document.addEventListener("dblclick", (event) => event.preventDefault(), { passive: false });

// ---------- Start ----------
// A battle this tab was in the middle of (the page reloaded): kept until the server says where things stand.
battle = loadBattle();
split = loadSplit();
if (sessionGet(JOINED_KEY) === "1" && name) {
  startJoin();
} else {
  showJoin();
}
