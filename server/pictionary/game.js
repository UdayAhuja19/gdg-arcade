// PICTIONARY: the rules and the state, with no sockets or timers (everything takes `now`),
// so tests can play whole games with a fake clock.
//
// Up to MAX_PLAYERS phones join and are balanced into six teams. Each turn one team draws:
// one of its players picks a word on their phone, walks up to the laptop and draws it on the
// projector. Everyone in the other five teams guesses on their phone. The drawer's team
// can't guess.
//
// Turn: pick (the drawer chooses 1 of 3 words) → ready (walking up; the clock starts at the
// first stroke) → draw (letters are revealed as hints) → reveal (the word and the points).
//
// Scoring, so team size doesn't decide the winner:
//   a correct guess earns GUESS_MAX points at the start of the turn, falling to GUESS_MIN at the end;
//   a guessing team earns the AVERAGE of its players' guess points (players who don't get it count as 0);
//   the drawing team earns DRAW_MAX × the share of all guessers who got it.
import { isBlocked, NAME_MAX } from "../../public/js/shared/names.js";
import { EASY, MEDIUM, HARD, ALIASES } from "./words.js";

export const TEAMS = [
  { key: "red", name: "RED" },
  { key: "blue", name: "BLUE" },
  { key: "yellow", name: "YELLOW" },
  { key: "green", name: "GREEN" },
  { key: "black", name: "BLACK" },
  { key: "white", name: "WHITE" },
];
export const MAX_PLAYERS = 150;
export const ROUND_CHOICES = [1, 2, 3];
export const DRAW_SECONDS = [60, 80, 100];
export const GUESS_MAX = 300;
export const GUESS_MIN = 100;
export const DRAW_MAX = 200;
export const GUESS_MAX_CHARS = 40;
// What a wrong guess looks like on the projector.
const SHOWN_GUESS_CHARS = 24;
// A long guess is cut at a word if it can be, and marked with "…" so it doesn't look like a bug.
function clip(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

const DEFAULT_TIMING = {
  pickMs: 15_000, // choosing a word; after this one is picked for them
  readyMs: 45_000, // walking up to the laptop; after this the clock starts anyway
  revealMs: 8_000, // the word and the points, then the next turn
  guessGapMs: 600, // one guess per player this often
};
// When letters are revealed, as a share of the drawing time, by how many hints the word gets.
const HINT_AT = { 1: [0.55], 2: [0.45, 0.7], 3: [0.4, 0.6, 0.8] };

// "Ice-cream!" → "icecream": what is compared when judging a guess.
export function keyOf(text) {
  return String(text).normalize("NFKD").toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cur = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length];
}

// "correct", "close" (a typo, a plural, or one word of a two-word answer), "wrong" or "empty".
// Another name for the same thing (ALIASES: "aeroplane" for airplane, "bbq" for barbecue)
// counts as correct, and is close in the same ways.
export function judge(guess, word) {
  if (!keyOf(guess)) return "empty";
  let best = judgeOne(guess, word);
  for (const alias of ALIASES[word] ?? []) {
    if (best === "correct") break;
    const verdict = judgeOne(guess, alias);
    if (verdict === "correct" || (verdict === "close" && best === "wrong")) best = verdict;
  }
  return best;
}

function judgeOne(guess, word) {
  const g = keyOf(guess);
  const w = keyOf(word);
  if (g === w) return "correct";
  if (g === `${w}s` || w === `${g}s` || g === `${w}es` || w === `${g}es`) return "close";
  const limit = w.length >= 8 ? 2 : w.length >= 4 ? 1 : 0;
  if (limit > 0 && Math.abs(g.length - w.length) <= limit && distance(g, w) <= limit) return "close";
  const parts = String(word).toLowerCase().split(/[\s-]+/).map(keyOf).filter((p) => p.length >= 3);
  if (parts.length > 1 && parts.includes(g)) return "close";
  return "wrong";
}

