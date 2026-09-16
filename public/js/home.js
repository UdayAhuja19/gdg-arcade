import { api, ApiError, IS_STATIC } from "./api.js";
import { GAME_LIST } from "./shared/games.js";
import { getPlayer, setPlayer, clearPlayer, watchIdle, checkName } from "./session.js";
import { renderBoard } from "./ui/leaderboard.js";
import { shapeEl, BUTTON_CLASS } from "./ui/decor.js";

const gate = document.getElementById("gate");
const form = document.getElementById("gate-form");
const input = document.getElementById("name");
const error = document.getElementById("name-error");
const playerBar = document.getElementById("player-bar");
const playerPill = document.getElementById("player-pill");
const tilesEl = document.getElementById("tiles");
const banner = document.getElementById("db-banner");

const BOARD_REFRESH_MS = 10_000;
const PEEK_COLOR = { green: "green", yellow: "yellow", blue: "blue", red: "red", ink: "blue" };

const games = GAME_LIST;
const boardLists = new Map();

function showPlayer() {
  const player = getPlayer();
  gate.hidden = Boolean(player);
  playerBar.hidden = !player;
  tilesEl.classList.toggle("is-locked", !player);
  if (player) {
    playerPill.textContent = `PLAYING AS ${player.name}`;
  } else {
    input.value = "";
  }
  for (const tile of tilesEl.children) tile.classList.toggle("is-locked", !player);
  refreshBoards();
}

function setError(message) {
  error.textContent = message;
  input.setAttribute("aria-invalid", message ? "true" : "false");
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const check = checkName(input.value);
  if (check.error) {
    setError(check.error);
    input.focus();
    return;
  }
  setError("");
  const button = form.querySelector("button");
  button.disabled = true;
  try {
    const player = await api.createPlayer(input.value);
    setPlayer({ id: player.id, name: player.name });
    banner.hidden = true;
  } catch (err) {
    if (err instanceof ApiError && (err.status === 503 || err.status === 0)) {
      // Database down: let them play anyway, without saving.
      setPlayer({ id: null, name: check.name });
      banner.hidden = false;
    } else {
      setError(err.message);
      input.focus();
      return;
    }
  } finally {
    button.disabled = false;
  }
  showPlayer();
  document.getElementById("library").scrollIntoView({ behavior: "smooth", block: "start" });
});

input.addEventListener("input", () => {
  if (error.textContent) setError("");
});

document.getElementById("not-you").addEventListener("click", () => {
  clearPlayer();
  showPlayer();
  window.scrollTo({ top: 0, behavior: "smooth" });
  input.focus();
});

function buildTiles() {
  tilesEl.replaceChildren();
  for (const game of games) {
    const tile = document.createElement("article");
    tile.className = "card tile";
    tile.dataset.game = game.key;

    const peek = shapeEl(game.shape, PEEK_COLOR[game.color], "card__peek");
    const title = document.createElement("h3");
    title.className = "t-h2";
    title.textContent = game.title;

    const art = document.createElement("img");
    art.className = "tile__art";
    art.src = `assets/art/${game.key}.svg`;
    art.alt = "";
    art.width = 240;
    art.height = 150;

    const blurb = document.createElement("p");
    blurb.className = "tile__blurb";
    blurb.textContent = game.blurb;

    const board = document.createElement("ol");
    board.className = "board";
    board.setAttribute("aria-label", `${game.title} top 3`);
    renderBoard(board, []);
    boardLists.set(game.key, board);

    const play = document.createElement("a");
    play.className = `btn ${BUTTON_CLASS[game.color]}`;
    play.href = `play.html?game=${game.key}`;
    play.textContent = `<PLAY ${game.title}>`;
    play.addEventListener("click", (e) => {
      if (getPlayer()) return;
      e.preventDefault();
      window.scrollTo({ top: 0, behavior: "smooth" });
      setError("TYPE YOUR NAME FIRST.");
      input.focus({ preventScroll: true });
    });

    tile.append(peek, title, art, blurb, board, play);
    tilesEl.append(tile);
  }

  const marquee = document.getElementById("marquee");
  const titles = games.map((g) => g.title);
  marquee.replaceChildren(
    ...[...titles, ...titles].map((t) => {
      const pill = document.createElement("span");
      pill.className = "pill pill--thin";
      pill.textContent = t;
      return pill;
    })
  );
}

async function refreshBoards() {
  try {
    const boards = await api.boards();
    const me = getPlayer();
    for (const [key, list] of boardLists) renderBoard(list, boards[key], { meId: me?.id });
    banner.hidden = true;
  } catch (err) {
    if (err instanceof ApiError && (err.status === 503 || err.status === 0)) banner.hidden = false;
  }
}

function init() {
  document.getElementById("demo-note").hidden = !IS_STATIC;
  buildTiles();
  showPlayer();
  setInterval(refreshBoards, BOARD_REFRESH_MS);

  // Walk-away reset: the next student starts at the name box.
  watchIdle(() => {
    if (!getPlayer()) return;
    clearPlayer();
    showPlayer();
    window.scrollTo({ top: 0 });
  });

  if (!getPlayer()) input.focus();
}

init();
