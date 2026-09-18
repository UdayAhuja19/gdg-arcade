// One party room with up to 5 phones. Pure logic with no sockets or timers, so it
// can be tested directly; server/party/server.js feeds it events and the clock.

// The fifth colour is ink (black): the brand has four colours, and ink is already a game colour in the arcade.
export const MAX_PLAYERS = 5;
export const COLORS = ["red", "blue", "yellow", "green", "black"];

// A phone that drops keeps its slot this long, so a locked screen or a network
// switch doesn't lose its place.
export const REJOIN_GRACE_MS = 20_000;

// Phones send a fake game update 10 times a second, like a race game would.
export const UPDATE_HZ = 10;
// Updates normally arrive every 100ms; a gap longer than this is a visible stutter.
export const STUTTER_GAP_MS = 400;

const PING_WINDOW = 60; // last 60 pings (about a minute)
// Stutters, missed pings and dropouts count over the last minute, so one bad moment doesn't stick.
const RECENT_WINDOW_MS = 60_000;

// Verdict thresholds, per phone, over the last minute.
const GOOD = { p95: 250, stutters: 2, missed: 0, dropouts: 0 };
const OK = { p95: 500, stutters: 6, missed: 6, dropouts: 2 };

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

export function createRoom() {
  // slot index -> player
  const slots = new Array(MAX_PLAYERS).fill(null);

  function findByClient(clientId) {
    return slots.find((p) => p && p.clientId === clientId) ?? null;
  }

  return {
    // Returns { player, rejoined } or { full: true }.
    join({ clientId, name, network }, now) {
      const existing = findByClient(clientId);
      if (existing) {
        if (!existing.connected) {
          existing.reconnects += 1;
          // Locking the phone isn't the network's fault, so it doesn't count against the verdict.
          if (!existing.leftWhilePaused) existing.dropouts.push(now);
        }
        existing.connected = true;
        existing.paused = false;
        existing.name = name;
        existing.network = network ?? existing.network;
        existing.lastUpdateAt = null;
        return { player: existing, rejoined: true };
      }
      const slot = slots.findIndex((p) => p === null);
      if (slot === -1) return { full: true };
      const player = {
        slot,
        color: COLORS[slot],
        clientId,
        name,
        network: network ?? "unknown",
        connected: true,
        paused: false,
        leftWhilePaused: false,
        joinedAt: now,
        disconnectedAt: null,
        reconnects: 0,
        dropouts: [], // times of rejoins after a dropout that wasn't caused by a pause
        rtts: [],
        missedPings: [], // times of pings with no answer
        updates: [], // arrival times in the last second, for updates/sec
        lastUpdateAt: null,
        stutters: [], // times of gaps longer than STUTTER_GAP_MS
        taps: 0,
      };
      slots[slot] = player;
      return { player, rejoined: false };
    },

    leave(clientId, now) {
      const player = findByClient(clientId);
      if (!player || !player.connected) return;
      player.connected = false;
      player.leftWhilePaused = player.paused;
      player.disconnectedAt = now;
      player.updates = [];
    },

    // Removes players whose grace period ran out. Returns the removed players.
    sweep(now) {
      const removed = [];
      slots.forEach((p, i) => {
        if (p && !p.connected && now - p.disconnectedAt > REJOIN_GRACE_MS) {
          removed.push(p);
          slots[i] = null;
        }
      });
      return removed;
    },

    kick(slot) {
      if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_PLAYERS) return null;
      const player = slots[slot];
      slots[slot] = null;
      return player;
    },

    clear() {
      const removed = slots.filter(Boolean);
      slots.fill(null);
      return removed;
    },

    // The phone's page went into the background (screen locked, another app, hidden tab).
    // Browsers slow its timers right down, so nothing it does then says anything about the network.
    setPaused(clientId, paused) {
      const player = findByClient(clientId);
      if (!player) return;
      player.paused = paused;
      player.lastUpdateAt = null;
      player.updates = [];
    },

    recordPing(clientId, rttMs) {
      const player = findByClient(clientId);
      if (!player || player.paused) return;
      player.rtts.push(Math.round(rttMs));
      if (player.rtts.length > PING_WINDOW) player.rtts.shift();
    },

    recordMissedPing(clientId, now) {
      const player = findByClient(clientId);
      if (player && !player.paused) player.missedPings.push(now);
    },

    recordUpdate(clientId, now) {
      const player = findByClient(clientId);
      if (!player || !player.connected || player.paused) return;
      if (player.lastUpdateAt !== null && now - player.lastUpdateAt > STUTTER_GAP_MS) {
        player.stutters.push(now);
      }
      player.lastUpdateAt = now;
      player.updates.push(now);
    },

    recordTap(clientId, count = 1) {
      const player = findByClient(clientId);
      if (!player) return null;
      player.taps += count;
      return player;
    },

    setNetwork(clientId, network) {
      const player = findByClient(clientId);
      if (player) player.network = network;
    },

    player(clientId) {
      return findByClient(clientId);
    },

    // Players whose phones are connected right now, earliest joiner first.
    present() {
      return slots.filter((p) => p && p.connected).sort((a, b) => a.joinedAt - b.joinedAt);
    },

    // A snapshot for the big screen.
    snapshot(now) {
      const players = slots.map((p) => (p ? describe(p, now) : null));
      return { players, verdict: overallVerdict(players) };
    },
  };
}

