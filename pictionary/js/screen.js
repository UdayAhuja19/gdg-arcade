// The PICTIONARY projector. The host runs the game here, the drawer draws here (mouse, pen or
// touch), and the room watches. The drawing stays on this laptop: only "the first stroke
// happened" goes to the server, to start the clock.

const $ = (id) => document.getElementById(id);
const TEAM_KEYS = ["red", "blue", "yellow", "green", "black", "white"];
const TEAM_NAMES = ["RED", "BLUE", "YELLOW", "GREEN", "BLACK", "WHITE"];
const ROUNDS = [1, 2, 3];
const TIMES = [60, 80, 100];
// The canvas keeps its own coordinates so a resize (or another screen) never distorts a drawing.
const W = 1600;
const H = 1000;
const COLORS = [
  { key: "ink", value: "#111111", label: "BLACK" },
  { key: "red", value: "#ea4335", label: "RED" },
  { key: "blue", value: "#4285f4", label: "BLUE" },
  { key: "yellow", value: "#fbbc04", label: "YELLOW" },
  { key: "green", value: "#34a853", label: "GREEN" },
  { key: "eraser", value: "#ffffff", label: "ERASER" },
];
const SIZES = [
  { key: "s", value: 6, label: "THIN" },
  { key: "m", value: 14, label: "MEDIUM" },
  { key: "l", value: 32, label: "THICK" },
];
const FEED_MAX = 40;
const REMOVE_ARM_MS = 3000;

let ws = null;
let view = null;
let offset = 0; // server clock minus this one (the same laptop, so about 0)
let join = { url: null, qr: null, tunnel: "off" };
let turnKey = null; // this game and turn, so a drawing is never shown in the wrong one
let feed = [];
let armed = null; // { id, until } a name clicked once, waiting for the second click
let toastTimer = 0;

const serverNow = () => Date.now() + offset;

// ---------- Connection ----------
function connect() {
  const url = new URL("ws", location.href);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const sock = new WebSocket(url);
  ws = sock;
  sock.onopen = () => setStatus();
  sock.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    handle(msg);
  };
  sock.onclose = () => {
    if (ws !== sock) return;
    ws = null;
    setStatus();
    setTimeout(connect, 1000);
  };
}

function sendMsg(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function handle(msg) {
  if (msg.t === "state") {
    offset = msg.serverNow - Date.now();
    view = msg;
    render();
  } else if (msg.t === "join") {
    join = msg;
    renderJoin();
    setStatus();
  } else if (msg.t === "feed") {
    addFeed(msg);
  } else if (msg.t === "notice") {
    toast(msg.message);
  }
}

function setStatus() {
  const el = $("status");
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    el.textContent = "RECONNECTING TO THE GAME…";
    el.className = "pill pill--sm screen__status is-bad";
    return;
  }
  const label = {
    live: "TUNNEL ON",
    starting: "STARTING THE TUNNEL…",
    down: "TUNNEL RESTARTING…",
    missing: "CLOUDFLARED MISSING",
    lan: "SAME WI-FI",
    off: "THIS LAPTOP ONLY",
  }[join.tunnel] ?? "";
  el.textContent = view ? `${label} · ${view.online} ONLINE` : label;
  el.className = `pill pill--sm screen__status${join.tunnel === "live" || join.tunnel === "lan" || join.tunnel === "off" ? "" : " is-bad"}`;
}

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 3500);
}

// Shrinks an element's text a pixel at a time until it fits, so nothing on the projector is ever
// cut off or broken mid-word. `boxes` must not overflow (the element itself by default); a box
// given as [element, "x"] is only checked across, for tight display type whose letters poke out
// of a line height under 1.
function fitText(el, max, min, boxes = el) {
  const list = [].concat(boxes).map((b) => (Array.isArray(b) ? b : [b, "xy"]));
  const over = () =>
    list.some(([b, axis]) => b.scrollWidth > b.clientWidth + 1 || (axis === "xy" && b.scrollHeight > b.clientHeight + 1));
  let size = max;
  el.style.fontSize = `${size}px`;
  while (size > min && over()) {
    size -= 1;
    el.style.fontSize = `${size}px`;
  }
}

// Base sizes scale with the screen, like the CSS clamp()s: 1 unit = 1% of the viewport height.
const vh = (n) => (innerHeight * n) / 100;

