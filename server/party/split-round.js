// A SPLIT SECOND round: 3 legs, each with its own target. A leg shows the target (set), then
// gives every phone a 30s window in which it may start and stop its clock as often as it likes
// and lock one time in (run), then reveals the real times (reveal). Lowest total error wins.
//
// The phone owns its clock — a press counts the moment it happens — and reports the number it
// measured; this round only checks that number against the server's own clock for the same run.
//
// Pure logic, like room.js: no sockets, no timers, everything takes `now`.
import {
  LEGS,
  MIN_MS,
  MISS_MS,
  RUN_LIMIT_MS,
  bestOf,
  errorOf,
  targetsFor,
  totalOf,
} from "../../public/js/shared/split-second.js";
import { MIN_PLAYERS } from "./round.js";

export const SPLIT_TIMING = {
  // Before the first round: GET READY, with round 1's target already showing.
  countdownMs: 2000,
  // Every round: its target on its own, then a 3-2-1, then the window opens. The target is up
  // before the count, so nobody starts counting without knowing what they're aiming for.
  setMs: 5000,
  // How long a leg's window stays open.
  lockMs: 30_000,
  // The times and the tally stay up this long before the next leg.
  revealMs: 6000,
};

// A phone's own clock can read a little ahead of the server's for the same run (its run started
// when it pressed, the server heard about it a network hop later).
const CLOCK_SLACK_MS = 1500;

