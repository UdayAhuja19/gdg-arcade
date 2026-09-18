// SPLIT SECOND, from the "stop the stopwatch at exactly 10.00" trend, made into a party game:
// a game is 3 rounds, each with a random target between 1 and 5 seconds. In each round every
// phone gets 30 seconds in which it can start and stop its clock as often as it likes — with
// the numbers hidden — before locking one in. The real times are revealed at the end of the
// round, on the phones and on the big screen. Lowest total error after 3 rounds wins.
// Pure logic: no timers, and randomness is passed in.

// Rounds in one game. (The party server calls its own start-to-results cycle a "round" too;
// in the code these are "legs", and people see them as ROUND 1 OF 3.)
export const LEGS = 3;

// The target is drawn from whole seconds: short enough to fit many tries into the window.
export const TARGET_CHOICES_MS = [1000, 2000, 3000, 4000, 5000];

// Nothing faster than this counts: it's a slip, not a guess.
export const MIN_MS = 300;
// A run left going is stopped here, so a forgotten clock can't run for the whole window.
export const RUN_LIMIT_MS = 15_000;
// What a round costs you if you never locked a time in.
export const MISS_MS = 5000;
// Within this of the target is a BULLSEYE.
export const BULLSEYE_MS = 50;

// The three targets for one game, all different, in a random order.
export function targetsFor(random = Math.random) {
  const pool = [...TARGET_CHOICES_MS];
  const picked = [];
  while (picked.length < LEGS && pool.length > 0) {
    const i = Math.min(pool.length - 1, Math.floor(random() * pool.length));
    picked.push(pool.splice(i, 1)[0]);
  }
  return picked;
}

export const errorOf = (ms, targetMs) => Math.abs(Math.round(ms) - targetMs);

// A round nobody locked a time in for (null) costs MISS_MS.
export const totalOf = (legs) => legs.reduce((sum, leg) => sum + (leg ? leg.error : MISS_MS), 0);

// The best single round, for breaking a tie on the total.
export const bestOf = (legs) => legs.reduce((best, leg) => Math.min(best, leg ? leg.error : MISS_MS), MISS_MS);

export const isBullseye = (error) => error <= BULLSEYE_MS;

// 3.12 — seconds with hundredths, the way the trend's videos show it.
export const fmt = (ms) => (Math.round(ms) / 1000).toFixed(2);

// +0.12 / −0.06 / DEAD ON
export function signed(ms, targetMs) {
  const off = Math.round(ms) - targetMs;
  if (off === 0) return "DEAD ON";
  return `${off > 0 ? "+" : "−"}${fmt(Math.abs(off))}`;
}
