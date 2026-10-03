// A phone in PICTIONARY: join, get put in a team, then guess what's being drawn on the big
// screen (or, on your turn, pick a word and go up to draw it). It reconnects by itself, and
// keeps its team after a reload or a locked screen: the player id is remembered on the phone.
// Testing on one laptop: add ?p=2, ?p=3 … to the address to be a different player per window.
import { normalizeName } from "../../js/shared/names.js";

const $ = (id) => document.getElementById(id);
const TEAM_KEYS = ["red", "blue", "yellow", "green", "black", "white"];
const TEAM_NAMES = ["RED", "BLUE", "YELLOW", "GREEN", "BLACK", "WHITE"];
const LEVELS = ["EASY", "MEDIUM", "HARD"];
const SUFFIX = (new URLSearchParams(location.search).get("p") ?? "").replace(/[^A-Za-z0-9]/g, "").slice(0, 8);
const STORE_KEY = `gdg-pictionary${SUFFIX ? `-${SUFFIX}` : ""}`;
const RETRY_MIN_MS = 500;
const RETRY_MAX_MS = 4000;
// Visible and still not back in after this long: the link probably changed.
const GIVE_UP_MS = 45_000;
// The server pings every 2s, so this much silence means the connection is stuck.
const STALE_OPEN_MS = 6000;
const STALE_CONNECTING_MS = 8000;
const GUESS_GAP_MS = 650;

const views = { join: $("view-join"), play: $("view-play"), msg: $("view-msg") };
const panels = ["lobby", "wait", "drawer", "guess", "reveal", "results"];

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
    // Private mode: the phone just won't remember.
  }
}

function newClientId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  // randomUUID needs https; the same-Wi-Fi mode runs over plain http.
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
}

let stored = readStore();
let clientId = stored.id ?? newClientId();
writeStore({ id: clientId });

let name = stored.name ?? "";
let ws = null;
let wantOnline = false;
let joined = null; // { name, team }
let view = null;
let offset = 0;
let retryMs = RETRY_MIN_MS;
let retryTimer = 0;
let offlineSince = 0;
let lastHeardAt = 0;
let wakeLock = null;
let seq = 0;
let history = []; // this turn's guesses: { seq, text, status, points }
let historyTurn = null;
let lastGuessAt = 0;
let buzzedTurn = null;
// Set when this phone was in the game before (a reload), so the server can say if that spot is gone.
let joinAsRejoin = false;

const serverNow = () => Date.now() + offset;

// ---------- Views ----------
function show(key) {
  for (const [k, el] of Object.entries(views)) el.hidden = k !== key;
}

function showPanel(key) {
  for (const p of panels) $(`panel-${p}`).hidden = p !== key;
}

function showMessage(title, text, button, action) {
  $("msg-title").textContent = title;
  $("msg-text").textContent = text;
  const btn = $("msg-btn");
  btn.textContent = button;
  btn.onclick = action;
  show("msg");
}

function showJoin() {
  $("name").value = name;
  $("join-btn").disabled = false;
  $("join-btn").textContent = "<JOIN>";
  show("join");
}

function setConn(text) {
  const el = $("conn");
  el.hidden = !text;
  el.textContent = text ?? "";
}

// ---------- Joining ----------
$("join-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const checked = normalizeName($("name").value);
  const input = $("name");
  if (checked.error) {
    $("name-error").textContent = checked.error;
    input.setAttribute("aria-invalid", "true");
    return;
  }
  $("name-error").textContent = "";
  input.removeAttribute("aria-invalid");
  name = checked.name;
  writeStore({ name });
  startJoin(false);
});

function startJoin(rejoin) {
  wantOnline = true;
  offlineSince = 0;
  retryMs = RETRY_MIN_MS;
  joinAsRejoin = rejoin;
  $("join-btn").disabled = true;
  $("join-btn").textContent = "JOINING…";
  connect();
}

