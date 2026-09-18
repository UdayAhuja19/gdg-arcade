// LIGHTS OUT, from the F1 start: five red lights come on one a second, then after a random
// hold they all go out, and you tap as fast as you can. Tap before they go out and it's a jump
// start. A game is 3 starts; the lowest total time wins.
// Pure logic: no timers, and randomness is passed in.

// Starts in one game. (In the code these are "legs", like SPLIT SECOND's; people see START 1 OF 3.)
export const LEGS = 3;

export const LIGHTS = 5;
// The lights come on at a fixed rate...
export const LIGHT_EVERY_MS = 1000;
// ...then all go out after a random hold, as in F1.
export const HOLD_MIN_MS = 200;
export const HOLD_MAX_MS = 3000;

// Faster than this after lights out isn't a reaction, it's a guess: it counts as a jump start.
export const MIN_REACTION_MS = 100;
// No tap this long after lights out scores as a miss.
export const REACT_WINDOW_MS = 1500;
// What a jump start or a miss adds to your total (a slow honest reaction is about 0.4).
export const PENALTY_MS = 1000;

// The hold between the fifth light and lights out, on a 10ms step.
export function holdFor(random = Math.random) {
  const steps = (HOLD_MAX_MS - HOLD_MIN_MS) / 10;
  return HOLD_MIN_MS + Math.min(steps, Math.floor(random() * (steps + 1))) * 10;
}

// When each light comes on and when they all go out, from the moment the first light comes on.
export const lightOnAt = (i) => i * LIGHT_EVERY_MS;
export const outAfter = (holdMs) => (LIGHTS - 1) * LIGHT_EVERY_MS + holdMs;

// One start's score: a reaction, or the penalty for a jump start or no tap.
export function scoreOf(leg) {
  if (!leg || leg.jump || leg.ms === null) return PENALTY_MS;
  return Math.min(leg.ms, PENALTY_MS);
}

export const totalOf = (legs) => legs.reduce((sum, leg) => sum + scoreOf(leg), 0);
export const bestOf = (legs) => legs.reduce((best, leg) => Math.min(best, scoreOf(leg)), PENALTY_MS);

// 0.234 — reactions read in thousandths, the way the F1 reaction tests show them.
export const fmt = (ms) => (Math.round(ms) / 1000).toFixed(3);

// What to show for one start.
export function legText(leg) {
  if (!leg) return "NO TAP";
  if (leg.jump) return "JUMP START";
  if (leg.ms === null) return "NO TAP";
  return fmt(leg.ms);
}