export function createSplitRound(timing = {}, { random = Math.random } = {}) {
  const { countdownMs, setMs, lockMs, revealMs } = { ...SPLIT_TIMING, ...timing };

  let phase = "lobby";
  let stage = null; // inside "playing": set -> run -> reveal
  let number = 0;
  let targets = [];
  let leg = 0;
  let startsAt = 0; // when the countdown ends
  let stageEndsAt = 0; // when the current stage ends
  let entrants = new Map();
  let results = [];

  const running = () => phase === "countdown" || phase === "playing";
  const target = () => targets[leg] ?? null;

  function blankEntry({ clientId, slot, color, name }) {
    return {
      clientId,
      slot,
      color,
      name,
      legs: new Array(LEGS).fill(null), // { ms, error } per leg
      runs: 0, // runs in this leg
      runStartedAt: null, // server time the current run started, or null
      current: null, // { ms, error } — the run that would be locked
      locked: false,
      total: 0,
      best: MISS_MS,
      reachedAt: 0, // when this phone locked its latest leg, for tie-breaks
    };
  }

  // Only legs played so far count; a leg still to come isn't a miss.
  function scoreOf(entry) {
    const played = entry.legs.slice(0, leg + 1);
    entry.total = totalOf(played);
    entry.best = bestOf(played);
  }

  // Lowest total error; then the best single round; then whoever locked in first.
  const compare = (a, b) => a.total - b.total || a.best - b.best || a.reachedAt - b.reachedAt;

  function ranked() {
    const rows = [...entrants.values()].sort(compare).map((row) => ({ ...row }));
    rows.forEach((row, i) => {
      row.rank = i > 0 && compare(rows[i - 1], row) === 0 ? rows[i - 1].rank : i + 1;
    });
    return rows;
  }

  function top() {
    if (results.length === 0) return { winner: null, draw: false };
    const first = results.filter((r) => r.rank === 1);
    if (first.length > 1) return { winner: null, draw: true };
    return { winner: first[0].name, draw: false };
  }

  // Everyone in the leg has locked a time in.
  const allLocked = () => [...entrants.values()].every((e) => e.locked);

  function closeLeg(now) {
    for (const entry of entrants.values()) {
      if (!entry.locked) {
        // Not locked in time: the last run they stopped stands, and nothing scores MISS_MS.
        if (entry.current) {
          entry.legs[leg] = { ...entry.current };
          entry.reachedAt = now;
        }
        entry.locked = true;
      }
      entry.runStartedAt = null;
      scoreOf(entry);
    }
    results = ranked();
  }

  function beginLeg(now) {
    for (const entry of entrants.values()) {
      entry.runs = 0;
      entry.runStartedAt = null;
      entry.current = null;
      entry.locked = false;
    }
    stage = "set";
    stageEndsAt = now + setMs;
  }

  function finish(now) {
    phase = "results";
    stage = null;
    for (const entry of entrants.values()) scoreOf(entry);
    results = ranked();
  }

  const publicRow = (e) => ({
    slot: e.slot,
    color: e.color,
    name: e.name,
    runs: e.runs,
    running: e.runStartedAt !== null,
    ms: e.current?.ms ?? null,
    error: e.current?.error ?? null,
    locked: e.locked,
    legs: e.legs.map((l) => (l ? { ms: l.ms, error: l.error } : null)),
    total: e.total,
  });

  return {
    get phase() {
      return phase;
    },

    get stage() {
      return stage;
    },

    get leg() {
      return leg;
    },

    get targets() {
      return [...targets];
    },

    start(players, now) {
      if (running()) return { error: "A ROUND IS ALREADY RUNNING." };
      if (players.length < MIN_PLAYERS) {
        return { error: `NEED AT LEAST ${MIN_PLAYERS} ${MIN_PLAYERS === 1 ? "PLAYER" : "PLAYERS"} TO START.` };
      }
      number += 1;
      phase = "countdown";
      stage = null;
      leg = 0;
      targets = targetsFor(random);
      startsAt = now + countdownMs;
      entrants = new Map(players.map((p) => [p.clientId, blankEntry(p)]));
      results = [];
      return { ok: true };
    },

    // True when the screen and the phones must be told something changed.
    tick(now) {
      if (phase === "countdown" && now >= startsAt) {
        phase = "playing";
        beginLeg(startsAt);
        return true;
      }
      if (phase !== "playing") return false;

      if (stage === "set" && now >= stageEndsAt) {
        stage = "run";
        stageEndsAt = now + lockMs;
        return true;
      }
      if (stage === "run") {
        // A run left going stops itself, so a forgotten clock doesn't hold up the leg.
        for (const entry of entrants.values()) {
          if (entry.runStartedAt !== null && now - entry.runStartedAt >= RUN_LIMIT_MS) entry.runStartedAt = null;
        }
        if (now >= stageEndsAt || (entrants.size > 0 && allLocked())) {
          closeLeg(now);
          stage = "reveal";
          stageEndsAt = now + revealMs;
          return true;
        }
        return false;
      }
      if (stage === "reveal" && now >= stageEndsAt) {
        if (leg + 1 >= LEGS) {
          finish(now);
          return true;
        }
        leg += 1;
        beginLeg(now);
        return true;
      }
      return false;
    },

    // A phone starting a run, stopping it, or locking the stopped one in.
    // msg: { round, leg, event: "start" | "stop" | "lock", ms, seq }
    act(clientId, msg = {}, now) {
      const entry = entrants.get(clientId);
      if (!entry) return { status: "rejected" };
      if (msg.round !== undefined && msg.round !== number) return { status: "too-late" };
      if (phase !== "playing" || stage !== "run") return { status: "rejected", entry };
      if (msg.leg !== undefined && msg.leg !== leg) return { status: "too-late", entry };
      if (entry.locked) return { status: "final", entry };

      if (msg.event === "start") {
        entry.runStartedAt = now;
        entry.runs += 1;
        return { status: "saved", entry };
      }

      if (msg.event === "stop") {
        if (entry.runStartedAt === null) return { status: "rejected", entry };
        // The phone's own number, kept inside what its run could possibly have lasted.
        const serverMs = now - entry.runStartedAt;
        const claimed = Number(msg.ms);
        if (!Number.isFinite(claimed)) return { status: "rejected", entry };
        const ms = Math.round(Math.min(Math.max(claimed, MIN_MS), serverMs + CLOCK_SLACK_MS, RUN_LIMIT_MS));
        entry.runStartedAt = null;
        entry.current = { ms, error: errorOf(ms, target()) };
        return { status: "saved", entry };
      }

      if (msg.event === "lock") {
        if (!entry.current) return { status: "rejected", entry };
        entry.legs[leg] = { ...entry.current };
        entry.locked = true;
        entry.runStartedAt = null;
        entry.reachedAt = now;
        scoreOf(entry);
        return { status: "saved", entry };
      }

      return { status: "rejected", entry };
    },

    entry(clientId) {
      return entrants.get(clientId) ?? null;
    },

    // A phone removed from the party (kicked or left) is out of the game too.
    remove(clientId) {
      if (!entrants.delete(clientId)) return false;
      if (phase === "results") results = ranked();
      return true;
    },

    // After the results: back to an empty lobby.
    toLobby() {
      if (phase !== "results") return false;
      phase = "lobby";
      stage = null;
      entrants = new Map();
      results = [];
      return true;
    },

    reset() {
      phase = "lobby";
      stage = null;
      leg = 0;
      targets = [];
      entrants = new Map();
      results = [];
    },

    // For the big screen: everything it draws, including the numbers the phones can't see.
    snapshot(now) {
      const { winner, draw } = top();
      return {
        phase,
        stage,
        number,
        minPlayers: MIN_PLAYERS,
        leg,
        legs: LEGS,
        targetMs: target(),
        targets: [...targets],
        startsInMs: Math.max(0, startsAt - now),
        setInMs: stage === "set" ? Math.max(0, stageEndsAt - now) : 0,
        endsInMs: stage === "run" ? Math.max(0, stageEndsAt - now) : 0,
        revealInMs: stage === "reveal" ? Math.max(0, stageEndsAt - now) : 0,
        // What the screen's own clock counts up from, per player.
        players: [...entrants.values()].map((e) => ({
          ...publicRow(e),
          runForMs: e.runStartedAt === null ? null : Math.max(0, now - e.runStartedAt),
        })),
        winner,
        draw,
        results: results.map((r) => ({ rank: r.rank, ...publicRow(r), best: r.best })),
      };
    },

    // One phone's own view. While a leg is running it gets no numbers at all: it is counting in
    // its head, and its own clock is the one that matters.
    viewFor(clientId, now) {
      const entry = entrants.get(clientId) ?? null;
      const { winner, draw } = top();
      const mine = phase === "results" && entry ? results.find((r) => r.clientId === clientId) : null;
      const revealed = stage === "reveal" && entry ? entry.legs[leg] : null;
      return {
        phase,
        stage,
        number,
        leg,
        legs: LEGS,
        targetMs: target(),
        startsInMs: Math.max(0, startsAt - now),
        setInMs: stage === "set" ? Math.max(0, stageEndsAt - now) : 0,
        endsInMs: stage === "run" ? Math.max(0, stageEndsAt - now) : 0,
        revealInMs: stage === "reveal" ? Math.max(0, stageEndsAt - now) : 0,
        inRound: entry !== null,
        runs: entry?.runs ?? 0,
        running: entry?.runStartedAt !== null && entry?.runStartedAt !== undefined,
        canLock: Boolean(entry?.current) && !entry?.locked,
        locked: entry?.locked ?? false,
        // Only at the reveal does a phone learn what it actually did.
        reveal: revealed ? { ms: revealed.ms, error: revealed.error, total: entry.total } : null,
        total: entry?.total ?? 0,
        winner,
        youWon: Boolean(winner && entry && winner === entry.name),
        draw,
        result: mine ? { rank: mine.rank, of: results.length, total: mine.total, legs: publicRow(mine).legs } : null,
      };
    },
  };
}
