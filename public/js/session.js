// The current player lives in sessionStorage so it follows the student from the
// home page into a game, and is cleared when they walk away.
const KEY = "gdg-arcade-player";
export const IDLE_MS = 45_000;

export function getPlayer() {
  try {
    const player = JSON.parse(sessionStorage.getItem(KEY));
    return player && typeof player.name === "string" ? player : null;
  } catch {
    return null;
  }
}

export function setPlayer(player) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(player));
  } catch {
    // Private mode or storage blocked: the page still works for this visit.
  }
}

export function clearPlayer() {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // Nothing stored.
  }
}

// Calls onIdle after `ms` with no keyboard, mouse or touch input.
// pause()/resume() let a game switch it off while someone is actually playing.
export function watchIdle(onIdle, ms = IDLE_MS) {
  let timer = 0;
  let active = true;
  const events = ["keydown", "pointerdown", "pointermove", "wheel", "touchstart"];

  const reset = () => {
    clearTimeout(timer);
    if (active) timer = setTimeout(onIdle, ms);
  };

  events.forEach((type) => window.addEventListener(type, reset, { passive: true }));
  reset();

  return {
    pause() {
      active = false;
      clearTimeout(timer);
    },
    resume() {
      active = true;
      reset();
    },
    stop() {
      active = false;
      clearTimeout(timer);
      events.forEach((type) => window.removeEventListener(type, reset));
    },
  };
}

// Same rules as the server, so players get instant feedback.
export { normalizeName as checkName } from "./shared/names.js";