// How many letters get revealed: a third of the word at most, and never more than 3.
// A wrong guess that would help everyone else if it went up on the projector: a chunk of the
// answer ("GIRAF"), the answer inside a longer guess, or a near miss. Only that phone sees it.
export function givesAway(guess, word) {
  const g = keyOf(guess);
  if (g.length < 3) return false;
  const names = [word, ...(ALIASES[word] ?? [])];
  const parts = names.flatMap((n) => [keyOf(n), ...String(n).toLowerCase().split(/[\s-]+/).map(keyOf).filter((p) => p.length >= 3)]);
  return parts.some((w) => {
    if (g.includes(w)) return true;
    if (w.includes(g) && g.length >= Math.min(4, w.length)) return true;
    const limit = Math.max(2, Math.ceil(w.length / 3));
    return Math.abs(g.length - w.length) <= limit && distance(g, w) <= limit;
  });
}

export function hintCount(word) {
  const letters = keyOf(word).length;
  return Math.min(3, Math.max(1, Math.floor((letters - 1) / 2)));
}

// The word with hidden letters as "_" (spaces and punctuation stay as they are).
export function pattern(word, revealed) {
  return [...word].map((ch, i) => (/[a-z0-9]/i.test(ch) ? (revealed.includes(i) ? ch.toUpperCase() : "_") : ch)).join("");
}

export function cleanGuess(raw) {
  if (typeof raw !== "string") return "";
  return raw.replace(/\s+/g, " ").trim().slice(0, GUESS_MAX_CHARS);
}