// ---------- Ask before something that can't be undone ----------
let modalAnswer = null;
function ask(title, text, yes) {
  $("modal-title").textContent = title;
  $("modal-text").textContent = text;
  $("modal-yes").textContent = yes;
  $("modal").hidden = false;
  $("modal-no").focus();
  return new Promise((resolve) => {
    modalAnswer = resolve;
  });
}
function answer(value) {
  $("modal").hidden = true;
  modalAnswer?.(value);
  modalAnswer = null;
}
$("modal-yes").addEventListener("click", () => answer(true));
$("modal-no").addEventListener("click", () => answer(false));
$("modal").addEventListener("click", (event) => {
  if (event.target === $("modal")) answer(false);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("modal").hidden) answer(false);
});

// ---------- Views ----------
function showView(name) {
  const changed = document.body.dataset.view !== name;
  for (const key of ["connect", "lobby", "game", "results"]) $(`view-${key}`).hidden = key !== name;
  document.body.dataset.view = name;
  if (changed && name === "game") layoutStage();
  if (changed && name === "lobby") {
    lobbySig = "";
    requestAnimationFrame(fitJoin);
  }
}

function render() {
  setStatus();
  if (view.phase === "lobby") {
    showView("lobby");
    renderLobby();
  } else if (view.phase === "results") {
    showView("results");
    renderResults();
  } else {
    showView("game");
    renderGame();
  }
}

function teamClass(i) {
  return `team team--${TEAM_KEYS[i]}`;
}

// ---------- Lobby ----------
// The link, in capitals like everything else (web addresses don't mind): the part people type
// is bold, a tunnel's ".TRYCLOUDFLARE.COM" is quieter, and it can wrap after a hyphen.
function renderJoin() {
  $("qr").innerHTML = join.qr ?? "";
  const el = $("join-url");
  if (!join.url) {
    el.textContent = join.tunnel === "missing" ? "INSTALL CLOUDFLARED" : "STARTING…";
  } else {
    const host = join.url.replace(/^https?:\/\//, "").replace(/\/$/, "").toUpperCase();
    const tail = host.endsWith(".TRYCLOUDFLARE.COM") ? ".TRYCLOUDFLARE.COM" : "";
    const main = host.slice(0, host.length - tail.length);
    el.innerHTML = `<span class="join-card__host">${escape(main)}</span>${tail ? `<span class="join-card__tail">${tail}</span>` : ""}`;
  }
  fitJoin();
}

function fitJoin() {
  if ($("view-lobby").hidden) return;
  const el = $("join-url");
  el.style.whiteSpace = "nowrap";
  fitText(el, Math.min(vh(2.4), 26), 11);
  // Still too long at the smallest size: let it wrap, but only after a hyphen.
  if (el.scrollWidth > el.clientWidth + 1) {
    el.style.whiteSpace = "normal";
    const host = el.querySelector(".join-card__host");
    if (host && !host.innerHTML.includes("<wbr>")) host.innerHTML = host.innerHTML.replace(/-/g, "-<wbr>");
  }
  fitText($("join-card-title"), Math.min(vh(4.2), 46), 18, [[$("join-card-title"), "x"]]);
}

function segmented(el, values, current, unit, onPick) {
  el.replaceChildren(
    ...values.map((v) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "segmented__btn";
      b.textContent = `${v}${unit}`;
      b.setAttribute("aria-pressed", String(v === current));
      b.addEventListener("click", () => onPick(v));
      return b;
    })
  );
}