// ---------- Connection ----------
function sendMsg(msg) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
    return true;
  }
  return false;
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
    if (ws !== sock || !wantOnline) {
      sock.close();
      return;
    }
    retryMs = RETRY_MIN_MS;
    lastHeardAt = performance.now();
    sock.send(JSON.stringify({ t: "join", clientId, name, rejoin: joined !== null || joinAsRejoin }));
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
    if (!wantOnline) return;
    if (event.code === 4001) {
      goOffline();
      showMessage("OPEN ELSEWHERE", "YOU JOINED FROM ANOTHER TAB OR WINDOW.", "PLAY HERE", () => startJoin(true));
      return;
    }
    if (event.code === 4002) return; // removed: the "kicked" message already said so
    retryLater();
  };
}

function retryLater() {
  const now = performance.now();
  offlineSince ||= now;
  if (!document.hidden && now - offlineSince > GIVE_UP_MS) {
    goOffline();
    showMessage("LOST IT", "CAN'T REACH THE GAME. TRY MOBILE DATA, OR SCAN THE QR CODE ON THE BIG SCREEN AGAIN.", "TRY AGAIN", () => startJoin(joined !== null));
    return;
  }
  setConn(joined ? "RECONNECTING…" : null);
  // A little randomness, so a hundred phones dropped by the same Wi-Fi blip don't all retry at once.
  retryTimer = setTimeout(connect, retryMs * (0.6 + Math.random() * 0.8));
  retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
}

// A connection can hang without closing. No word from the server for a while: start again.
setInterval(() => {
  if (!ws || !wantOnline || document.hidden) return;
  const limit = ws.readyState === WebSocket.OPEN ? STALE_OPEN_MS : STALE_CONNECTING_MS;
  if (performance.now() - lastHeardAt < limit) return;
  const stale = ws;
  ws = null;
  stale.close();
  retryMs = RETRY_MIN_MS;
  retryLater();
}, 1000);

function goOffline() {
  wantOnline = false;
  clearTimeout(retryTimer);
  offlineSince = 0;
  releaseWakeLock();
  setConn(null);
  const sock = ws;
  ws = null;
  sock?.close();
}

function forget() {
  joined = null;
  writeStore({ joined: false });
}

function handle(msg) {
  switch (msg.t) {
    case "ping":
      offset = msg.s - Date.now();
      sendMsg({ t: "pong" });
      return;
    case "joined":
      joined = { name: msg.name, team: msg.team };
      joinAsRejoin = false;
      offlineSince = 0;
      writeStore({ joined: true, name: msg.name });
      setConn(null);
      $("you").hidden = false;
      show("play");
      keepAwake();
      return;
    case "view":
      offset = msg.serverNow - Date.now();
      view = msg;
      render();
      return;
    case "guessed":
      onGuessed(msg);
      return;
    case "error":
      if (!joined) {
        goOffline();
        showJoin();
        $("name-error").textContent = msg.message;
      }
      return;
    case "full":
      goOffline();
      forget();
      showMessage("THE GAME IS FULL", "ASK THE HOST, OR WATCH THE BIG SCREEN.", "TRY AGAIN", () => startJoin(false));
      return;
    case "expired":
      // The game restarted or forgot this phone: join again as new, same name.
      joined = null;
      joinAsRejoin = false;
      sendMsg({ t: "join", clientId, name, rejoin: false });
      return;
    case "kicked":
      goOffline();
      forget();
      history = [];
      renderHistory();
      clientId = newClientId();
      writeStore({ id: clientId });
      showMessage("REMOVED", "THE HOST TOOK YOU OUT OF THE GAME. JOIN AGAIN WITH A DIFFERENT NAME.", "JOIN AGAIN", showJoin);
      return;
    case "left":
      goOffline();
      forget();
      showJoin();
      return;
    default:
  }
}

// ---------- The game ----------
// The big word: as large as fits the card, and broken only between words, never inside one.
function setWord(el, text) {
  if (el.textContent !== text) el.textContent = text;
  let size = Math.min(48, innerWidth * 0.11);
  el.style.fontSize = `${size}px`;
  while (size > 16 && el.scrollWidth > el.clientWidth + 1) {
    size -= 1;
    el.style.fontSize = `${size}px`;
  }
}

