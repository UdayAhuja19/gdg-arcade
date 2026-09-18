// A LIGHTS OUT round: 3 starts. Each start shows the grid (GET READY, then five lights coming on
// one a second and a random hold), then lights out and a short window to tap, then a reveal.
//
// Lights out must happen at the same moment on every phone and on the big screen, whatever the
// ping. So the server schedules it on its own clock and sends the time ahead; each phone has
// synced its clock with the server (`sync` messages) and turns its lights off at that moment on
// its own clock. The phone times the reaction from its own lights out and reports it; this round
// checks the number against when the tap reached the server.
//
// Pure logic, like room.js: no sockets, no timers, everything takes `now`.
import {
  LEGS,
  MIN_REACTION_MS,
  REACT_WINDOW_MS,
  bestOf,
  holdFor,
  lightOnAt,
  outAfter,
  totalOf,
} from "../../public/js/shared/lights-out.js";
import { MIN_PLAYERS } from "./round.js";

export const LIGHTS_TIMING = {
  countdownMs: 2000,
  // From the start of a start (START 1 OF 3 · GET READY) to the first light: time for every
  // phone to hear the schedule and sync its clock, even over a slow tunnel.
  leadMs: 2500,
  reactMs: REACT_WINDOW_MS,
  revealMs: 5000,
  holds: null, // tests pin the three holds
};

// How far a phone's clock can disagree with the server's about lights out and still be believed.
const SYNC_SLACK_MS = 250;

