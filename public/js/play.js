import { api, ApiError, IS_STATIC } from "./api.js";
import { GAME_LIST } from "./shared/games.js";
import { getPlayer } from "./session.js";
import { createShell } from "./engine/shell.js";
import { renderBoard } from "./ui/leaderboard.js";
import { formatScore } from "./ui/format.js";

const params = new URLSearchParams(location.search);
const key = params.get("game");
const player = getPlayer();

const banner = document.getElementById("db-banner");
const liveScore = document.getElementById("live-score");
const myBest = document.getElementById("my-best");
const myRank = document.getElementById("my-rank");
const board = document.getElementById("board");

const GAME_MODULES = {
  dino: () => import("./games/dino.js"),
  flappy: () => import("./games/flappy.js"),
  snake: () => import("./games/snake.js"),
  memory: () => import("./games/memory.js"),
  stack: () => import("./games/stack.js"),
};

function showBanner(message) {
  banner.textContent = message;
  banner.hidden = false;
}

function renderStanding(top3, me) {
  renderBoard(board, top3, { meId: player.id });
  myBest.textContent = me?.best != null ? formatScore(me.best) : "—";
  myRank.textContent = me?.rank != null ? `#${me.rank}` : "—";
}

async function refreshBoard() {
  if (!player.id) return;
  try {
    const data = await api.board(key, player.id);
    renderStanding(data.top3, data.me);
  } catch (err) {
    if (err instanceof ApiError && (err.status === 503 || err.status === 0)) showBanner(err.message);
  }
}

async function init() {
  // No name yet, or a made-up game link: back to the library.
  if (!player || !GAME_MODULES[key]) {
    location.replace("./");
    return;
  }

  const meta = GAME_LIST.find((g) => g.key === key);
  document.getElementById("board-note").hidden = !IS_STATIC;

  document.title = `${meta.title} · GDG Arcade`;
  document.getElementById("game-title").textContent = meta.title;
  document.getElementById("player-pill").textContent = `PLAYING AS ${player.name}`;
  document.getElementById("hints").innerHTML = meta.controls
    .map(([k, what]) => `<span class="t-small"><span class="key">${k}</span> = ${what}</span>`)
    .join("");
  document.getElementById("rules").replaceChildren(
    ...meta.scoring.map((rule) => {
      const pill = document.createElement("span");
      pill.className = "pill pill--thin pill--sm";
      pill.textContent = rule;
      return pill;
    })
  );

  renderBoard(board, []);
  if (!player.id) showBanner("SCORES AREN'T SAVING RIGHT NOW: THE DATABASE IS OFFLINE. YOU CAN STILL PLAY.");
  refreshBoard();

  // Canvas text needs the brand font loaded before the first frame.
  await document.fonts.ready;
  // Exposed for debugging from the browser console.
  window.arcade = createShell({
    meta,
    player,
    stage: document.getElementById("stage"),
    gameRoot: document.getElementById("game-root"),
    overlay: document.getElementById("overlay"),
    loadGame: GAME_MODULES[key],
    onScore: (score) => {
      liveScore.textContent = formatScore(score);
    },
    onResult: (result) => {
      if (result) renderStanding(result.top3, { best: result.best, rank: result.rank });
    },
  });
}

init();