function teamClass(i) {
  return `team team--${TEAM_KEYS[i]}`;
}

function render() {
  if (!view || !joined) return;
  const you = view.you ?? joined;
  $("you").className = `you ${teamClass(you.team)}`;
  $("you-team").textContent = TEAM_NAMES[you.team];
  $("you-name").textContent = you.name;
  document.body.dataset.phase = view.phase;

  const turn = view.turn;
  if (turn && turn.number !== historyTurn) {
    historyTurn = turn.number;
    history = [];
    renderHistory();
  }

  renderScores();
  if (view.phase === "lobby" || !turn) {
    if (view.phase === "results") renderResults();
    else showPanel("lobby");
    return;
  }

  const drawerTeam = TEAM_NAMES[turn.team];
  if (turn.isDrawer && view.phase !== "reveal") {
    showPanel("drawer");
    if (view.phase === "pick") {
      $("drawer-pick").hidden = false;
      $("drawer-word").hidden = true;
      renderChoices(turn);
      if (buzzedTurn !== turn.number) {
        buzzedTurn = turn.number;
        navigator.vibrate?.([200, 100, 200]);
      }
    } else {
      $("drawer-pick").hidden = true;
      $("drawer-word").hidden = false;
      setWord($("word"), (turn.word ?? "").toUpperCase());
      $("drawer-text").textContent =
        view.phase === "ready"
          ? "GO TO THE LAPTOP AND DRAW IT. THE CLOCK STARTS WITH YOUR FIRST LINE. NO LETTERS, NO TALKING."
          : "KEEP DRAWING! NO LETTERS, NO NUMBERS, NO TALKING.";
    }
    return;
  }

  if (view.phase === "pick" || view.phase === "ready") {
    showPanel("wait");
    $("wait-kicker").textContent = turn.yourTeam ? "YOUR TEAM IS UP" : `${drawerTeam} TEAM IS UP`;
    $("wait-title").textContent = `${turn.drawer} IS DRAWING`;
    $("wait-text").textContent = turn.yourTeam ? "YOUR TEAM CAN'T GUESS THIS ONE. CHEER THEM ON!" : "GET READY TO GUESS. WATCH THE BIG SCREEN.";
    return;
  }

  // Your own team is drawing: nothing to type, so say what to do instead of showing a locked box.
  if (view.phase === "draw" && turn.yourTeam) {
    showPanel("wait");
    $("wait-kicker").textContent = "YOUR TEAM IS DRAWING";
    $("wait-title").textContent = `CHEER FOR ${turn.drawer}!`;
    $("wait-text").textContent = "NO GUESSING THIS TURN. YOUR TEAM SCORES WHEN THE OTHER TEAMS GET IT.";
    return;
  }

  if (view.phase === "draw") {
    showPanel("guess");
    renderPattern(turn.pattern);
    const form = $("guess-form");
    const gotIt = $("got-it");
    if (turn.yourTeam) {
      $("guess-who").textContent = `YOUR TEAM IS DRAWING (${turn.drawer}). NO GUESSING, JUST CHEER!`;
      form.hidden = true;
      gotIt.hidden = true;
    } else if (turn.guessed !== null) {
      $("guess-who").textContent = `${turn.drawer} (${drawerTeam}) IS DRAWING`;
      form.hidden = true;
      gotIt.hidden = false;
      gotIt.textContent = `YOU GOT IT! +${turn.guessed}`;
      $("guess").blur();
    } else {
      $("guess-who").textContent = `${turn.drawer} (${drawerTeam}) IS DRAWING`;
      const wasHidden = form.hidden;
      form.hidden = false;
      gotIt.hidden = true;
      if (wasHidden) $("guess").focus({ preventScroll: true });
    }
    return;
  }

  if (view.phase === "reveal") {
    showPanel("reveal");
    // Skipped before a word was picked: nothing to reveal, so don't pretend there was a word.
    $("reveal-label").hidden = !turn.word;
    $("reveal-word").hidden = !turn.word;
    if (turn.word) setWord($("reveal-word"), turn.word.toUpperCase());
    const pts = turn.teamPoints?.[you.team] ?? 0;
    $("reveal-kicker").textContent = !turn.word
      ? "THIS TURN WAS SKIPPED"
      : turn.yourTeam
        ? "YOUR TEAM DREW"
        : turn.guessed !== null
          ? `YOU GOT IT! +${turn.guessed}`
          : "YOU DIDN'T GET THIS ONE";
    $("reveal-points").textContent = `${TEAM_NAMES[you.team]} TEAM +${pts}`;
  }
}