export function createLightsRound(timing = {}, { random = Math.random } = {}) {
  const { countdownMs, leadMs, reactMs, revealMs, holds: fixedHolds } = { ...LIGHTS_TIMING, ...timing };

  let phase = "lobby";
  let stage = null; // inside "playing": grid -> go -> reveal
  let number = 0;
  let leg = 0;
  let holds = [];
  let startsAt = 0;
  let lightsAt = 0; // first light on (server clock)
  let outAt = 0; // lights out (server clock)
  let stageEndsAt = 0;
  let entrants = new Map();
  let results = [];

  const running = () => phase === "countdown" || phase === "playing";

  function blankEntry({ clientId, slot, color, name }) {
    return { clientId, slot, color, name, legs: new Array(LEGS).fill(null), pressed: false, total: 0, best: 0, reachedAt: 0 };
  }

  // Only starts run so far count.
  function scoreOf(entry) {
    const run = entry.legs.slice(0, leg + 1);
    entry.total = totalOf(run);
    entry.best = bestOf(run);
  }

  const compare = (a, b) => a.total - b.total || a.best - b.best || a.reachedAt - b.reachedAt;

  function ranked() {
    const rows = [...entrants.values()].sort(compare).map((row) => ({ ...row }));
    rows.forEach((row, i) => {
      row.rank = i > 0 && compare(rows[i - 1], row) === 0 ? rows[i - 1].rank : i + 1;
    });
    return rows;
  }

  function top() {
    const first = results.filter((r) => r.rank === 1);
    if (first.length === 0) return { winner: null, draw: false };
    if (first.length > 1) return { winner: null, draw: true };
    return { winner: first[0].name, draw: false };
  }

  function beginLeg(at) {
    stage = "grid";
    for (const entry of entrants.values()) entry.pressed = false;
    lightsAt = at + leadMs;
    outAt = lightsAt + outAfter(holds[leg]);
    stageEndsAt = outAt;
  }

  function closeLeg(now) {
    for (const entry of entrants.values()) {
      if (!entry.pressed) entry.legs[leg] = { ms: null, jump: false };
      scoreOf(entry);
    }
    results = ranked();
    stage = "reveal";
    stageEndsAt = now + revealMs;
  }

  const allPressed = () => [...entrants.values()].every((e) => e.pressed);

  const publicRow = (e) => ({
    slot: e.slot,
    color: e.color,
    name: e.name,
    pressed: e.pressed,
    legs: e.legs.map((l) => (l ? { ms: l.ms, jump: l.jump } : null)),
    total: e.total,
  });

  // The schedule, as server-clock times, and how far off they are now.
  function schedule(now) {
    const live = phase === "playing" && (stage === "grid" || stage === "go");
    return {
      serverNow: now,
      lightsAt: live ? lightsAt : null,
      outAt: live ? outAt : null,
      lightTimes: live ? Array.from({ length: 5 }, (_, i) => lightsAt + lightOnAt(i)) : null,
    };
  }

  return {
    get phase() {
      return phase;
    },

    get stage() {
      return stage;
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
      holds = fixedHolds ?? Array.from({ length: LEGS }, () => holdFor(random));
      startsAt = now + countdownMs;
      entrants = new Map(players.map((p) => [p.clientId, blankEntry(p)]));
      results = [];
      return { ok: true };
    },

    tick(now) {
      if (phase === "countdown" && now >= startsAt) {
        phase = "playing";
        beginLeg(startsAt);
        return true;
      }
      if (phase !== "playing") return false;
      if (stage === "grid" && now >= outAt) {
        stage = "go";
        stageEndsAt = outAt + reactMs;
        return true;
      }
      if (stage === "go" && (now >= stageEndsAt || (entrants.size > 0 && allPressed()))) {
        closeLeg(now);
        return true;
      }
      if (stage === "reveal" && now >= stageEndsAt) {
        if (leg + 1 >= LEGS) {
          phase = "results";
          stage = null;
          results = ranked();
          return true;
        }
        leg += 1;
        beginLeg(now);
        return true;
      }
      return false;
    },

    // One tap. msg: { round, leg, ms, jump } — `ms` is the phone's reaction, timed from its own
    // lights out; `jump` is a tap before lights out.
    press(clientId, msg = {}, now) {
      const entry = entrants.get(clientId);
      if (!entry) return { status: "rejected" };
      if (msg.round !== undefined && msg.round !== number) return { status: "too-late" };
      if (phase !== "playing" || (stage !== "grid" && stage !== "go")) return { status: "too-late", entry };
      if (msg.leg !== undefined && msg.leg !== leg) return { status: "too-late", entry };
      if (entry.pressed) return { status: "final", entry };
      if (now < lightsAt) return { status: "rejected", entry }; // before the first light: ignored

      const serverMs = now - outAt;
      let jump = msg.jump === true;
      let ms = null;
      if (!jump) {
        const claimed = Number(msg.ms);
        if (!Number.isFinite(claimed)) return { status: "rejected", entry };
        // A tap the server heard well before lights out, or a "reaction" too fast to be one.
        if (serverMs < -SYNC_SLACK_MS || claimed < MIN_REACTION_MS) jump = true;
        // No faster than the tap could have been, given when it reached the server.
        else ms = Math.round(Math.min(claimed, serverMs + SYNC_SLACK_MS));
        if (ms !== null && ms < MIN_REACTION_MS) {
          jump = true;
          ms = null;
        }
      }
      entry.legs[leg] = { ms, jump };
      entry.pressed = true;
      entry.reachedAt = now;
      scoreOf(entry);
      return { status: "saved", entry };
    },

    entry(clientId) {
      return entrants.get(clientId) ?? null;
    },

    remove(clientId) {
      if (!entrants.delete(clientId)) return false;
      results = ranked();
      return true;
    },

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
      entrants = new Map();
      results = [];
    },

    snapshot(now) {
      const { winner, draw } = top();
      return {
        phase,
        stage,
        number,
        minPlayers: MIN_PLAYERS,
        leg,
        legs: LEGS,
        startsInMs: Math.max(0, startsAt - now),
        revealInMs: stage === "reveal" ? Math.max(0, stageEndsAt - now) : 0,
        ...schedule(now),
        players: [...entrants.values()].map(publicRow),
        winner: phase === "results" ? winner : null,
        draw: phase === "results" ? draw : false,
        results: results.map((r) => ({ rank: r.rank, ...publicRow(r), best: r.best })),
      };
    },

    viewFor(clientId, now) {
      const entry = entrants.get(clientId) ?? null;
      const { winner, draw } = top();
      const mine = phase === "results" && entry ? results.find((r) => r.clientId === clientId) : null;
      const standing = stage === "reveal" && entry ? results.find((r) => r.clientId === clientId) : null;
      return {
        phase,
        stage,
        number,
        leg,
        legs: LEGS,
        startsInMs: Math.max(0, startsAt - now),
        revealInMs: stage === "reveal" ? Math.max(0, stageEndsAt - now) : 0,
        ...schedule(now),
        inRound: entry !== null,
        pressed: entry?.pressed ?? false,
        mine: entry ? entry.legs[leg] : null,
        total: entry?.total ?? 0,
        standing: standing ? { rank: standing.rank, of: results.length } : null,
        winner: phase === "results" ? winner : null,
        youWon: phase === "results" && Boolean(winner && entry && winner === entry.name),
        draw: phase === "results" ? draw : false,
        result: mine ? { rank: mine.rank, of: results.length, total: mine.total, legs: publicRow(mine).legs } : null,
      };
    },
  };
}
