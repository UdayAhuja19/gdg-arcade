// MASH BATTLE: every tap fills your bar a little, and the bar leaks. The fuller it is, the
// faster it leaks, so each tapping speed has a level the bar can't climb past. One finger
// (about 8 taps a second) tops out around 40%, two thumbs (about 14) around 80%, and filling
// it takes all-out drumming with several fingers (18+ taps a second) held for 8 to 18 seconds,
// which tires fingers out inside the 30 seconds. Stop and it drains fast. First to fill it
// wins; if nobody does before time's up, the fullest bar wins.
// Phones run the bar (so a tap counts the moment it happens); the server uses the same
// numbers to check what phones report.

export const BAR_FULL = 100;
export const TAP_FILL = 1; // each tap
export const DRAIN_PER_SEC = 2; // always
export const LEAK_PER_SEC = 0.15; // plus this share of the current level, every second
export const IDLE_AFTER_MS = 350; // no tap for this long...
export const IDLE_DRAIN_PER_SEC = 24; // ...and it drains this much faster
export const ROUND_MS = 30_000; // time limit

// The level a steady tapping speed settles at (it can go past BAR_FULL, meaning it fills).
export const settleLevel = (tapsPerSec) => (tapsPerSec * TAP_FILL - DRAIN_PER_SEC) / LEAK_PER_SEC;

// Nobody taps faster than this. Drumming with several fingers reaches about 24 taps a second,
// so this leaves room; the server uses it to cap reports.
export const MAX_TAPS_PER_SEC = 30;
// How fast a bar can rise from empty (ignores the leak, so real bars are slower).
export const MAX_FILL_PER_SEC = MAX_TAPS_PER_SEC * TAP_FILL - DRAIN_PER_SEC;
// The fullest a bar can be `ms` after the start: MAX_TAPS_PER_SEC the whole time, leak counted.
export const maxLevelAt = (ms) => settleLevel(MAX_TAPS_PER_SEC) * (1 - Math.exp((-LEAK_PER_SEC * Math.max(0, ms)) / 1000));
// The fastest possible fill, and the fewest taps it can take (tapping slower only leaks more).
export const MIN_FILL_MS = Math.floor(
  (-Math.log(1 - BAR_FULL / settleLevel(MAX_TAPS_PER_SEC)) / LEAK_PER_SEC) * 1000
);
export const TAPS_TO_FILL = Math.floor((MIN_FILL_MS / 1000) * MAX_TAPS_PER_SEC);

// Level after `sec` seconds of draining at `drain` per second plus the leak (never below 0).
function drained(level, sec, drain) {
  if (sec <= 0) return level;
  const floor = drain / LEAK_PER_SEC;
  return Math.max(0, (level + floor) * Math.exp(-LEAK_PER_SEC * sec) - floor);
}

// One player's bar. Times are milliseconds on whatever clock the caller uses.
// `saved` (from bar.save()) picks a bar back up, e.g. after the page reloaded; its times
// are relative to the start, so they work on a new page's clock too.
export function createBar(startAt, saved = null) {
  const fromStart = (t) => (t === null || t === undefined ? null : startAt + t);
  let level = saved?.level ?? 0;
  let taps = saved?.taps ?? 0;
  let lastAt = Math.max(startAt, fromStart(saved?.lastAt) ?? startAt);
  let lastTapAt = fromStart(saved?.lastTapAt);
  let filledAt = fromStart(saved?.filledAt);

  function drainTo(now) {
    if (filledAt !== null || now <= lastAt) return;
    // The slow drain and the leak run all the time; the fast drain only once the idle pause has passed.
    const idleFrom = Math.min(now, Math.max(lastAt, (lastTapAt ?? startAt) + IDLE_AFTER_MS));
    level = drained(level, (idleFrom - lastAt) / 1000, DRAIN_PER_SEC);
    level = drained(level, (now - idleFrom) / 1000, DRAIN_PER_SEC + IDLE_DRAIN_PER_SEC);
    lastAt = now;
  }

  return {
    level(now) {
      drainTo(now);
      return level;
    },
    tap(now) {
      drainTo(now);
      if (filledAt !== null || now < startAt) return level;
      taps += 1;
      lastTapAt = now;
      level = Math.min(BAR_FULL, level + TAP_FILL);
      if (level >= BAR_FULL) filledAt = now;
      return level;
    },
    get taps() {
      return taps;
    },
    // Milliseconds from the start until the bar was full, or null.
    get filledMs() {
      return filledAt === null ? null : filledAt - startAt;
    },
    // Everything needed to pick the bar back up later (plain JSON).
    save() {
      const sinceStart = (t) => (t === null ? null : t - startAt);
      return { level, taps, lastAt: sinceStart(lastAt), lastTapAt: sinceStart(lastTapAt), filledAt: sinceStart(filledAt) };
    },
  };
}