// The lobby is rebuilt only when something in it changed: rebuilding on every update would
// replace a button between the host's mouse-down and mouse-up, and the click would be lost.
let lobbySig = "";
function renderLobby() {
  const { settings } = view;
  const sig = JSON.stringify([view.roster, settings, view.online, view.teams.map((t) => t.online), armed?.id ?? null]);
  if (sig === lobbySig) return;
  lobbySig = sig;
  $("online-count").textContent = view.online;
  $("online-label").textContent = view.online === 1 ? "PLAYER IN" : "PLAYERS IN";
  segmented($("set-rounds"), ROUNDS, settings.rounds, "", (rounds) => sendMsg({ t: "settings", rounds }));
  segmented($("set-time"), TIMES, settings.drawSeconds, "S", (drawSeconds) => sendMsg({ t: "settings", drawSeconds }));
  const teamsWithPlayers = view.teams.filter((t) => t.online > 0).length;
  const turns = settings.rounds * 6;
  const minutes = Math.round((turns * (settings.drawSeconds + 35)) / 60);
  $("settings-note").textContent = `${turns} TURNS · ABOUT ${minutes} MINUTES`;
  $("start").disabled = teamsWithPlayers < 2;

  const now = Date.now();
  if (armed && armed.until < now) armed = null;
  $("teams").replaceChildren(
    ...view.teams.map((t, i) => {
      const card = document.createElement("article");
      card.className = `team-card ${teamClass(i)}`;
      const head = document.createElement("header");
      head.className = "team-card__head";
      head.innerHTML = `<span class="team-card__name">${TEAM_NAMES[i]}</span><span class="team-card__count t-score">${t.online}</span>`;
      const list = document.createElement("ul");
      list.className = "team-card__names";
      for (const p of view.roster?.[i] ?? []) {
        const li = document.createElement("li");
        const b = document.createElement("button");
        b.type = "button";
        b.className = `chip${p.online ? "" : " is-offline"}${armed?.id === p.id ? " is-armed" : ""}`;
        b.textContent = armed?.id === p.id ? "REMOVE?" : p.name;
        b.title = p.online ? p.name : `${p.name} (OFFLINE)`;
        b.addEventListener("click", () => armRemove(p.id, renderLobby));
        li.append(b);
        list.append(li);
      }
      if (!list.children.length) {
        const li = document.createElement("li");
        li.className = "team-card__empty";
        li.textContent = "NOBODY YET";
        list.append(li);
      }
      card.append(head, list);
      return card;
    })
  );
  fitChips();
}

// Every name stays inside its team's card: with a full room, all the name chips shrink together,
// down to a size that's still readable on the projector. If a card still can't hold everyone, its
// last names fold into a "+12 MORE" chip instead of being cut off.
function fitChips() {
  const teams = $("teams");
  if ($("view-lobby").hidden) return;
  const lists = [...teams.querySelectorAll(".team-card__names")];
  const overflows = (l) => l.scrollHeight > l.clientHeight + 1 || l.scrollWidth > l.clientWidth + 1;
  for (const l of lists) {
    l.querySelector(".chip--more")?.remove();
    for (const li of l.children) li.hidden = false;
  }
  const min = Math.max(9, vh(1));
  let size = Math.min(vh(1.55), 17);
  teams.style.setProperty("--chip-size", `${size}px`);
  while (size > min && lists.some(overflows)) {
    size = Math.max(min, size - 0.5);
    teams.style.setProperty("--chip-size", `${size}px`);
  }
  for (const l of lists) {
    if (!overflows(l)) continue;
    const more = document.createElement("li");
    more.className = "chip chip--more";
    l.append(more);
    const names = [...l.children].filter((li) => li !== more);
    let hidden = 0;
    while (overflows(l) && hidden < names.length) {
      hidden += 1;
      names[names.length - hidden].hidden = true;
      more.textContent = `+${hidden} MORE`;
    }
  }
}

// A name clicked once asks "REMOVE?"; a second click within 3 seconds removes that player.
function armRemove(id, redraw) {
  if (!id) return;
  if (armed?.id === id && armed.until > Date.now()) {
    sendMsg({ t: "kick", id });
    armed = null;
    redraw();
    return;
  }
  armed = { id, until: Date.now() + REMOVE_ARM_MS };
  redraw();
  setTimeout(() => {
    if (armed?.id === id) {
      armed = null;
      redraw();
    }
  }, REMOVE_ARM_MS);
}

$("start").addEventListener("click", () => sendMsg({ t: "start" }));
$("balance").addEventListener("click", () => sendMsg({ t: "balance" }));
// Removing everyone can't be undone, so it asks first, by name and number. A dialog can't be set
// off by a stray key press the way a focused button can.
$("clear").addEventListener("click", async (event) => {
  event.currentTarget.blur();
  const count = view?.players ?? 0;
  if (count === 0) return toast("NOBODY TO REMOVE.");
  const sure = await ask(`REMOVE ALL ${count} PLAYERS?`, "THEIR PHONES GO BACK TO THE JOIN SCREEN AND THE TEAMS START AGAIN.", "YES, REMOVE EVERYONE");
  if (sure) sendMsg({ t: "clear" });
});

