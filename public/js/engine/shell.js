// Runs every game the same way:
// ready -> 3-2-1 countdown -> playing -> saving -> game over.
import { api } from "../api.js";
import { clearPlayer, watchIdle } from "../session.js";
import { bindInput } from "./input.js";
import { formatScore } from "../ui/format.js";

const COUNTDOWN = ["3", "2", "1", "GO!"];
const COUNTDOWN_STEP_MS = 550;
// Stops a player mashing SPACE through the game-over screen by accident.
const GAME_OVER_LOCK_MS = 900;

export function createShell({ meta, player, stage, gameRoot, overlay, loadGame, onResult, onScore }) {
  let state = "ready";
  let game = null;
  let run = null;
  let runPromise = null;
  let lockedUntil = 0;
  let countdownTimer = 0;
  let destroyed = false;

  const idle = watchIdle(() => {
    if (state === "ready" || state === "over") {
      clearPlayer();
      location.href = "./";
    }
  });

  const unbind = bindInput(stage, (action, pressed, repeat, event) => {
    if (state === "playing") {
      game?.input?.(action, pressed, repeat, event);
      return;
    }
    if (!pressed || repeat || action !== "primary") return;
    if (state === "ready") begin();
    // On the game-over card, clicks only count on its buttons; SPACE still restarts.
    else if (state === "over" && event) return;
    else if (state === "over" && performance.now() > lockedUntil) begin();
  });

  function show(html) {
    overlay.innerHTML = html;
    overlay.hidden = false;
  }

  function hideOverlay() {
    overlay.hidden = true;
    overlay.innerHTML = "";
  }

  function readyScreen() {
    const keys = meta.controls
      .map(([key, what]) => `<span class="t-small"><span class="key">${key}</span> = ${what}</span>`)
      .join("");
    show(`
      <div class="overlay__card pop-in">
        <p class="t-h2">READY, ${escapeHtml(player.name)}?</p>
        <div class="overlay__keys">${keys}</div>
        <button class="btn btn--primary btn--lg" type="button" data-action="start">&lt;START&gt;</button>
        <p class="t-small">OR PRESS <span class="key">SPACE</span></p>
      </div>`);
    overlay.querySelector("[data-action=start]").addEventListener("click", begin);
  }

  async function mountGame() {
    game?.destroy();
    gameRoot.replaceChildren();
    const mod = await loadGame();
    if (destroyed) return;
    game = mod.mount(gameRoot, {
      onScore: (score) => onScore?.(score),
      onGameOver: (score) => finish(score),
    });
  }

  async function begin() {
    if (state !== "ready" && state !== "over") return;
    state = "countdown";
    idle.pause();
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();

    // A fresh game every round, so nothing carries over from the last one.
    await mountGame();
    onScore?.(0);

    // Start the run on the server during the countdown. If the database is down
    // the game is still playable; the score just won't be saved.
    run = null;
    runPromise = player.id
      ? api
          .startRun(meta.key, player.id)
          .then((r) => (run = r))
          .catch((err) => (run = { error: err.message }))
      : Promise.resolve((run = { error: "THE DATABASE IS OFFLINE." }));

    let step = 0;
    const tick = () => {
      if (destroyed) return;
      if (step < COUNTDOWN.length) {
        show(`<div class="overlay__count pop-in" aria-live="assertive">${COUNTDOWN[step]}</div>`);
        step += 1;
        countdownTimer = setTimeout(tick, step === COUNTDOWN.length ? COUNTDOWN_STEP_MS * 0.6 : COUNTDOWN_STEP_MS);
      } else {
        hideOverlay();
        state = "playing";
        game.start();
      }
    };
    tick();
  }

  async function finish(score) {
    if (state !== "playing") return;
    state = "saving";
    onScore?.(score);
    lockedUntil = performance.now() + GAME_OVER_LOCK_MS;

    show(`
      <div class="overlay__card pop-in">
        <h2 class="t-h1 bracketed overlay__title">GAME OVER</h2>
        <p class="overlay__score t-score">${formatScore(score)}</p>
        <p class="t-small overlay__status">SAVING SCORE…</p>
      </div>`);

    await runPromise;
    let result = null;
    let error = null;
    if (run?.runId) {
      try {
        result = await api.finishRun(run.runId, run.token, score);
      } catch (err) {
        error = err.message;
      }
    } else {
      error = run?.error ?? "SCORE NOT SAVED.";
    }
    if (destroyed) return;

    state = "over";
    idle.resume();
    onResult?.(result);
    gameOverScreen(score, result, error);
  }

  function gameOverScreen(score, result, error) {
    let message = "";
    if (error) {
      message = `<p class="overlay__error">SCORE NOT SAVED. ${escapeHtml(error)}</p>`;
    } else if (result.rank === 1) {
      message = `<p class="t-h2">YOU'RE #1!</p>`;
    } else if (result.rank <= 3) {
      message = `<p class="t-h2">YOU'RE #${result.rank}!</p>`;
    } else if (result.pointsToTop3 > 0) {
      message = `<p class="t-h2">${formatScore(result.pointsToTop3)} POINTS TO REACH THE TOP 3</p>`;
    }

    const best =
      result && !result.isNewBest && result.best != null
        ? `<p class="t-small">YOUR BEST: ${formatScore(result.best)}</p>`
        : "";

    show(`
      <div class="overlay__card pop-in">
        <h2 class="t-h1 bracketed overlay__title">GAME OVER</h2>
        <div class="overlay__scoreline">
          <p class="overlay__score t-score">${formatScore(score)}</p>
          ${result?.isNewBest ? `<span class="badge pop-in">NEW BEST!</span>` : ""}
        </div>
        ${message}
        ${best}
        <div class="overlay__actions">
          <button class="btn btn--primary btn--lg" type="button" data-action="again">&lt;PLAY AGAIN&gt;</button>
          <a class="btn" href="./">&lt;LIBRARY&gt;</a>
          <button class="btn btn--ink" type="button" data-action="next">NEXT PLAYER</button>
        </div>
        <p class="t-small">PRESS <span class="key">SPACE</span> TO PLAY AGAIN</p>
      </div>`);

    overlay.querySelector("[data-action=again]").addEventListener("click", () => {
      if (performance.now() > lockedUntil) begin();
    });
    overlay.querySelector("[data-action=next]").addEventListener("click", () => {
      clearPlayer();
      location.href = "./";
    });
  }

  // Draw the first frame behind the ready card so players can see what's coming.
  mountGame().then(readyScreen);

  return {
    get state() {
      return state;
    },
    get game() {
      return game;
    },
    destroy() {
      destroyed = true;
      clearTimeout(countdownTimer);
      unbind();
      idle.stop();
      game?.destroy();
    },
  };
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}