function renderChoices(turn) {
  const box = $("choices");
  const key = `${turn.number}|${turn.drawer}|${(turn.choices ?? []).join("|")}`;
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  box.replaceChildren(
    ...(turn.choices ?? []).map((word, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `btn choice choice--${i}`;
      b.innerHTML = `<small>${LEVELS[i]}</small>`;
      b.append(document.createTextNode(word.toUpperCase()));
      b.addEventListener("click", () => {
        if (sendMsg({ t: "pick", index: i, turn: turn.number })) {
          for (const other of box.children) other.disabled = true;
          b.classList.add("is-picked");
        }
      });
      return b;
    })
  );
}

function renderPattern(text) {
  const el = $("pattern");
  el.replaceChildren(
    ...(text ?? "").split(" ").map((word) => {
      const w = document.createElement("span");
      w.className = "pattern__word";
      for (const ch of word) {
        const c = document.createElement("span");
        c.className = `pattern__char${ch === "_" ? "" : " is-shown"}`;
        c.textContent = ch === "_" ? "" : ch;
        w.append(c);
      }
      return w;
    })
  );
  // A long word shrinks to fit beside the clock instead of running under it.
  let size = 26;
  el.style.fontSize = `${size}px`;
  while (size > 13 && el.scrollWidth > el.clientWidth + 1) {
    size -= 1;
    el.style.fontSize = `${size}px`;
  }
  const letters = (text ?? "").replace(/ /g, "").length;
  const words = (text ?? "").split(" ").filter(Boolean).length;
  el.setAttribute("aria-label", `${letters} letters`);
  $("pattern-count").textContent = `${letters} LETTERS${words > 1 ? ` · ${words} WORDS` : ""}`;
}

function renderScores() {
  const list = $("mini-scores");
  const show = view && view.phase !== "lobby" && view.phase !== "results";
  $("scores-label").hidden = !show;
  if (!show) {
    list.replaceChildren();
    return;
  }
  list.replaceChildren(
    ...view.scores.map((score, i) => {
      const li = document.createElement("li");
      li.className = `${teamClass(i)}${view.you?.team === i ? " is-you" : ""}`;
      li.innerHTML = `<span>${TEAM_NAMES[i]}</span><b class="t-score">${score}</b>`;
      return li;
    })
  );
}

function ordinal(n) {
  return n === 1 ? "1ST" : n === 2 ? "2ND" : n === 3 ? "3RD" : `${n}TH`;
}

function renderResults() {
  showPanel("results");
  const { ranking } = view.results ?? { ranking: [] };
  const mine = ranking.find((r) => r.team === view.you?.team);
  const shared = mine ? ranking.filter((r) => r.rank === mine.rank).length > 1 : false;
  $("result-title").textContent = !mine
    ? "THANKS FOR PLAYING!"
    : mine.rank === 1
      ? shared
        ? "A TIE FOR 1ST!"
        : "YOUR TEAM WON!"
      : `YOUR TEAM CAME ${shared ? "JOINT " : ""}${ordinal(mine.rank)}`;
  $("result-ranking").replaceChildren(
    ...ranking.map((r) => {
      const li = document.createElement("li");
      li.className = `${teamClass(r.team)}${r.team === view.you?.team ? " is-you" : ""}`;
      li.innerHTML = `<span>${ordinal(r.rank)}</span><b>${TEAM_NAMES[r.team]}</b><span class="t-score">${r.score}</span>`;
      return li;
    })
  );
  $("mini-scores").replaceChildren();
}