// ---------- Game ----------
function renderGame() {
  const { turn } = view;
  if (!turn) return;
  if (turn.key !== turnKey) newTurn(turn.key);

  $("turn-label").textContent = `TURN ${turn.number}/${turn.total} · ROUND ${turn.round}/${turn.rounds}`;
  $("scores").replaceChildren(
    ...view.teams.map((t, i) => {
      if (t.size === 0 && t.score === 0) return document.createComment("empty team");
      const el = document.createElement("span");
      el.className = `score ${teamClass(i)}${turn.team === i ? " is-drawing" : ""}`;
      const counts = turn.counts?.[i];
      const drawing = turn.team === i;
      const extra = !drawing && counts && counts.eligible > 0 ? `${counts.guessed}/${counts.eligible}` : "";
      el.innerHTML = `<b>${TEAM_NAMES[i]}</b><span class="t-score">${t.score}</span>${extra ? `<small>${extra}</small>` : ""}${
        drawing ? `<span class="score__tag">DRAWING</span>` : ""
      }`;
      return el;
    })
  );
  $("guessed-count").textContent = `${turn.guessedTotal} / ${turn.eligibleTotal} GOT IT`;
  renderHint(turn);
  renderOverlay(turn);

  const phase = view.phase;
  $("tools").classList.toggle("is-off", !canDraw());
  $("skip-drawer").disabled = phase !== "pick" && phase !== "ready";
  $("skip-turn").disabled = phase !== "pick" && phase !== "ready" && phase !== "draw";
  $("next").disabled = phase !== "reveal";
  $("hold").setAttribute("aria-pressed", String(view.hold));
  $("hold").textContent = view.hold ? "HELD" : "HOLD";
}

function renderHint(turn) {
  const el = $("hint");
  const msg = $("hint-msg");
  if (!turn.pattern) {
    el.replaceChildren();
    el.dataset.empty = "true";
    $("hint-count").hidden = true;
    // While the drawer walks up: who's drawing, and that the clock waits for them.
    const text = view.phase === "ready" ? `${turn.drawer} · THE CLOCK STARTS WITH YOUR FIRST LINE` : "";
    msg.hidden = !text;
    if (msg.textContent !== text) {
      msg.textContent = text;
      if (text) fitText(msg, Math.min(vh(2.4), 26), 11, $("hint-row"));
    }
    return;
  }
  msg.hidden = true;
  el.dataset.empty = "false";
  const letters = [...(view.phase === "reveal" && turn.word ? turn.word.toUpperCase() : turn.pattern)];
  const words = [];
  let current = [];
  for (const ch of letters) {
    if (ch === " ") {
      words.push(current);
      current = [];
    } else current.push(ch);
  }
  words.push(current);
  el.replaceChildren(
    ...words.map((word) => {
      const w = document.createElement("span");
      w.className = "hint__word";
      for (const ch of word) {
        const c = document.createElement("span");
        c.className = `hint__char${ch === "_" ? "" : " is-shown"}`;
        c.textContent = ch === "_" ? "" : ch;
        w.append(c);
      }
      return w;
    })
  );
  const count = letters.filter((c) => /[A-Z0-9_]/i.test(c)).length;
  el.setAttribute("aria-label", `${count} letters`);
  const tag = $("hint-count");
  tag.hidden = view.phase !== "draw";
  tag.textContent = `${count} LETTERS${words.length > 1 ? ` · ${words.length} WORDS` : ""}`;
  // A long word or phrase shrinks to stay on one line over the canvas.
  fitText(el, Math.min(vh(5), 60), 16, $("hint-row"));
}

