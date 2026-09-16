// The data layer the pages talk to. On the fair laptop it calls the Node server (MySQL);
// in the GitHub Pages demo it uses localApi, which keeps scores in the browser.
import { ApiError } from "./api-error.js";
import { MODE } from "./config.js";
import { localApi } from "./local-api.js";

export { ApiError };

async function request(method, url, { body, headers } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, "CAN'T REACH THE ARCADE SERVER. CHECK IT'S STILL RUNNING.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || "THE SERVER DIDN'T ANSWER PROPERLY. TRY AGAIN.");
  return data;
}

const serverApi = {
  createPlayer: (name) => request("POST", "api/players", { body: { name } }).then((d) => d.player),
  boards: () => request("GET", "api/leaderboard").then((d) => d.boards),
  board: (game, playerId) =>
    request("GET", `api/leaderboard?game=${encodeURIComponent(game)}${playerId ? `&playerId=${playerId}` : ""}`),
  startRun: (game, playerId) => request("POST", "api/runs", { body: { game, playerId } }),
  finishRun: (runId, token, score) => request("POST", `api/runs/${runId}/finish`, { body: { token, score } }),

  admin(pin) {
    const headers = { "x-admin-pin": pin };
    return {
      overview: () => request("GET", "api/admin/overview", { headers }),
      runs: (game) => request("GET", `api/admin/runs?game=${encodeURIComponent(game)}`, { headers }).then((d) => d.runs),
      setRunHidden: (id, hidden) => request("POST", `api/admin/runs/${id}/hide`, { headers, body: { hidden } }),
      hidePlayer: (id) => request("POST", `api/admin/players/${id}/hide`, { headers, body: {} }),
      reset: (confirm) => request("POST", "api/admin/reset", { headers, body: { confirm } }),
    };
  },
};

export const IS_STATIC = MODE === "static";
export const api = IS_STATIC ? localApi : serverApi;
