// Fixed 60Hz simulation. Screens refresh at 60, 120 or 144Hz; without a fixed step
// every game would run faster on the MacBook's 120Hz display.
export const TICK_HZ = 60;
const STEP_MS = 1000 / TICK_HZ;
const MAX_FRAME_MS = 250;

export function createLoop({ update, render }) {
  let raf = 0;
  let last = 0;
  let acc = 0;
  let running = false;
  let ticks = 0;

  function frame(now) {
    if (!running) return;
    acc += Math.min(now - last, MAX_FRAME_MS);
    last = now;
    while (acc >= STEP_MS) {
      update();
      ticks += 1;
      acc -= STEP_MS;
      if (!running) return;
    }
    render();
    raf = requestAnimationFrame(frame);
  }

  function onVisibility() {
    if (!running) return;
    cancelAnimationFrame(raf);
    if (!document.hidden) {
      last = performance.now();
      raf = requestAnimationFrame(frame);
    }
  }

  document.addEventListener("visibilitychange", onVisibility);

  return {
    start() {
      if (running) return;
      running = true;
      last = performance.now();
      acc = 0;
      raf = requestAnimationFrame(frame);
    },
    stop() {
      running = false;
      cancelAnimationFrame(raf);
    },
    destroy() {
      this.stop();
      document.removeEventListener("visibilitychange", onVisibility);
    },
    get ticks() {
      return ticks;
    },
  };
}