function renderOverlay(turn) {
  const el = $("overlay");
  const phase = view.phase;
  const team = `<span class="pill pill--lg ${teamClass(turn.team)}">${TEAM_NAMES[turn.team]} TEAM</span>`;
  el.className = phase === "reveal" ? "overlay overlay--reveal" : "overlay";
  if (phase === "pick") {
    el.hidden = false;
    const html = `${team}<p class="overlay__big"><span class="overlay__name">${escape(turn.drawer)},</span><br>COME UP AND DRAW!</p><p class="overlay__small">PICK YOUR WORD ON YOUR PHONE.</p>`;
    if (el.dataset.html !== html) {
      el.dataset.html = html;
      el.innerHTML = html;
      fitText(el.querySelector(".overlay__big"), Math.min(vh(8), 88), 18, el);
    }
  } else if (phase === "reveal") {
    el.hidden = false;
    const reason = { all: "EVERYONE GOT IT!", time: "TIME'S UP!", skipped: "SKIPPED", ended: "GAME ENDED", "no-drawer": "NOBODY LEFT TO DRAW" }[turn.reason] ?? "";
    // A turn skipped before anyone scored shows no row of +0s.
    const anyPoints = (turn.teamPoints ?? []).some((p) => p > 0);
    const rows = view.teams
      .map((t, i) => ({ t, i, pts: turn.teamPoints?.[i] ?? 0 }))
      .filter(() => anyPoints)
      .filter(({ t, pts }) => t.size > 0 || pts > 0)
      .map(({ i, pts }) => `<li class="${teamClass(i)}"><span>${TEAM_NAMES[i]}${i === turn.team ? " · DREW" : ""}</span><b class="t-score">+${pts}</b></li>`)
      .join("");
    const html = `<p class="overlay__small">${reason}</p>${
      turn.word ? `<p class="overlay__label">THE WORD WAS</p><p class="overlay__word">${escape(turn.word.toUpperCase())}</p>` : ""
    }${rows ? `<ul class="overlay__points">${rows}</ul>` : ""}`;
    if (el.dataset.html !== html) {
      el.dataset.html = html;
      el.innerHTML = html;
      // The word is the star: as big as fits, broken only between words, and the card never overflows.
      const word = el.querySelector(".overlay__word");
      if (word) fitText(word, Math.min(vh(11), 120), 20, [[word, "x"], el]);
    }
  } else {
    el.hidden = true;
    el.innerHTML = "";
    el.dataset.html = "";
  }
}

function escape(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}

function newTurn(key) {
  turnKey = key;
  feed = [];
  renderFeed();
  strokes = loadStrokes(key);
  current = null;
  rebuild();
}

// ---------- Guess feed ----------
// New lines are added at the bottom without rebuilding the rest, so clicking a name works
// even while a hundred people are guessing.
function addFeed(msg) {
  feed.push(msg);
  const list = $("feed");
  list.append(feedItem(msg));
  trimFeed();
}

function renderFeed() {
  const list = $("feed");
  list.replaceChildren(...feed.map(feedItem));
  trimFeed();
}

// The newest lines sit at the bottom; the oldest drop off the top whole, never half cut.
function trimFeed() {
  const list = $("feed");
  while (feed.length > FEED_MAX || (list.children.length > 1 && list.scrollHeight > list.clientHeight + 1)) {
    feed.shift();
    list.firstElementChild?.remove();
  }
}

function feedItem(f) {
  const li = document.createElement("li");
  const who = document.createElement("button");
  who.type = "button";
  who.className = "feed__name";
  const isArmed = armed?.id === f.id && armed.until > Date.now();
  who.textContent = isArmed ? "REMOVE?" : f.name;
  who.classList.toggle("is-armed", isArmed);
  who.addEventListener("click", () => armRemove(f.id, renderFeed));
  if (f.kind === "correct") {
    li.className = `feed__item feed__item--correct ${teamClass(f.team)}`;
    li.append(who, " GOT IT! ");
    li.insertAdjacentHTML("beforeend", `<span class="t-score">+${f.points}</span>`);
  } else {
    li.className = "feed__item";
    li.innerHTML = `<span class="feed__dot ${teamClass(f.team)}" aria-hidden="true"></span>`;
    li.append(who, ` ${f.text}`);
  }
  return li;
}