function recent(times, now) {
  return times.filter((t) => now - t <= RECENT_WINDOW_MS);
}

function describe(p, now) {
  p.updates = p.updates.filter((t) => now - t <= 1000);
  p.stutters = recent(p.stutters, now);
  p.missedPings = recent(p.missedPings, now);
  p.dropouts = recent(p.dropouts, now);
  const median = percentile(p.rtts, 50);
  const p95 = percentile(p.rtts, 95);
  return {
    slot: p.slot,
    color: p.color,
    name: p.name,
    joinedAt: p.joinedAt,
    network: p.network,
    connected: p.connected,
    paused: p.paused,
    rejoinInMs: p.connected ? null : Math.max(0, REJOIN_GRACE_MS - (now - p.disconnectedAt)),
    ping: p.rtts.at(-1) ?? null,
    median,
    p95,
    recentPings: p.rtts.slice(-30),
    updatesPerSec: p.connected && !p.paused ? p.updates.length : 0,
    stutters: p.stutters.length,
    missedPings: p.missedPings.length,
    reconnects: p.reconnects,
    dropouts: p.dropouts.length,
    taps: p.taps,
    verdict: playerVerdict(p, p95),
  };
}

// Expects the recent-window lists to be filtered already (describe does that).
export function playerVerdict(p, p95 = percentile(p.rtts, 95)) {
  if (!p.connected) return "RECONNECTING";
  if (p.paused) return "PAUSED";
  // A phone whose pings never come back in time would otherwise sit on MEASURING forever.
  if (p.missedPings.length > OK.missed || p.dropouts.length > OK.dropouts) return "LAGGY";
  if (p95 === null || p.rtts.length < 3) return "MEASURING";
  if (
    p95 <= GOOD.p95 &&
    p.stutters.length <= GOOD.stutters &&
    p.missedPings.length <= GOOD.missed &&
    p.dropouts.length <= GOOD.dropouts
  ) {
    return "GOOD";
  }
  if (p95 <= OK.p95 && p.stutters.length <= OK.stutters) return "OK";
  return "LAGGY";
}

export function overallVerdict(players) {
  const present = players.filter(Boolean);
  if (present.length === 0) return { level: "waiting", text: "SCAN THE QR CODE TO JOIN" };
  const verdicts = present.map((p) => p.verdict);
  if (verdicts.includes("LAGGY")) return { level: "bad", text: "SOME PHONES ARE LAGGING" };
  if (verdicts.includes("MEASURING")) return { level: "waiting", text: "MEASURING…" };
  if (verdicts.includes("RECONNECTING")) return { level: "warn", text: "A PHONE DROPPED OUT" };
  if (verdicts.includes("PAUSED")) return { level: "warn", text: "A PHONE IS LOCKED OR IN THE BACKGROUND" };
  if (verdicts.every((v) => v === "GOOD")) return { level: "good", text: "READY FOR PARTY GAMES" };
  return { level: "warn", text: "PLAYABLE, BUT A BIT SLOW" };
}
