// One round of the party game: lobby -> countdown -> playing -> results.
//
// The game is TAP BATTLE (public/js/shared/tap-battle.js): each phone runs its own bar
// and reports it about 10 times a second. The server opens and closes the round, keeps
// the reported numbers believable, and decides who won:
//   - phones that filled their bar rank first, fastest first (by their own clock, so a
//     slow connection doesn't cost anyone the win);
//   - everyone else ranks by how full their bar was.
// The first full bar ends the round a moment later, so a phone that filled at nearly
// the same time still gets counted.
//
// Phones keep their bar in the browser and resend it until the server confirms it, so a
// phone that finished while its connection was down still gets its result in, even
// after the results are up (for a short while, and only if the numbers add up).
//
// Pure logic, like room.js: no sockets or timers, everything takes `now`.
import {
  BAR_FULL,
  MAX_FILL_PER_SEC,
  MAX_TAPS_PER_SEC,
  MIN_FILL_MS,
  ROUND_MS,
  TAPS_TO_FILL,
} from "../../public/js/shared/tap-battle.js";

// Fewest phones needed to start. 1 lets you try a round alone; set it to 2 for the fair.
export const MIN_PLAYERS = 1;

export const TIMING = {
  countdownMs: 3000,
  roundMs: ROUND_MS,
  // A phone that got the start a little late still plays its full time; its reports
  // are accepted for this long after the time limit.
  graceMs: 2500,
  // After the first full bar, how long other phones have to report theirs.
  finishWindowMs: 1500,
};

// A phone's own finish time can be behind the server's by about one round trip, no more.
const LATENCY_SLACK_MS = 2000;
// Reports can bunch up after a stall; this much extra fill is allowed on top of the rate cap.
const FILL_SLACK = 10;
// How long after the results a phone that was offline can still hand in its final bar.
export const LATE_REPORT_MS = 60_000;
// A phone that reported this close to the end was online when the round closed, so the
// server already has its bar; anything it sends later doesn't count.
const ONLINE_AT_CLOSE_MS = 1000;