// ---------- Host ----------
// After a click the host buttons give up the keyboard focus, so a stray Enter or Space can't press them again.
for (const id of ["start", "balance", "skip-drawer", "skip-turn", "next", "hold", "again", "to-lobby"]) {
  $(id).addEventListener("click", (event) => event.currentTarget.blur());
}
$("skip-drawer").addEventListener("click", () => sendMsg({ t: "skipDrawer" }));
$("skip-turn").addEventListener("click", () => sendMsg({ t: "skipTurn" }));
$("next").addEventListener("click", () => sendMsg({ t: "next" }));
$("hold").addEventListener("click", () => sendMsg({ t: "hold", on: !view?.hold }));
$("end").addEventListener("click", async (event) => {
  event.currentTarget.blur();
  if (await ask("END THE GAME NOW?", "THE SCORES SO FAR GO STRAIGHT TO THE RESULTS.", "YES, END THE GAME")) sendMsg({ t: "end" });
});
$("again").addEventListener("click", () => sendMsg({ t: "start" }));
$("to-lobby").addEventListener("click", () => sendMsg({ t: "lobby" }));

// ---------- Timer ----------
function tickTimer() {
  requestAnimationFrame(tickTimer);
  const el = $("timer");
  if (!view?.turn || $("view-game").hidden) return;
  const { turn } = view;
  const ends = { pick: turn.pickEndsAt, ready: turn.readyEndsAt, draw: turn.drawEndsAt, reveal: view.hold ? null : turn.revealEndsAt }[view.phase];
  const left = ends ? Math.max(0, Math.ceil((ends - serverNow()) / 1000)) : null;
  const text = left === null ? "–" : String(left);
  if (el.textContent !== text) el.textContent = text;
  el.classList.toggle("is-low", view.phase === "draw" && left !== null && left <= 10);
  el.dataset.phase = view.phase;
}
requestAnimationFrame(tickTimer);

// ---------- Results ----------
function ordinal(n) {
  return n === 1 ? "1ST" : n === 2 ? "2ND" : n === 3 ? "3RD" : `${n}TH`;
}

function renderResults() {
  const { ranking, top } = view.results ?? { ranking: [], top: [] };
  const winners = ranking.filter((r) => r.rank === 1);
  const winner = $("winner");
  winner.className = `pill pill--xl results__winner${winners.length === 1 ? ` ${teamClass(winners[0].team)}` : ""}`;
  winner.textContent =
    winners.length === 1 ? `${TEAM_NAMES[winners[0].team]} TEAM WINS!` : `A TIE: ${winners.map((r) => TEAM_NAMES[r.team]).join(", ")}`;
  const podium = ranking.slice(0, 3);
  // 2nd, 1st, 3rd from left to right, like a real podium.
  const order = [podium[1], podium[0], podium[2]].filter(Boolean);
  $("podium").replaceChildren(
    ...order.map((r) => {
      const el = document.createElement("div");
      el.className = `podium__step podium__step--${r.rank} ${teamClass(r.team)}`;
      el.innerHTML = `<span class="podium__rank">${ordinal(r.rank)}</span><span class="podium__team">${TEAM_NAMES[r.team]}</span><span class="podium__score t-score">${r.score}</span>`;
      return el;
    })
  );
  // A long team name (YELLOW) shrinks to stay inside its step.
  for (const step of $("podium").children) {
    const name = step.querySelector(".podium__team");
    name.style.fontSize = "";
    fitText(name, parseFloat(getComputedStyle(name).fontSize), 16, [[step, "x"]]);
  }
  $("rest-card").hidden = ranking.length <= 3;
  $("ranking").replaceChildren(
    ...ranking.slice(3).map((r) => {
      const li = document.createElement("li");
      li.className = `ranking__row ${teamClass(r.team)}`;
      li.innerHTML = `<span>${ordinal(r.rank)}</span><b>${TEAM_NAMES[r.team]}</b><span class="t-score">${r.score}</span>`;
      return li;
    })
  );
  $("stars").replaceChildren(
    ...(top.length
      ? top.map((p, i) => {
          const li = document.createElement("li");
          li.innerHTML = `<span class="stars__rank">${i + 1}</span><span class="feed__dot ${teamClass(p.team)}" aria-hidden="true"></span><b>${escape(p.name)}</b><span class="t-score">${p.points}</span>`;
          return li;
        })
      : [Object.assign(document.createElement("li"), { textContent: "NO POINTS YET" })])
  );
}

// ---------- Drawing ----------
const canvas = $("canvas");
const ctx = canvas.getContext("2d");
let strokes = [];
let current = null;
// Finished strokes are painted once onto this buffer; each pointer move only draws the stroke in progress.
const buffer = document.createElement("canvas");
const bctx = buffer.getContext("2d");
let color = COLORS[0];
let size = SIZES[1];
let scale = 1;

