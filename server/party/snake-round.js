// One round of SNAKE ROYALE: lobby -> countdown -> playing -> results.
//
// Unlike MASH BATTLE, the laptop runs the game: phones only send turns, and the board
// (public/js/shared/snake-battle.js) steps on the server's clock. A dead snake is out
// for the rest of the round. The round ends when one snake is left (or, playing alone,
// when yours dies), shows the final board for a moment, then the results:
//   - snakes still alive rank first;
//   - then the later a snake died, the better;
//   - then the longer snake; anything still equal shares the rank (a draw at the top).
//
// A phone that drops keeps its snake moving straight. Turns are never resent: one that
// arrives late would steer a snake somewhere its player no longer wants to go.
//
// Pure logic, like round.js: no sockets or timers, everything takes `now`.
import { COLORS } from "./room.js";
import { MIN_PLAYERS } from "./round.js";
import { COLS, ROWS, DIRECTIONS, SPAWN_NAMES, createArena, stepMsAt } from "../../public/js/shared/snake-battle.js";

export const SNAKE_TIMING = {
  countdownMs: 3000,
  // How long the final board stays up before the results.
  endPauseMs: 1500,
  // A fixed step length for tests; normally the speed comes from snake-battle.js.
  stepMs: null,
};

export function createSnakeRound(timing = {}, { random = Math.random } = {}) {
  const { countdownMs, endPauseMs, stepMs } = { ...SNAKE_TIMING, ...timing };
  const stepAfter = (playedMs) => stepMs ?? stepMsAt(playedMs);

  let phase = "lobby";
  let number = 0;
  let startsAt = 0;
  let arena = null;
  let steps = 0;
  let nextStepAt = 0;
  let startedWith = 0;
  let over = false;
  let overAt = 0;
  // clientId -> { slot, color, name, outStep, outAtMs }
  let entrants = new Map();
  let results = [];

  const running = () => phase === "countdown" || phase === "playing";

  function bySlot(slot) {
    for (const [clientId, e] of entrants) if (e.slot === slot) return { clientId, ...e };
    return null;
  }

  // What a snake died of, with the other snake's colour and name when there was one.
  function describeCause(cause) {
    if (!cause) return null;
    if (cause.slot === undefined) return { type: cause.type };
    return { type: cause.type, color: COLORS[cause.slot], name: bySlot(cause.slot)?.name ?? null };
  }

  function standing(clientId, e) {
    const s = arena?.snake(e.slot);
    return {
      clientId,
      ...e,
      alive: s?.alive ?? false,
      length: s?.length ?? 0,
      cause: describeCause(s?.cause),
    };
  }

  function compare(a, b) {
    if (a.alive !== b.alive) return a.alive ? -1 : 1;
    if (!a.alive && a.outStep !== b.outStep) return b.outStep - a.outStep;
    return b.length - a.length;
  }

  function ranked() {
    const rows = [...entrants.entries()].map(([clientId, e]) => standing(clientId, e)).sort(compare);
    rows.forEach((row, i) => {
      row.rank = i > 0 && compare(rows[i - 1], row) === 0 ? rows[i - 1].rank : i + 1;
    });
    return rows;
  }

  function finish(now) {
    over = true;
    overAt = now;
    results = ranked();
  }

  // Playing alone ends when your snake dies; otherwise when one snake (or none) is left.
  function checkOver(now) {
    if (over || phase !== "playing") return;
    const alive = arena.alive;
    if (entrants.size === 0 || alive === 0 || (startedWith >= 2 && alive <= 1)) finish(now);
  }

  // Nobody "wins" a round played alone: it's just over.
  function top() {
    if (!over || startedWith < 2) return { winner: null, draw: false };
    const first = results.filter((r) => r.rank === 1);
    return { winner: first.length === 1 ? first[0].name : null, draw: first.length > 1 };
  }

  function frame() {
    if (!arena) return null;
    return { round: number, step: steps, cols: COLS, rows: ROWS, snakes: arena.snakes(), food: arena.food() };
  }

  const publicRow = ({ slot, color, name, alive, length, cause, outAtMs }) => ({
    slot,
    color,
    name,
    alive,
    length,
    cause,
    outAtMs,
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
      entrants = new Map(
        players.map((p) => [p.clientId, { slot: p.slot, color: p.color, name: p.name, outStep: null, outAtMs: null }])
      );
      startedWith = entrants.size;
      arena = createArena(
        players.map((p) => p.slot),
        { random }
      );
      steps = 0;
      nextStepAt = startsAt + stepAfter(0);
      over = false;
      overAt = 0;
      results = [];
      return { ok: true };
    },

    // Moves the round along the clock. Returns true when the phase changed.
    tick(now) {
      if (phase === "countdown" && now >= startsAt) {
        phase = "playing";
        return true;
      }
      if (phase === "playing" && over && now >= overAt + endPauseMs) {
        phase = "results";
        return true;
      }
      return false;
    },

    // One step of the board when it's due. At most one per call: after a stall the game
    // slows down for a moment instead of jumping several cells at once.
    // Returns null, or { frame, deaths: [{ clientId, slot, cause }], grew: [clientId], over }.
    advance(now) {
      if (phase !== "playing" || over || now < nextStepAt) return null;
      const { deaths, grew } = arena.step();
      steps += 1;
      const playedMs = now - startsAt;
      nextStepAt += stepAfter(playedMs);
      if (nextStepAt <= now) nextStepAt = now + stepAfter(playedMs);

      const died = [];
      for (const d of deaths) {
        const entrant = bySlot(d.slot);
        if (!entrant) continue;
        const e = entrants.get(entrant.clientId);
        e.outStep = steps;
        e.outAtMs = playedMs;
        died.push({ clientId: entrant.clientId, slot: d.slot, cause: describeCause(d.cause) });
      }
      checkOver(now);
      return {
        frame: frame(),
        deaths: died,
        grew: grew.map((slot) => bySlot(slot)?.clientId).filter(Boolean),
        over,
      };
    },

    // A turn from a phone: { round, dir }. Only counts for a live snake after GO.
    turn(clientId, msg = {}, now) {
      const e = entrants.get(clientId);
      if (!e || phase !== "playing" || over || now < startsAt) return false;
      if (msg.round !== number || !Object.hasOwn(DIRECTIONS, msg.dir)) return false;
      return arena.turn(e.slot, msg.dir);
    },

    // The big screen's END ROUND: live snakes rank by length.
    end(now) {
      if (phase !== "playing" || over) return false;
      finish(now);
      return true;
    },

    entry(clientId) {
      return entrants.get(clientId) ?? null;
    },

    // A phone removed from the party (kicked, left, or gone too long) is out of the round.
    remove(clientId, now) {
      const e = entrants.get(clientId);
      if (!e) return false;
      if (phase === "countdown") {
        // Never played: the round carries on as if it hadn't joined.
        arena.kill(e.slot, { type: "left" }, { leaveFood: false });
        startedWith -= 1;
      } else if (phase === "playing" && !over && arena.kill(e.slot, { type: "left" })) {
        e.outStep = steps;
        e.outAtMs = now - startsAt;
      }
      entrants.delete(clientId);
      if (phase === "playing") checkOver(now);
      if (over) results = ranked();
      return true;
    },

    // After the results: back to an empty lobby.
    toLobby() {
      if (phase !== "results") return false;
      phase = "lobby";
      entrants = new Map();
      results = [];
      arena = null;
      return true;
    },

    reset() {
      phase = "lobby";
      entrants = new Map();
      results = [];
      arena = null;
      over = false;
    },

    // The board for the big screen, or null outside a round.
    frame,

    // For the big screen: no client ids.
    snapshot(now) {
      const { winner, draw } = top();
      return {
        phase,
        number,
        minPlayers: MIN_PLAYERS,
        cols: COLS,
        rows: ROWS,
        startsInMs: phase === "countdown" ? Math.max(0, startsAt - now) : 0,
        elapsedMs: phase === "playing" ? (over ? overAt : now) - startsAt : 0,
        alive: arena && running() ? arena.alive : 0,
        over,
        winner,
        draw,
        players: [...entrants.entries()].map(([clientId, e]) => publicRow(standing(clientId, e))),
        results: results.map((r) => ({ rank: r.rank, ...publicRow(r) })),
      };
    },

    // For one phone: its own view of the round, timed relative to now.
    viewFor(clientId, now) {
      const e = entrants.get(clientId);
      const mine = e ? standing(clientId, e) : null;
      const result = phase === "results" ? results.find((r) => r.clientId === clientId) : null;
      const { winner, draw } = top();
      return {
        phase,
        number,
        startsInMs: phase === "countdown" ? Math.max(0, startsAt - now) : 0,
        inRound: Boolean(e),
        alive: mine?.alive ?? false,
        length: mine?.length ?? 0,
        cause: mine?.cause ?? null,
        spawn: e ? SPAWN_NAMES[e.slot] : null,
        over,
        winner,
        draw,
        youWon: winner !== null && results.find((r) => r.rank === 1)?.clientId === clientId,
        result: result
          ? { rank: result.rank, of: results.length, length: result.length, alive: result.alive, outAtMs: result.outAtMs }
          : null,
      };
    },
  };
}