// ---------- Guessing ----------
// Pressing GUESS mustn't take the focus from the box, or the phone's keyboard closes after every guess.
$("guess-btn").addEventListener("pointerdown", (event) => event.preventDefault());

$("guess-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = $("guess");
  const text = input.value.replace(/\s+/g, " ").trim();
  if (!text || !view?.turn?.canGuess) return;
  const now = performance.now();
  if (now - lastGuessAt < GUESS_GAP_MS) return;
  lastGuessAt = now;
  seq += 1;
  if (!sendMsg({ t: "guess", text, turn: view.turn.number, seq })) {
    history.unshift({ seq, text, status: "offline" });
  } else {
    history.unshift({ seq, text, status: "sent" });
  }
  history = history.slice(0, 12);
  renderHistory();
  input.value = "";
  // Keep the keyboard up for the next guess.
  input.focus({ preventScroll: true });
  const btn = $("guess-btn");
  btn.disabled = true;
  setTimeout(() => {
    btn.disabled = false;
  }, GUESS_GAP_MS);
});

function onGuessed(msg) {
  const entry = history.find((h) => h.seq === msg.seq);
  if (entry) {
    entry.status = msg.status;
    entry.points = msg.points;
  }
  renderHistory();
  if (msg.status === "correct") navigator.vibrate?.(120);
}

const STATUS_TEXT = {
  sent: "…",
  offline: "NOT SENT",
  correct: "GOT IT!",
  close: "CLOSE!",
  wrong: "NO",
  "too-fast": "TOO FAST",
  "not-now": "TOO LATE",
  already: "GOT IT",
  "drawing-team": "NOT YOUR TURN",
  ignored: "–",
};

function renderHistory() {
  $("history").replaceChildren(
    ...history.map((h) => {
      const li = document.createElement("li");
      li.className = `history__item is-${h.status}`;
      const text = document.createElement("span");
      text.className = "history__text";
      text.textContent = h.text.toUpperCase();
      const status = document.createElement("b");
      status.className = "history__status";
      status.textContent = h.status === "correct" && h.points ? `+${h.points}` : STATUS_TEXT[h.status] ?? "";
      li.append(text, status);
      return li;
    })
  );
}

// ---------- Clocks ----------
setInterval(() => {
  const turn = view?.turn;
  if (!turn) return;
  if (view.phase === "draw") {
    const left = Math.max(0, Math.ceil((turn.drawEndsAt - serverNow()) / 1000));
    const clock = $("clock");
    clock.textContent = String(left);
    clock.classList.toggle("is-low", left <= 10);
  } else if (view.phase === "pick" && turn.isDrawer) {
    const left = Math.max(0, Math.ceil((turn.pickEndsAt - serverNow()) / 1000));
    $("pick-left").textContent = `ONE IS PICKED FOR YOU IN ${left}S`;
  }
}, 250);

// ---------- Keep the screen on (https only) ----------
async function keepAwake() {
  if (!("wakeLock" in navigator) || document.hidden || wakeLock || !joined) return;
  try {
    const lock = await navigator.wakeLock.request("screen");
    if (!joined || wakeLock) {
      lock.release().catch(() => {});
      return;
    }
    wakeLock = lock;
    lock.addEventListener("release", () => {
      if (wakeLock === lock) wakeLock = null;
    });
  } catch {
    // Not allowed (plain http, low battery): the phone may dim. That's fine.
  }
}

function releaseWakeLock() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

// Back on the page: reconnect straight away if the connection dropped meanwhile.
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
  keepAwake();
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) onVisible();
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) onVisible();
});
window.addEventListener("online", () => {
  if (wantOnline && !ws) connect();
});
// Stop double-tap zoom from getting in the way.
document.addEventListener("dblclick", (event) => event.preventDefault(), { passive: false });

// ---------- Start ----------
if (stored.joined && name) {
  setConn("JOINING…");
  show("play");
  showPanel("lobby");
  startJoin(true);
} else {
  showJoin();
}