export function createGame({ random = Math.random, timing = {}, words = { easy: EASY, medium: MEDIUM, hard: HARD } } = {}) {
  const t = { ...DEFAULT_TIMING, ...timing };
  const players = new Map(); // clientId -> player
  let joinOrder = 0;
  let settings = { rounds: 2, drawSeconds: 80 };
  let phase = "lobby"; // lobby | pick | ready | draw | reveal | results
  let scores = TEAMS.map(() => 0);
  let schedule = []; // the team drawing in each turn slot
  let slot = -1;
  let turnsPlayed = 0;
  let turn = null;
  let used = new Set();
  let hold = false;
  let results = null;
  // Changes every game, so the projector never mixes up two games' drawings.
  let gameId = 0;

  const pickOne = (list) => list[Math.floor(random() * list.length)];

  function online(team) {
    return [...players.values()].filter((p) => p.team === team && p.connected);
  }

  function teamSizes() {
    return TEAMS.map((_, i) => {
      let total = 0;
      let on = 0;
      for (const p of players.values()) {
        if (p.team !== i) continue;
        total += 1;
        if (p.connected) on += 1;
      }
      return { total, online: on };
    });
  }

  // A new player goes to the team with the fewest players online, then the fewest overall.
  function smallestTeam() {
    const sizes = teamSizes();
    let best = 0;
    for (let i = 1; i < TEAMS.length; i += 1) {
      const a = sizes[i];
      const b = sizes[best];
      if (a.online < b.online || (a.online === b.online && a.total < b.total)) best = i;
    }
    return best;
  }

  // Two ALIs would look the same on the projector, so the second one is ALI 2.
  function uniqueName(name, clientId) {
    const taken = new Set();
    for (const p of players.values()) if (p.clientId !== clientId) taken.add(p.name);
    let result = name;
    for (let n = 2; taken.has(result); n += 1) {
      const suffix = ` ${n}`;
      result = `${name.slice(0, NAME_MAX - suffix.length).trimEnd()}${suffix}`;
    }
    return result;
  }

  function freshWord(list) {
    const left = list.filter((w) => !used.has(w));
    return pickOne(left.length > 0 ? left : list);
  }

  function chooseDrawer(team, except = null) {
    const options = online(team).filter((p) => p.clientId !== except);
    if (options.length === 0) return null;
    const fewest = Math.min(...options.map((p) => p.drew));
    const tied = options.filter((p) => p.drew === fewest);
    return pickOne(tied);
  }

  function newTurn(team, drawer, now) {
    const choices = [freshWord(words.easy), freshWord(words.medium), freshWord(words.hard)];
    // All three are used up, picked or not: the drawer has seen them, so they'd be easy later.
    for (const w of choices) used.add(w);
    turn = {
      number: turnsPlayed + 1,
      team,
      drawerId: drawer.clientId,
      drawerName: drawer.name,
      choices,
      word: null,
      pickEndsAt: now + t.pickMs,
      readyEndsAt: null,
      drawStartedAt: null,
      drawEndsAt: null,
      revealEndsAt: null,
      hintTimes: [],
      hintOrder: [],
      revealed: [],
      eligible: new Set(),
      guessed: new Map(), // clientId -> { points, order }
      lastGuessAt: new Map(),
      correctFeed: [], // { name, team, points } in order
      teamPoints: null,
      reason: null,
    };
    phase = "pick";
  }

  // On to the next turn in the schedule, skipping a team with nobody online. The game ends
  // when the schedule runs out or fewer than two teams have anyone online.
  function nextTurn(now) {
    turn = null;
    while (slot + 1 < schedule.length) {
      slot += 1;
      const team = schedule[slot];
      const teamsOnline = TEAMS.filter((_, i) => online(i).length > 0).length;
      if (teamsOnline < 2) break;
      const drawer = chooseDrawer(team);
      if (!drawer) continue;
      newTurn(team, drawer, now);
      return;
    }
    finish();
  }

  function chooseWord(index, now) {
    turn.word = turn.choices[index];
    used.add(turn.word);
    turn.readyEndsAt = now + t.readyMs;
    phase = "ready";
  }

  function beginDraw(now) {
    const drawMs = settings.drawSeconds * 1000;
    turn.drawStartedAt = now;
    turn.drawEndsAt = now + drawMs;
    for (const p of players.values()) if (p.connected && p.team !== turn.team) turn.eligible.add(p.clientId);
    const count = hintCount(turn.word);
    turn.hintTimes = HINT_AT[count].map((share) => now + Math.round(drawMs * share));
    const letters = [...turn.word].map((ch, i) => (/[a-z0-9]/i.test(ch) ? i : -1)).filter((i) => i >= 0);
    for (let i = letters.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [letters[i], letters[j]] = [letters[j], letters[i]];
    }
    turn.hintOrder = letters;
    phase = "draw";
  }

  function endTurn(now, reason) {
    turn.reason = reason;
    turn.revealEndsAt = now + t.revealMs;
    const teamPoints = TEAMS.map(() => 0);
    if (turn.word && turn.drawStartedAt !== null) {
      const byTeam = TEAMS.map(() => ({ sum: 0, size: 0 }));
      for (const id of turn.eligible) {
        const p = players.get(id);
        const team = p ? p.team : turn.eligibleTeams?.get(id);
        if (team === undefined) continue;
        byTeam[team].size += 1;
        byTeam[team].sum += turn.guessed.get(id)?.points ?? 0;
      }
      byTeam.forEach((b, i) => {
        if (i !== turn.team && b.size > 0) teamPoints[i] = Math.round(b.sum / b.size);
      });
      const drawPoints = turn.eligible.size > 0 ? Math.round((DRAW_MAX * turn.guessed.size) / turn.eligible.size) : 0;
      teamPoints[turn.team] = drawPoints;
      const drawer = players.get(turn.drawerId);
      if (drawer) drawer.points += drawPoints;
    }
    turn.teamPoints = teamPoints;
    teamPoints.forEach((pts, i) => {
      scores[i] += pts;
    });
    turnsPlayed += 1;
    phase = "reveal";
  }

  function allGuessed() {
    if (turn.guessed.size === 0) return false;
    for (const id of turn.eligible) {
      const p = players.get(id);
      if (p?.connected && !turn.guessed.has(id)) return false;
    }
    return true;
  }

  function ranking() {
    const order = TEAMS.map((tm, i) => ({ team: i, score: scores[i] })).sort((a, b) => b.score - a.score || a.team - b.team);
    let rank = 0;
    return order.map((row, i) => {
      if (i === 0 || row.score !== order[i - 1].score) rank = i + 1;
      return { ...row, rank };
    });
  }

  function finish() {
    phase = "results";
    turn = null;
    const sizes = teamSizes();
    const top = [...players.values()]
      .filter((p) => p.points > 0)
      .sort((a, b) => b.points - a.points || a.order - b.order)
      .slice(0, 3)
      .map((p) => ({ name: p.name, team: p.team, points: p.points }));
    results = {
      // Teams nobody joined aren't in the results.
      ranking: ranking().filter((r) => sizes[r.team].total > 0 || r.score > 0),
      top,
      turns: turnsPlayed,
    };
  }

  function revealHints(now) {
    let changed = false;
    while (turn.revealed.length < turn.hintTimes.length && now >= turn.hintTimes[turn.revealed.length]) {
      turn.revealed.push(turn.hintOrder[turn.revealed.length]);
      changed = true;
    }
    return changed;
  }

  function guessCounts() {
    const counts = TEAMS.map(() => ({ guessed: 0, eligible: 0 }));
    for (const id of turn.eligible) {
      const p = players.get(id);
      if (!p) continue;
      counts[p.team].eligible += 1;
      if (turn.guessed.has(id)) counts[p.team].guessed += 1;
    }
    return counts;
  }

  function turnBase() {
    return {
      team: turn.team,
      drawer: turn.drawerName,
      number: turn.number,
      total: schedule.length,
      round: Math.floor(slot / TEAMS.length) + 1,
      rounds: settings.rounds,
      pickEndsAt: turn.pickEndsAt,
      readyEndsAt: turn.readyEndsAt,
      drawStartedAt: turn.drawStartedAt,
      drawEndsAt: turn.drawEndsAt,
      revealEndsAt: turn.revealEndsAt,
      wordChosen: turn.word !== null,
      pattern: (phase === "draw" || phase === "reveal") && turn.word ? pattern(turn.word, turn.revealed) : null,
      letters: turn.word && phase === "draw" ? keyOf(turn.word).length : null,
    };
  }

  return {
    get phase() {
      return phase;
    },
    get settings() {
      return { ...settings };
    },
    // Which turn a phone's guess or pick was meant for, so one from an earlier turn can't count.
    get turnNumber() {
      return turn?.number ?? null;
    },

    // When this game started: a unique id for saving its results.
    get gameId() {
      return gameId;
    },
    player: (clientId) => players.get(clientId) ?? null,
    get size() {
      return players.size;
    },

    // A phone joins or comes back. Returns { player, rejoined } or { full: true }.
    join({ clientId, name }, now) {
      const known = players.get(clientId);
      if (known) {
        known.connected = true;
        known.name = uniqueName(name, clientId);
        return { player: known, rejoined: true };
      }
      if (players.size >= MAX_PLAYERS) return { full: true };
      // Someone joining mid-turn only counts towards their team's average once they guess.
      const player = { clientId, name: uniqueName(name, clientId), team: smallestTeam(), connected: true, points: 0, correct: 0, drew: 0, order: joinOrder++ };
      players.set(clientId, player);
      return { player, rejoined: false };
    },

    setConnected(clientId, connected) {
      const p = players.get(clientId);
      if (p) p.connected = connected;
      return p ?? null;
    },

    // Removed by the host. A drawer who hasn't started is replaced by a teammate.
    kick(clientId, now) {
      const p = players.get(clientId);
      if (!p) return null;
      if (turn && (phase === "draw" || phase === "reveal")) {
        // Keep their part in this turn's score: remember which team they counted for.
        turn.eligibleTeams ??= new Map();
        turn.eligibleTeams.set(clientId, p.team);
      }
      players.delete(clientId);
      if (turn && turn.drawerId === clientId && (phase === "pick" || phase === "ready")) {
        const next = chooseDrawer(turn.team);
        if (next) newTurn(turn.team, next, now);
        else endTurn(now, "no-drawer");
      }
      return p;
    },

    // Who is in which team, saved by the server so a restart doesn't reshuffle the teams.
    roster() {
      return [...players.values()].sort((a, b) => a.order - b.order).map((p) => ({ clientId: p.clientId, name: p.name, team: p.team }));
    },

    // Brings back a saved roster as offline players (they reconnect by themselves).
    restore(list) {
      if (!Array.isArray(list)) return 0;
      let count = 0;
      for (const item of list) {
        if (players.size >= MAX_PLAYERS) break;
        const ok = item && typeof item.clientId === "string" && typeof item.name === "string" && Number.isInteger(item.team) && item.team >= 0 && item.team < TEAMS.length;
        if (!ok || players.has(item.clientId)) continue;
        players.set(item.clientId, { clientId: item.clientId, name: item.name, team: item.team, connected: false, points: 0, correct: 0, drew: 0, order: joinOrder++ });
        count += 1;
      }
      return count;
    },

    // Lobby only: move players from the biggest team to the smallest until they're within one.
    balance() {
      if (phase !== "lobby" && phase !== "results") return 0;
      let moved = 0;
      for (;;) {
        const sizes = teamSizes().map((s) => s.online);
        const max = Math.max(...sizes);
        const min = Math.min(...sizes);
        if (max - min <= 1) break;
        const from = sizes.indexOf(max);
        const to = sizes.indexOf(min);
        const last = online(from).sort((a, b) => b.order - a.order)[0];
        last.team = to;
        moved += 1;
      }
      return moved;
    },

    setSettings({ rounds, drawSeconds }) {
      if (phase !== "lobby" && phase !== "results") return false;
      if (ROUND_CHOICES.includes(rounds)) settings.rounds = rounds;
      if (DRAW_SECONDS.includes(drawSeconds)) settings.drawSeconds = drawSeconds;
      return true;
    },

    start(now) {
      if (phase !== "lobby" && phase !== "results") return { error: "A GAME IS ALREADY ON." };
      const teamsOnline = TEAMS.filter((_, i) => online(i).length > 0).length;
      if (teamsOnline < 2) return { error: "NEED PLAYERS IN AT LEAST 2 TEAMS." };
      scores = TEAMS.map(() => 0);
      for (const p of players.values()) {
        p.points = 0;
        p.correct = 0;
        p.drew = 0;
      }
      used = new Set();
      schedule = [];
      for (let r = 0; r < settings.rounds; r += 1) TEAMS.forEach((_, i) => schedule.push(i));
      slot = -1;
      turnsPlayed = 0;
      results = null;
      hold = false;
      gameId = now;
      nextTurn(now);
      return { ok: true };
    },

    // The drawer taps one of their three words.
    pick(clientId, index, now) {
      if (phase !== "pick" || turn.drawerId !== clientId) return { status: "not-now" };
      if (!Number.isInteger(index) || index < 0 || index >= turn.choices.length) return { status: "rejected" };
      chooseWord(index, now);
      const drawer = players.get(clientId);
      if (drawer) drawer.drew += 1;
      return { status: "saved", word: turn.word };
    },

    // The first stroke on the projector (or the host's START) starts the clock.
    beginDrawing(now) {
      if (phase !== "ready") return false;
      beginDraw(now);
      return true;
    },

    guess(clientId, raw, now) {
      const p = players.get(clientId);
      if (!p) return { status: "ignored" };
      if (phase !== "draw") return { status: "not-now" };
      if (p.team === turn.team) return { status: "drawing-team" };
      if (turn.guessed.has(clientId)) return { status: "already" };
      const text = cleanGuess(raw);
      if (!text) return { status: "ignored" };
      const last = turn.lastGuessAt.get(clientId);
      if (last !== undefined && now - last < t.guessGapMs) return { status: "too-fast" };
      turn.lastGuessAt.set(clientId, now);
      turn.eligible.add(clientId);

      const verdict = judge(text, turn.word);
      if (verdict === "correct") {
        const drawMs = turn.drawEndsAt - turn.drawStartedAt;
        const share = Math.min(1, Math.max(0, (now - turn.drawStartedAt) / drawMs));
        const points = Math.round(GUESS_MAX - (GUESS_MAX - GUESS_MIN) * share);
        const order = turn.guessed.size + 1;
        turn.guessed.set(clientId, { points, order });
        turn.correctFeed.push({ name: p.name, team: p.team, points });
        p.points += points;
        p.correct += 1;
        const ended = allGuessed();
        if (ended) endTurn(now, "all");
        return { status: "correct", points, order, ended };
      }
      if (verdict === "close") return { status: "close" };
      if (verdict === "empty") return { status: "ignored" };
      // Shown on the projector unless it's rude or gives the answer away.
      const shown = isBlocked(text) || givesAway(text, turn.word) ? null : clip(text.toUpperCase(), SHOWN_GUESS_CHARS);
      return { status: "wrong", shown };
    },

    // Host: a different player from the same team draws instead (their phone may be asleep).
    skipDrawer(now) {
      if (phase !== "pick" && phase !== "ready") return { error: "ONLY BEFORE THE DRAWING STARTS." };
      const next = chooseDrawer(turn.team, turn.drawerId);
      if (!next) return { error: "NOBODY ELSE ON THIS TEAM IS ONLINE." };
      // The first drawer may have seen their word, so it stays used: it never comes up again.
      const old = players.get(turn.drawerId);
      if (old && turn.word) old.drew = Math.max(0, old.drew - 1);
      newTurn(turn.team, next, now);
      return { ok: true };
    },

    // Host: end this turn now. Guesses already made still count.
    skipTurn(now) {
      if (phase !== "pick" && phase !== "ready" && phase !== "draw") return false;
      endTurn(now, "skipped");
      return true;
    },

    next(now) {
      if (phase !== "reveal") return false;
      nextTurn(now);
      return true;
    },

    setHold(value) {
      hold = Boolean(value);
      return hold;
    },

    // Host: stop the game and show the results. A turn being drawn still counts.
    end(now) {
      if (phase === "lobby" || phase === "results") return false;
      if (phase === "draw") endTurn(now, "ended");
      finish();
      return true;
    },

    toLobby() {
      phase = "lobby";
      turn = null;
      results = null;
      scores = TEAMS.map(() => 0);
      return true;
    },

    clear() {
      players.clear();
      joinOrder = 0;
      phase = "lobby";
      turn = null;
      results = null;
      scores = TEAMS.map(() => 0);
    },

    // Moves the game along by the clock. Returns true when something changed.
    tick(now) {
      if (phase === "pick" && now >= turn.pickEndsAt) {
        const index = Math.floor(random() * turn.choices.length);
        chooseWord(index, now);
        const drawer = players.get(turn.drawerId);
        if (drawer) drawer.drew += 1;
        return true;
      }
      if (phase === "ready" && now >= turn.readyEndsAt) {
        beginDraw(now);
        return true;
      }
      if (phase === "draw") {
        if (now >= turn.drawEndsAt) {
          revealHints(now);
          endTurn(now, "time");
          return true;
        }
        if (allGuessed()) {
          endTurn(now, "all");
          return true;
        }
        return revealHints(now);
      }
      if (phase === "reveal" && !hold && now >= turn.revealEndsAt) {
        nextTurn(now);
        return true;
      }
      return false;
    },

    // What the projector shows. Never the word before the reveal.
    screenView(now) {
      const sizes = teamSizes();
      const view = {
        phase,
        serverNow: now,
        settings: { ...settings },
        hold,
        players: players.size,
        online: sizes.reduce((s, x) => s + x.online, 0),
        teams: TEAMS.map((tm, i) => ({ ...tm, score: scores[i], size: sizes[i].total, online: sizes[i].online })),
        turn: null,
        results: phase === "results" ? results : null,
        roster: null,
      };
      if (phase === "lobby" || phase === "results") {
        view.roster = TEAMS.map((_, i) =>
          [...players.values()]
            .filter((p) => p.team === i)
            .sort((a, b) => a.order - b.order)
            .map((p) => ({ id: p.clientId, name: p.name, online: p.connected }))
        );
      }
      if (turn) {
        view.turn = {
          ...turnBase(),
          key: `${gameId}-${turn.number}`,
          counts: phase === "draw" || phase === "reveal" ? guessCounts() : null,
          guessedTotal: turn.guessed.size,
          eligibleTotal: turn.eligible.size,
          correct: turn.correctFeed.slice(-12),
          hintsShown: turn.revealed.length,
        };
        if (phase === "reveal") {
          view.turn.word = turn.word;
          view.turn.teamPoints = turn.teamPoints;
          view.turn.reason = turn.reason;
        }
      }
      return view;
    },

    // What one phone shows. Only the drawer sees the word before the reveal.
    phoneView(clientId, now) {
      const p = players.get(clientId);
      const view = {
        phase,
        serverNow: now,
        you: p ? { name: p.name, team: p.team, points: p.points } : null,
        scores: [...scores],
        turn: null,
        results: phase === "results" ? { ranking: results.ranking, top: results.top } : null,
      };
      if (turn && p) {
        const isDrawer = turn.drawerId === clientId;
        const guessed = turn.guessed.get(clientId);
        view.turn = {
          ...turnBase(),
          isDrawer,
          yourTeam: p.team === turn.team,
          canGuess: phase === "draw" && p.team !== turn.team && !guessed,
          guessed: guessed ? guessed.points : null,
        };
        if (isDrawer && phase === "pick") view.turn.choices = [...turn.choices];
        if ((isDrawer && turn.word) || phase === "reveal") view.turn.word = turn.word;
        if (phase === "reveal") view.turn.teamPoints = turn.teamPoints;
      }
      return view;
    },
  };
}
