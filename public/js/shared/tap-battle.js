// TAP BATTLE, the stand-in party game: every tap fills your bar, the bar always drains
// a little, and it drains fast when you stop tapping. First to fill it wins; if nobody
// does before time's up, the fullest bar wins.
// Phones run the bar (so a tap counts the moment it happens); the server uses the same
// numbers to check what phones report.

export const BAR_FULL = 100;
export const TAP_FILL = 2; // 50 taps fill an empty bar
export const DRAIN_PER_SEC = 6; // always
export const IDLE_AFTER_MS = 350; // no tap for this long...
export const IDLE_DRAIN_PER_SEC = 24; // ...and it drains this much faster
export const ROUND_MS = 30_000; // time limit

// Nobody taps faster than this, so no bar can fill faster than MAX_FILL_PER_SEC. Drumming
// with several fingers is allowed and reaches about 24 taps a second, so this leaves room.
export const MAX_TAPS_PER_SEC = 30;
export const MAX_FILL_PER_SEC = MAX_TAPS_PER_SEC * TAP_FILL - DRAIN_PER_SEC;
export const MIN_FILL_MS = Math.floor((BAR_FULL / MAX_FILL_PER_SEC) * 1000);
export const TAPS_TO_FILL = Math.ceil(BAR_FULL / TAP_FILL);

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
    // The slow drain runs all the time; the fast one only once the idle pause has passed.
    const idleFrom = Math.max(lastAt, (lastTapAt ?? startAt) + IDLE_AFTER_MS);
    const idleSec = Math.max(0, now - idleFrom) / 1000;
    const sec = (now - lastAt) / 1000;
    level = Math.max(0, level - sec * DRAIN_PER_SEC - idleSec * IDLE_DRAIN_PER_SEC);
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