function canDraw() {
  return view && (view.phase === "ready" || view.phase === "draw");
}

function storeKey(key) {
  return `gdg-pictionary-strokes-${key}`;
}

function loadStrokes(n) {
  try {
    return JSON.parse(sessionStorage.getItem(storeKey(n))) ?? [];
  } catch {
    return [];
  }
}

function saveStrokes() {
  try {
    sessionStorage.setItem(storeKey(turnKey), JSON.stringify(strokes));
    // Only this turn's drawing is worth keeping.
    const old = [];
    for (let i = 0; i < sessionStorage.length; i += 1) old.push(sessionStorage.key(i));
    for (const key of old) {
      if (key?.startsWith("gdg-pictionary-strokes-") && key !== storeKey(turnKey)) sessionStorage.removeItem(key);
    }
  } catch {
    // Storage full or blocked: a reload just loses the drawing.
  }
}

function fitCanvas() {
  const box = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(box.width * dpr));
  canvas.height = Math.max(1, Math.round(box.height * dpr));
  scale = canvas.width / W;
  rebuild();
}

function paintStroke(s, c = ctx) {
  c.strokeStyle = s.c;
  c.fillStyle = s.c;
  c.lineWidth = s.w * scale;
  c.lineCap = "round";
  c.lineJoin = "round";
  const pts = s.p;
  if (pts.length === 1) {
    c.beginPath();
    c.arc(pts[0][0] * scale, pts[0][1] * scale, (s.w * scale) / 2, 0, Math.PI * 2);
    c.fill();
    return;
  }
  c.beginPath();
  c.moveTo(pts[0][0] * scale, pts[0][1] * scale);
  for (let i = 1; i < pts.length - 1; i += 1) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2;
    const my = (pts[i][1] + pts[i + 1][1]) / 2;
    c.quadraticCurveTo(pts[i][0] * scale, pts[i][1] * scale, mx * scale, my * scale);
  }
  const last = pts[pts.length - 1];
  c.lineTo(last[0] * scale, last[1] * scale);
  c.stroke();
}

// Repaints the buffer from every finished stroke (after undo, clear, a resize or a new turn).
function rebuild() {
  buffer.width = canvas.width;
  buffer.height = canvas.height;
  bctx.fillStyle = "#ffffff";
  bctx.fillRect(0, 0, buffer.width, buffer.height);
  for (const s of strokes) paintStroke(s, bctx);
  redraw();
}

function redraw() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(buffer, 0, 0);
  if (current) paintStroke(current);
}

function toPoint(event) {
  const box = canvas.getBoundingClientRect();
  const x = ((event.clientX - box.left) / box.width) * W;
  const y = ((event.clientY - box.top) / box.height) * H;
  return [Math.round(Math.min(W, Math.max(0, x)) * 10) / 10, Math.round(Math.min(H, Math.max(0, y)) * 10) / 10];
}

canvas.addEventListener("pointerdown", (event) => {
  if (!canDraw() || current || event.button !== 0) return;
  event.preventDefault();
  canvas.setPointerCapture(event.pointerId);
  current = { c: color.value, w: color.key === "eraser" ? Math.max(size.value * 2, 24) : size.value, p: [toPoint(event)], id: event.pointerId };
  if (view.phase === "ready") sendMsg({ t: "drawing" });
  redraw();
});

// A right-click on the canvas mustn't open the browser's menu over the drawing.
canvas.addEventListener("contextmenu", (event) => event.preventDefault());

canvas.addEventListener("pointermove", (event) => {
  if (!current || event.pointerId !== current.id) return;
  const events = event.getCoalescedEvents?.() ?? [event];
  for (const e of events) {
    const pt = toPoint(e);
    const last = current.p[current.p.length - 1];
    if (Math.hypot(pt[0] - last[0], pt[1] - last[1]) >= 1.5) current.p.push(pt);
  }
  redraw();
});

function endStroke(event) {
  if (!current || event.pointerId !== current.id) return;
  const done = { c: current.c, w: current.w, p: current.p };
  strokes.push(done);
  current = null;
  paintStroke(done, bctx);
  saveStrokes();
  redraw();
}
canvas.addEventListener("pointerup", endStroke);
canvas.addEventListener("pointercancel", endStroke);

