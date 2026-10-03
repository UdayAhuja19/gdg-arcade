// The scores page: the host's tally of every game on the day, the teams, and the PICTIONARY games
// the server saved by itself. Everything lives in data/hello-world.db on this laptop.

const $ = (id) => document.getElementById(id);
const TEAM_KEYS = ["red", "blue", "yellow", "green", "black", "white"];
const TEAM_NAMES = ["RED", "BLUE", "YELLOW", "GREEN", "BLACK", "WHITE"];
const REFRESH_MS = 5000;

let data = null;
let editing = null; // the tally row id being edited, or null when adding
let toastTimer = 0;

const teamClass = (i) => `team team--${TEAM_KEYS[i]}`;
const ordinal = (n) => (n === 1 ? "1ST" : n === 2 ? "2ND" : n === 3 ? "3RD" : `${n}TH`);
const escape = (text) => String(text).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
const when = (ms) =>
  new Date(ms).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true }).toUpperCase();

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 3000);
}

// ---------- Talking to the server ----------
async function call(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({ error: "SOMETHING WENT WRONG." }));
  if (!res.ok) throw new Error(json.error ?? "SOMETHING WENT WRONG.");
  return json;
}

async function load() {
  try {
    data = await call("GET", "/api/scores");
    $("load-error").hidden = true;
    render();
  } catch (err) {
    $("load-error").textContent = `${err.message} IS THE GAME RUNNING? (NPM RUN PICTIONARY)`;
    $("load-error").hidden = false;
  }
}

// ---------- The tally ----------
// Ranks by total: equal totals share a place.
function ranks(totals) {
  return totals.map((t) => 1 + totals.filter((u) => u > t).length);
}

function render() {
  const { tally, totals } = data;
  const anyTally = tally.length > 0;

  $("tally-body").replaceChildren(
    ...(anyTally
      ? tally.map((row) => {
          const tr = document.createElement("tr");
          tr.classList.toggle("is-editing", row.id === editing);
          tr.innerHTML = `<th scope="row" class="tally__game">${escape(row.label)}</th>${row.points
            .map((p) => `<td class="tally__num t-score">${p}</td>`)
            .join("")}<td class="tally__actions"><button class="btn btn--sm" type="button" data-edit="${row.id}">EDIT</button><button class="btn btn--sm" type="button" data-delete="${row.id}">DELETE</button></td>`;
          return tr;
        })
      : [Object.assign(document.createElement("tr"), { innerHTML: `<td class="tally__empty" colspan="8">NOTHING IN THE TALLY YET. ADD THE FIRST GAME BELOW.</td>` })])
  );

  const r = ranks(totals);
  $("tally-total").innerHTML = `<th scope="row" class="tally__game">TOTAL</th>${totals.map((t) => `<td class="tally__num tally__num--total t-score">${t}</td>`).join("")}<td></td>`;
  $("tally-rank").innerHTML = `<th scope="row" class="tally__game"></th>${
    anyTally ? r.map((n) => `<td class="tally__rank"><span class="rank rank--${Math.min(n, 4)}">${ordinal(n)}</span></td>`).join("") : TEAM_NAMES.map(() => "<td></td>").join("")
  }<td></td>`;

  // The teams.
  const players = data.teams.reduce((s, t) => s + t.members.length, 0);
  $("teams-count").textContent = `${players} ${players === 1 ? "PLAYER" : "PLAYERS"}`;
  $("sp-teams").replaceChildren(
    ...data.teams.map((t, i) => {
      const card = document.createElement("article");
      card.className = `team-card ${teamClass(i)}`;
      card.innerHTML = `<header class="team-card__head"><span class="team-card__name">${TEAM_NAMES[i]}</span><span class="team-card__count t-score">${t.members.length}</span></header>`;
      const list = document.createElement("ul");
      list.className = "team-card__names sp-names";
      if (t.members.length === 0) list.innerHTML = `<li class="team-card__empty">NOBODY YET</li>`;
      for (const name of t.members) {
        const li = document.createElement("li");
        li.className = "chip sp-chip";
        li.textContent = name;
        list.append(li);
      }
      card.append(list);
      return card;
    })
  );

  // The saved PICTIONARY games.
  $("sp-games").replaceChildren(
    ...(data.games.length
      ? data.games.map((g) => {
          const li = document.createElement("li");
          li.className = "sp-game";
          const scores = g.ranking
            .map((s) => `<span class="sp-score ${teamClass(s.team)}"><small>${ordinal(s.rank)}</small> ${TEAM_NAMES[s.team]} <b class="t-score">${s.score}</b></span>`)
            .join("");
          const top = g.top.length ? `TOP GUESSERS: ${g.top.map((p) => `${escape(p.name)} (${p.points})`).join(", ")}` : "";
          li.innerHTML = `<p class="sp-game__when">${when(g.endedAt)} · ${g.turns} ${g.turns === 1 ? "TURN" : "TURNS"}</p><div class="sp-game__scores">${scores}</div>${
            top ? `<p class="sp-game__top">${top}</p>` : ""
          }`;
          return li;
        })
      : [Object.assign(document.createElement("li"), { className: "sp-game sp-game--empty", textContent: "NO PICTIONARY GAME HAS FINISHED YET." })])
  );
  $("entry-fill").hidden = data.games.length === 0;
}

