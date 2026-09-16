// Maps keyboard and pointer input to game actions:
// primary (jump / flap / drop), up, down, left, right.
const KEY_ACTIONS = {
  Space: "primary",
  Enter: "primary",
  ArrowUp: "up",
  KeyW: "up",
  ArrowDown: "down",
  KeyS: "down",
  ArrowLeft: "left",
  KeyA: "left",
  ArrowRight: "right",
  KeyD: "right",
};

// Fallback by key name for keyboards and layouts that report an unusual e.code.
const KEY_NAME_ACTIONS = {
  " ": "primary",
  Spacebar: "primary",
  Enter: "primary",
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  w: "up",
  s: "down",
  a: "left",
  d: "right",
};

function actionFor(e) {
  return KEY_ACTIONS[e.code] ?? KEY_NAME_ACTIONS[e.key] ?? KEY_NAME_ACTIONS[e.key?.toLowerCase()];
}

export function bindInput(stage, handler) {
  function onKeyDown(e) {
    const action = actionFor(e);
    if (!action) return;
    if (e.target instanceof HTMLInputElement) return;
    // Buttons handle Enter/Space themselves.
    if (e.target instanceof HTMLButtonElement || e.target instanceof HTMLAnchorElement) return;
    e.preventDefault();
    handler(action, true, e.repeat);
  }

  function onKeyUp(e) {
    const action = actionFor(e);
    if (!action) return;
    handler(action, false, false);
  }

  function onPointerDown(e) {
    if (e.button !== 0) return;
    if (e.target.closest("button, a, [data-no-primary]")) return;
    handler("primary", true, false, e);
  }

  function onPointerUp(e) {
    if (e.button !== 0) return;
    handler("primary", false, false, e);
  }

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  stage.addEventListener("pointerdown", onPointerDown);
  stage.addEventListener("pointerup", onPointerUp);

  return () => {
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    stage.removeEventListener("pointerdown", onPointerDown);
    stage.removeEventListener("pointerup", onPointerUp);
  };
}