function undo() {
  if (!canDraw()) return;
  strokes.pop();
  saveStrokes();
  rebuild();
}
$("undo").addEventListener("click", undo);
let wipeArmed = 0;
$("wipe").addEventListener("click", () => {
  if (!canDraw()) return;
  if (Date.now() < wipeArmed) {
    strokes = [];
    saveStrokes();
    rebuild();
    wipeArmed = 0;
    $("wipe").textContent = "CLEAR";
    return;
  }
  wipeArmed = Date.now() + REMOVE_ARM_MS;
  $("wipe").textContent = "SURE?";
  setTimeout(() => {
    $("wipe").textContent = "CLEAR";
  }, REMOVE_ARM_MS);
});
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
    event.preventDefault();
    undo();
  }
});

function renderTools() {
  $("colors").replaceChildren(
    ...COLORS.map((c) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `swatch swatch--${c.key}`;
      b.style.setProperty("--swatch", c.value);
      b.setAttribute("aria-label", c.label);
      b.setAttribute("aria-pressed", String(c === color));
      if (c.key === "eraser") b.textContent = "ERASE";
      b.addEventListener("click", () => {
        color = c;
        renderTools();
      });
      return b;
    })
  );
  $("sizes").replaceChildren(
    ...SIZES.map((s) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "size";
      b.setAttribute("aria-label", s.label);
      b.setAttribute("aria-pressed", String(s === size));
      const dot = document.createElement("span");
      dot.style.width = { s: "18%", m: "36%", l: "62%" }[s.key];
      b.append(dot);
      b.addEventListener("click", () => {
        size = s;
        renderTools();
      });
      return b;
    })
  );
}

// The projector must never dim or sleep mid-game.
let wakeLock = null;
async function keepAwake() {
  if (!("wakeLock" in navigator) || document.hidden || wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => {
      wakeLock = null;
    });
  } catch {
    // Not allowed right now (low battery): the laptop's own settings decide.
  }
}
document.addEventListener("visibilitychange", keepAwake);
document.addEventListener("pointerdown", keepAwake);
keepAwake();

// Kiosk: the mouse pointer hides after a few still seconds so it never sits on the projector.
let idleTimer = 0;
function wake() {
  document.body.classList.remove("is-idle");
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => document.body.classList.add("is-idle"), 3000);
}
document.addEventListener("pointermove", wake);
document.addEventListener("pointerdown", wake);
wake();

addEventListener("resize", () => {
  fitJoin();
  fitChips();
  trimFeed();
});
// The canvas column is sized after a resize settles, so the text over it is refitted then.
new ResizeObserver(() => {
  if (!view?.turn || $("view-game").hidden) return;
  $("overlay").dataset.html = "";
  renderGame();
}).observe($("canvas-card"));

// F: full screen on the projector, and back.
document.addEventListener("keydown", (event) => {
  if (event.key.toLowerCase() !== "f" || event.metaKey || event.ctrlKey || event.altKey) return;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else document.documentElement.requestFullscreen().catch(() => {});
});

// The canvas column is exactly as wide as the biggest 16:10 canvas that fits between the hint and
// the tools, so the canvas, the tools and the guesses panel line up with no floating gaps.
function layoutStage() {
  const main = document.querySelector(".game__main");
  if (!main || $("view-game").hidden) return;
  if (matchMedia("(max-width: 960px), (max-height: 560px)").matches) {
    main.style.removeProperty("--canvas-w");
    return;
  }
  const cs = getComputedStyle(main);
  const rowGap = parseFloat(cs.rowGap) || 0;
  const colGap = parseFloat(cs.columnGap) || 0;
  const sideMin = Math.min(420, Math.max(240, innerWidth * 0.22));
  const availW = main.clientWidth - sideMin - colGap;
  const availH = main.clientHeight - $("hint-row").offsetHeight - $("tools").offsetHeight - 2 * rowGap;
  const w = Math.max(240, Math.floor(Math.min(availW, availH * 1.6)));
  main.style.setProperty("--canvas-w", `${w}px`);
}
new ResizeObserver(layoutStage).observe(document.querySelector(".game__main"));

new ResizeObserver(fitCanvas).observe(canvas);
renderTools();
renderJoin();
connect();