// ---------- Adding and editing a row ----------
const inputs = TEAM_NAMES.map((name, i) => {
  const label = document.createElement("label");
  label.className = `entry__field entry__team ${teamClass(i)}`;
  label.innerHTML = `<span class="entry__label">${name}</span>`;
  const input = document.createElement("input");
  input.className = "field entry__input entry__num";
  input.type = "text";
  input.inputMode = "numeric";
  input.placeholder = "0";
  input.autocomplete = "off";
  input.setAttribute("aria-label", `${name} points`);
  label.append(input);
  $("entry-points").append(label);
  return input;
});

function resetForm() {
  editing = null;
  $("entry").reset();
  $("entry-title").textContent = "ADD A GAME'S POINTS";
  $("entry-save").textContent = "<ADD TO THE TALLY>";
  $("entry-cancel").hidden = true;
  $("entry-error").textContent = "";
  if (data) render();
}

function readForm() {
  const points = [];
  for (const [i, input] of inputs.entries()) {
    const raw = input.value.trim().replace(/,/g, "");
    if (raw === "") {
      points.push(0);
      continue;
    }
    if (!/^-?\d+$/.test(raw)) return { error: `${TEAM_NAMES[i]}: USE A WHOLE NUMBER.`, input };
    points.push(Number(raw));
  }
  return { label: $("entry-label").value, points };
}

$("entry").addEventListener("submit", async (event) => {
  event.preventDefault();
  const entry = readForm();
  if (entry.error) {
    $("entry-error").textContent = entry.error;
    entry.input.focus();
    return;
  }
  const btn = $("entry-save");
  btn.disabled = true;
  try {
    data = editing === null ? await call("POST", "/api/tally", entry) : await call("PUT", `/api/tally/${editing}`, entry);
    toast(editing === null ? "ADDED TO THE TALLY." : "SAVED.");
    resetForm();
  } catch (err) {
    $("entry-error").textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

$("entry-cancel").addEventListener("click", resetForm);

// The last PICTIONARY game's scores, ready to check and add.
$("entry-fill").addEventListener("click", () => {
  const game = data?.games[0];
  if (!game) return;
  $("entry-label").value = "PICTIONARY";
  inputs.forEach((input, i) => {
    input.value = String(game.ranking.find((r) => r.team === i)?.score ?? 0);
  });
  $("entry-error").textContent = "";
  toast("FILLED IN. CHECK THE NUMBERS, THEN ADD.");
});

$("tally-body").addEventListener("click", async (event) => {
  const edit = event.target.closest("[data-edit]");
  const del = event.target.closest("[data-delete]");
  if (edit) {
    const row = data.tally.find((r) => r.id === Number(edit.dataset.edit));
    if (!row) return;
    editing = row.id;
    $("entry-label").value = row.label;
    inputs.forEach((input, i) => {
      input.value = String(row.points[i]);
    });
    $("entry-title").textContent = `EDIT ${row.label}`;
    $("entry-save").textContent = "<SAVE CHANGES>";
    $("entry-cancel").hidden = false;
    $("entry-error").textContent = "";
    render();
    $("entry").scrollIntoView({ behavior: "smooth", block: "center" });
    $("entry-label").focus({ preventScroll: true });
  } else if (del) {
    const row = data.tally.find((r) => r.id === Number(del.dataset.delete));
    if (!row) return;
    if (!(await ask(`DELETE ${row.label}?`, "ITS POINTS COME OFF EVERY TEAM'S TOTAL.", "YES, DELETE IT"))) return;
    try {
      data = await call("DELETE", `/api/tally/${row.id}`);
      if (editing === row.id) resetForm();
      else render();
      toast("DELETED.");
    } catch (err) {
      toast(err.message);
    }
  }
});

// ---------- Asking first ----------
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
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("modal").hidden) answer(false);
});

// ---------- Start ----------
const head = $("tally-head");
TEAM_NAMES.forEach((name, i) => {
  const th = document.createElement("th");
  th.scope = "col";
  th.innerHTML = `<span class="pill pill--sm ${teamClass(i)}">${name}</span>`;
  head.append(th);
});
head.append(Object.assign(document.createElement("th"), { className: "tally__actions" }));

load();
// New players keep joining during the event: the teams refresh by themselves.
setInterval(() => {
  if (document.visibilityState === "visible" && $("modal").hidden) load();
}, REFRESH_MS);
