import { api } from "./api.js";
import { GAME_LIST } from "./shared/games.js";
import { formatScore } from "./ui/format.js";

const PIN_KEY = "gdg-arcade-admin-pin";

const pinForm = document.getElementById("pin-form");
const pinInput = document.getElementById("pin");
const pinError = document.getElementById("pin-error");
const panel = document.getElementById("panel");
const statsEl = document.getElementById("stats");
const tabsEl = document.getElementById("tabs");
const runsEl = document.getElementById("runs");
const runsEmpty = document.getElementById("runs-empty");
const resetForm = document.getElementById("reset-form");
const resetMsg = document.getElementById("reset-msg");

let admin = null;
const games = GAME_LIST;
let current = null;

function storedPin() {
  try {
    return sessionStorage.getItem(PIN_KEY);
  } catch {
    return null;
  }
}

function storePin(pin) {
  try {
    sessionStorage.setItem(PIN_KEY, pin);
  } catch {
    // Not stored; the PIN is asked again next visit.
  }
}

async function unlock(pin) {
  const client = api.admin(pin);
  await client.overview();
  admin = client;
  storePin(pin);
  pinForm.hidden = true;
  panel.hidden = false;
  current = games[0].key;
  renderTabs();
  await refresh();
}

pinForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  pinError.textContent = "";
  try {
    await unlock(pinInput.value.trim());
  } catch (err) {
    pinError.textContent = err.message;
    pinInput.select();
  }
});

function renderTabs() {
  tabsEl.replaceChildren(
    ...games.map((g) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn btn--sm";
      b.textContent = g.title;
      b.setAttribute("aria-pressed", String(g.key === current));
      b.addEventListener("click", () => {
        current = g.key;
        renderTabs();
        refresh();
      });
      return b;
    })
  );
}

async function refresh() {
  const [overview, runs] = await Promise.all([admin.overview(), admin.runs(current)]);

  const titles = Object.fromEntries(games.map((g) => [g.key, g.title]));
  const cards = [
    stat("PLAYERS", overview.players),
    ...overview.games.map((g) => stat(titles[g.game], g.plays, `${g.players} PLAYERS`)),
  ];
  statsEl.replaceChildren(...cards);

  runsEl.replaceChildren(
    ...runs.map((run) => {
      const tr = document.createElement("tr");
      tr.classList.toggle("is-hidden", run.hidden);
      const finished = new Date(run.finishedAt);
      tr.innerHTML = `
        <td></td>
        <td>${formatScore(run.score)}</td>
        <td>${finished.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</td>
        <td>${run.hidden ? "HIDDEN" : "ON BOARD"}</td>
        <td><div class="actions"></div></td>`;
      tr.cells[0].textContent = run.name;
      const actions = tr.querySelector(".actions");
      actions.append(
        action(run.hidden ? "SHOW" : "HIDE", () => admin.setRunHidden(run.id, !run.hidden)),
        action("HIDE PLAYER", () => admin.hidePlayer(run.playerId))
      );
      return tr;
    })
  );
  runsEmpty.hidden = runs.length > 0;
}

function stat(label, value, sub = "") {
  const card = document.createElement("div");
  card.className = "card card--flat stat";
  card.innerHTML = `<span class="caption"></span><span class="t-score">${formatScore(value)}</span><span class="t-small">${sub}</span>`;
  card.querySelector(".caption").textContent = label;
  return card;
}

function action(text, fn) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "btn btn--sm";
  b.textContent = text;
  b.addEventListener("click", async () => {
    b.disabled = true;
    try {
      await fn();
      await refresh();
    } catch (err) {
      alert(err.message);
      b.disabled = false;
    }
  });
  return b;
}

resetForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = document.getElementById("reset-confirm");
  resetMsg.textContent = "";
  try {
    await admin.reset(input.value.trim().toUpperCase());
    input.value = "";
    resetMsg.textContent = "ALL SCORES DELETED.";
    await refresh();
  } catch (err) {
    resetMsg.textContent = err.message;
  }
});

const saved = storedPin();
if (saved) {
  unlock(saved).catch(() => {
    pinForm.hidden = false;
  });
}
