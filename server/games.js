import { GAME_LIST } from "../public/js/shared/games.js";

// Score limits used to reject impossible scores. Kept server-side only.
const LIMITS = {
  dino: { maxScore: 99999, maxPerSec: 20 },
  flappy: { maxScore: 99999, maxPerSec: 15 },
  snake: { maxScore: 8000, maxPerSec: 60 },
  memory: { maxScore: 3100, maxPerSec: null },
  stack: { maxScore: 10000, maxPerSec: 100 },
};

export const GAMES = GAME_LIST.map((game) => ({ ...game, ...LIMITS[game.key] }));

export const GAME_KEYS = GAMES.map((g) => g.key);

export function getGame(key) {
  return GAMES.find((g) => g.key === key) ?? null;
}

// Allow for timer jitter plus the points a lucky start can earn in the first second.
const RATE_MARGIN = 1.5;
const RATE_SLACK = 100;

export function checkScore(game, score, elapsedSec) {
  if (!Number.isSafeInteger(score) || score < 0) {
    return "SCORE MUST BE A WHOLE NUMBER.";
  }
  if (score > game.maxScore) {
    return "THAT SCORE IS HIGHER THAN THIS GAME ALLOWS.";
  }
  if (game.maxPerSec != null && score > game.maxPerSec * elapsedSec * RATE_MARGIN + RATE_SLACK) {
    return "THAT SCORE CAME IN TOO FAST.";
  }
  return null;
}