export function createRound(timing = {}) {
  const { countdownMs, roundMs, graceMs, finishWindowMs } = { ...TIMING, ...timing };
  let phase = "lobby";
  let number = 0;
  let startsAt = 0;
  let endsAt = 0;
  let closesAt = 0;
  let resultsAt = 0;
  // clientId -> { slot, color, name, level, taps, finishMs, final, reachedAt, reportedAt }
  let entrants = new Map();
  let results = [];

  const running = () => phase === "countdown" || phase === "playing";

  function ranked() {
    return [...entrants.entries()]
      .map(([clientId, e]) => ({ clientId, ...e }))
      .sort((a, b) => {
        if (a.finishMs !== null || b.finishMs !== null) {
          if (a.finishMs === null) return 1;
          if (b.finishMs === null) return -1;
          return a.finishMs - b.finishMs || a.reachedAt - b.reachedAt;
        }
        return b.level - a.level || a.reachedAt - b.reachedAt;
      })
      .map((e, i) => ({ ...e, rank: i + 1 }));
  }

  function firstFinisher() {
    let first = null;
    for (const e of entrants.values()) {
      if (e.finishMs !== null && (first === null || e.finishMs < first.finishMs)) first = e;
    }
    return first;
  }

  // The final bar of a phone that was offline when the round closed. There's no server
  // clock to check it against, so it has to add up on its own.
  function lateReport(entry, msg, now) {
    // Still reporting when the round closed: it wasn't offline, and its bar then is its result.
    if (entry.reportedAt !== null && entry.reportedAt >= closesAt - ONLINE_AT_CLOSE_MS) {
      entry.final = true;
      return { status: "final", entry };
    }
    if (msg.final !== true || now - resultsAt > LATE_REPORT_MS) return { status: "too-late", entry };
    const taps = Number.isSafeInteger(msg.taps) ? msg.taps : 0;
    if (msg.done === true) {
      const ms = Math.round(Number(msg.ms));
      const possible =
        ms >= MIN_FILL_MS &&
        ms <= roundMs &&
        taps >= TAPS_TO_FILL &&
        taps <= Math.floor((ms / 1000) * MAX_TAPS_PER_SEC) + 5;
      if (!possible) return { status: "rejected", entry };
      entry.level = BAR_FULL;
      entry.finishMs = ms;
    } else {
      const level = Number(msg.level);
      if (!Number.isFinite(level)) return { status: "rejected", entry };
      entry.level = Math.min(Math.max(level, 0), BAR_FULL);
    }
    entry.taps = Math.max(entry.taps, Math.min(taps, Math.floor((roundMs / 1000) * MAX_TAPS_PER_SEC) + 5));
    entry.final = true;
    // Arriving late loses any tie.
    entry.reachedAt = now;
    results = ranked();
    return { status: "saved", entry, late: true };
  }

  const publicEntry = ({ slot, color, name, level, taps, finishMs }) => ({
    slot,
    color,
    name,
    level: Math.round(level * 10) / 10,
    taps,
    finishMs,
  });

  return {
    get phase() {
      return phase;
    },

    // players: [{ clientId, slot, color, name }] who are in the room right now.
    start(players, now) {
      if (running()) return { error: "A ROUND IS ALREADY RUNNING." };
      if (players.length < MIN_PLAYERS) {
        return { error: `NEED AT LEAST ${MIN_PLAYERS} ${MIN_PLAYERS === 1 ? "PLAYER" : "PLAYERS"} TO START.` };
      }
      number += 1;
      phase = "countdown";
      startsAt = now + countdownMs;
      endsAt = startsAt + roundMs;
      closesAt = endsAt + graceMs;
      entrants = new Map(
        players.map((p) => [
          p.clientId,
          {
            slot: p.slot,
            color: p.color,
            name: p.name,
            level: 0,
            taps: 0,
            finishMs: null,
            final: false,
            reachedAt: now,
            reportedAt: null,
          },
        ])
      );
      results = [];
      return { ok: true };
    },

    // Moves the round along the clock. Returns true when the phase changed.
    tick(now) {
      if (phase === "countdown" && now >= startsAt) {
        phase = "playing";
        return true;
      }
      if (phase === "playing" && now >= closesAt) {
        phase = "results";
        resultsAt = now;
        results = ranked();
        return true;
      }
      return false;
    },

    // A phone's bar: { round, level, taps, done, ms, final }. `final` means the phone's
    // bar can't change any more (full, or time's up). Returns { status, entry, late }:
    //   saved       the report was taken (possibly capped)
    //   capped      a final bar was taken, but the cap held it back, so it isn't final yet
    //   final       the server already has this phone's final bar
    //   too-late    for an old round, or too long after the results
    //   rejected    doesn't add up, or not in this round
    report(clientId, msg = {}, now) {
      const entry = entrants.get(clientId);
      if (!entry) return { status: "rejected" };
      if (msg.round !== undefined && msg.round !== number) return { status: "too-late" };
      if (entry.final || entry.finishMs !== null) return { status: "final", entry };
      if (phase === "results") return lateReport(entry, msg, now);
      // A phone's GO always reaches the server after the server's own, so nothing counts before it.
      if (!running() || now < startsAt || now > closesAt) return { status: "rejected" };
      const reported = Number(msg.level);
      if (!Number.isFinite(reported)) return { status: "rejected" };

      const playedMs = Math.min(now - startsAt, roundMs);
      const maxLevel = (playedMs / 1000) * MAX_FILL_PER_SEC + FILL_SLACK;
      const nextLevel = Math.min(Math.max(reported, 0), BAR_FULL, maxLevel);
      if (nextLevel !== entry.level) entry.reachedAt = now;
      entry.level = nextLevel;
      entry.reportedAt = now;

      const maxTaps = Math.floor((playedMs / 1000) * MAX_TAPS_PER_SEC) + 5;
      if (Number.isSafeInteger(msg.taps)) entry.taps = Math.max(entry.taps, Math.min(msg.taps, maxTaps));

      if (msg.done === true && entry.level >= BAR_FULL) {
        const serverMs = now - startsAt;
        const claimed = Number.isFinite(msg.ms) ? msg.ms : serverMs;
        const earliest = Math.max(MIN_FILL_MS, serverMs - LATENCY_SLACK_MS);
        entry.finishMs = Math.round(Math.min(Math.max(claimed, earliest), serverMs));
        closesAt = Math.min(closesAt, now + finishWindowMs);
      }
      // A final bar the cap held back (tapped faster than MAX_TAPS_PER_SEC, e.g. with several
      // fingers) isn't final here yet. Locking it in would freeze it below full for good; the
      // phone keeps resending it, and the cap catches up within a few seconds.
      if (msg.final === true && nextLevel < Math.min(reported, BAR_FULL)) return { status: "capped", entry };
      if (msg.final === true) entry.final = true;
      return { status: "saved", entry };
    },

    entry(clientId) {
      return entrants.get(clientId) ?? null;
    },

    // A phone removed from the party (kicked or left) is out of the round too.
    remove(clientId) {
      if (!entrants.delete(clientId)) return;
      if (phase === "results") results = ranked();
    },

    // After the results: back to an empty lobby.
    toLobby() {
      if (phase !== "results") return false;
      phase = "lobby";
      entrants = new Map();
      results = [];
      return true;
    },

    reset() {
      phase = "lobby";
      entrants = new Map();
      results = [];
    },

    // For the big screen: no client ids.
    snapshot(now) {
      const winner = firstFinisher();
      return {
        phase,
        number,
        minPlayers: MIN_PLAYERS,
        durationMs: roundMs,
        startsInMs: phase === "countdown" ? Math.max(0, startsAt - now) : 0,
        endsInMs: running() ? Math.max(0, endsAt - now) : 0,
        winner: winner?.name ?? null,
        bars: [...entrants.values()].map(publicEntry),
        results: results.map((r) => ({ rank: r.rank, ...publicEntry(r) })),
      };
    },

    // For one phone: its own view of the round, timed relative to now.
    viewFor(clientId, now) {
      const entry = entrants.get(clientId);
      const result = phase === "results" ? results.find((r) => r.clientId === clientId) : null;
      const winner = firstFinisher();
      return {
        phase,
        number,
        durationMs: roundMs,
        endsInMs: running() ? endsAt - now : 0,
        inRound: Boolean(entry),
        level: entry?.level ?? 0,
        taps: entry?.taps ?? 0,
        winner: winner?.name ?? null,
        youWon: winner !== null && winner === entry,
        result: result
          ? { rank: result.rank, of: results.length, level: Math.round(result.level), finishMs: result.finishMs }
          : null,
      };
    },
  };
}
