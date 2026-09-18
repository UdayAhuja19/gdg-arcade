// Scores for the GitHub Pages demo. There's no server or database: each browser keeps
// its own best score per player per game in localStorage, with the same top-3 rules
// as the fair laptop (best score per name, earliest wins ties).
import { ApiError } from "./api-error.js";
import { GAME_LIST } from "./shared/games.js";
import { normalizeName } from "./shared/names.js";

// Bump SCORES_VERSION to clear every device's demo leaderboard: on their next visit
// the old saved scores are deleted and the boards start empty.
const SCORES_VERSION = 2;
const KEY_PREFIX = "gdg-arcade-demo-scores";
export const STORAGE_KEY = `${KEY_PREFIX}-v${SCORES_VERSION}`;

let oldSavesCleared = false;

function clearOldSaves() {
  oldSavesCleared = true;
  try {
    for (let i = localStorage.length - 1; i >= 0; i -= 1) {
      const key = localStorage.key(i);
      if (key?.startsWith(KEY_PREFIX) && key !== STORAGE_KEY) localStorage.removeItem(key);
    }
  } catch {
    // Storage blocked: nothing to clear.
  }
}

function load() {
  if (!oldSavesCleared) clearOldSaves();
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (data && typeof data.best === "object" && data.best !== null) {
      data.players ??= {};
      return data;
    }
  } catch {
    // Unreadable or blocked storage: start fresh.
  }
  return { best: {}, players: {} };
}

function save(data) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    // Storage blocked (private mode): scores last until the page closes.
  }
}

// data.best[game][playerId] = { name, score, at }
function ranked(data, game) {
  return Object.entries(data.best[game] ?? {})
    .map(([playerId, entry]) => ({ playerId, ...entry }))
    .sort((a, b) => b.score - a.score || a.at - b.at);
}

function top3(rows) {
  return rows.slice(0, 3).map(({ playerId, name, score }, i) => ({ rank: i + 1, playerId, name, score }));
}

function standing(rows, playerId) {
  const i = rows.findIndex((r) => r.playerId === playerId);
  return i === -1 ? { best: null, rank: null } : { best: rows[i].score, rank: i + 1 };
}

const runs = new Map();
let nextRunId = 1;

export const localApi = {
  async createPlayer(rawName) {
    const result = normalizeName(rawName);
    if (result.error) throw new ApiError(422, result.error);
    // Remember the name, like the server's players table, so a second person typing it gets asked.
    const data = load();
    if (!data.players[result.key]) {
      data.players[result.key] = { name: result.name, at: Date.now() };
      save(data);
    }
    return { id: result.key, name: result.name };
  },

  // Has anyone on this device already used this name?
  async playerExists(rawName) {
    const result = normalizeName(rawName);
    if (result.error) throw new ApiError(422, result.error);
    const data = load();
    return Boolean(data.players[result.key]) || Object.values(data.best).some((board) => result.key in board);
  },

  async boards() {
    const data = load();
    return Object.fromEntries(GAME_LIST.map((g) => [g.key, top3(ranked(data, g.key))]));
  },

  async board(game, playerId) {
    const rows = ranked(load(), game);
    const body = { game, top3: top3(rows) };
    if (playerId) body.me = standing(rows, playerId);
    return body;
  },

  async startRun(game, playerId) {
    const runId = nextRunId++;
    runs.set(runId, { game, playerId });
    return { runId, token: "local" };
  },

  async finishRun(runId, token, score) {
    const run = runs.get(runId);
    if (!run) throw new ApiError(409, "THIS SCORE IS ALREADY SAVED.");
    runs.delete(runId);
    if (!Number.isSafeInteger(score) || score < 0) throw new ApiError(422, "SCORE MUST BE A WHOLE NUMBER.");

    const data = load();
    const board = (data.best[run.game] ??= {});
    const previous = board[run.playerId];
    const isNewBest = score > 0 && (!previous || score > previous.score);
    if (!previous || score > previous.score) {
      // Player ids are the lowercased name, so the display name is its uppercase form.
      board[run.playerId] = { name: run.playerId.toUpperCase(), score, at: Date.now() };
      save(data);
    }

    const rows = ranked(data, run.game);
    const me = standing(rows, run.playerId);
    const third = rows[2];
    return {
      score,
      best: me.best,
      isNewBest,
      rank: me.rank,
      pointsToTop3: me.rank > 3 && third ? third.score - me.best + 1 : 0,
      top3: top3(rows),
    };
  },
};
