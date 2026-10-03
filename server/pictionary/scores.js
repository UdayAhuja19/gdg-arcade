// The hello, world! scoreboard: a small SQLite file that outlives the game.
//
//   players   everyone who joined, with the team they were last in (kept after REMOVE EVERYONE,
//             so the teams are still on record after the event; only a player the host removed
//             by name is marked as removed)
//   games     every finished PICTIONARY game, saved by itself, with each team's score
//   tally     the host's own running tally: one row per game played on the day (PICTIONARY,
//             FAMILY FEUD, …), typed in by hand after that game, with points for each team
//
// node:sqlite is built into Node (no install). openScores() returns null if it isn't available,
// and the game runs exactly as before without a scoreboard.
import fs from "node:fs";
import path from "node:path";
import { TEAMS } from "./game.js";

export const LABEL_MAX = 40;
export const POINTS_LIMIT = 1_000_000;

export async function openScores(file) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    return null;
  }
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS players (
      client_id  TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      team       INTEGER NOT NULL,
      first_seen INTEGER NOT NULL,
      last_seen  INTEGER NOT NULL,
      removed_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS games (
      id       INTEGER PRIMARY KEY,
      ended_at INTEGER NOT NULL,
      turns    INTEGER NOT NULL,
      settings TEXT NOT NULL,
      top      TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS game_scores (
      game_id INTEGER NOT NULL REFERENCES games(id),
      team    INTEGER NOT NULL,
      score   INTEGER NOT NULL,
      rank    INTEGER NOT NULL,
      PRIMARY KEY (game_id, team)
    );
    CREATE TABLE IF NOT EXISTS tally (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      label      TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tally_points (
      tally_id INTEGER NOT NULL REFERENCES tally(id) ON DELETE CASCADE,
      team     INTEGER NOT NULL,
      points   INTEGER NOT NULL,
      PRIMARY KEY (tally_id, team)
    );
  `);

  const q = {
    upsertPlayer: db.prepare(`
      INSERT INTO players (client_id, name, team, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(client_id) DO UPDATE SET name = excluded.name, team = excluded.team, last_seen = excluded.last_seen, removed_at = NULL`),
    removePlayer: db.prepare("UPDATE players SET removed_at = ? WHERE client_id = ?"),
    players: db.prepare("SELECT name, team, removed_at FROM players ORDER BY first_seen, name"),
    insertGame: db.prepare("INSERT OR IGNORE INTO games (id, ended_at, turns, settings, top) VALUES (?, ?, ?, ?, ?)"),
    insertGameScore: db.prepare("INSERT OR REPLACE INTO game_scores (game_id, team, score, rank) VALUES (?, ?, ?, ?)"),
    games: db.prepare("SELECT id, ended_at, turns, settings, top FROM games ORDER BY ended_at DESC"),
    gameScores: db.prepare("SELECT game_id, team, score, rank FROM game_scores"),
    insertTally: db.prepare("INSERT INTO tally (label, created_at, updated_at) VALUES (?, ?, ?)"),
    updateTally: db.prepare("UPDATE tally SET label = ?, updated_at = ? WHERE id = ?"),
    deleteTally: db.prepare("DELETE FROM tally WHERE id = ?"),
    setPoints: db.prepare("INSERT OR REPLACE INTO tally_points (tally_id, team, points) VALUES (?, ?, ?)"),
    clearPoints: db.prepare("DELETE FROM tally_points WHERE tally_id = ?"),
    tally: db.prepare("SELECT id, label, created_at, updated_at FROM tally ORDER BY created_at, id"),
    tallyPoints: db.prepare("SELECT tally_id, team, points FROM tally_points"),
  };

  function inTransaction(fn) {
    db.exec("BEGIN");
    try {
      const out = fn();
      db.exec("COMMIT");
      return out;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  // A tally row as typed by the host: a game name and a whole number of points for each team.
  function checkEntry(entry) {
    const label = String(entry?.label ?? "").replace(/\s+/g, " ").trim().toUpperCase();
    if (!label) return { error: "NAME THE GAME." };
    if (label.length > LABEL_MAX) return { error: `KEEP THE NAME UNDER ${LABEL_MAX} LETTERS.` };
    const points = entry?.points;
    if (!Array.isArray(points) || points.length !== TEAMS.length) return { error: "GIVE EVERY TEAM A SCORE." };
    for (const p of points) {
      if (!Number.isInteger(p) || Math.abs(p) > POINTS_LIMIT) return { error: "SCORES MUST BE WHOLE NUMBERS." };
    }
    return { label, points };
  }

  return {
    // Called with the game's roster whenever it changes. Nobody is ever deleted from the record.
    recordRoster(roster, now) {
      inTransaction(() => {
        for (const p of roster) q.upsertPlayer.run(p.clientId, p.name, p.team, now, now);
      });
    },

    // The host removed this player by name: they no longer count as a member of their team.
    markRemoved(clientId, now) {
      q.removePlayer.run(now, clientId);
    },

    // A finished PICTIONARY game. Saving the same game twice changes nothing.
    recordGame({ id, endedAt, turns, settings, ranking, top }) {
      inTransaction(() => {
        const added = q.insertGame.run(id, endedAt, turns, JSON.stringify(settings ?? {}), JSON.stringify(top ?? []));
        if (added.changes === 0) return;
        for (const r of ranking) q.insertGameScore.run(id, r.team, r.score, r.rank);
      });
    },

    addTally(entry, now) {
      const ok = checkEntry(entry);
      if (ok.error) return ok;
      const id = inTransaction(() => {
        const { lastInsertRowid } = q.insertTally.run(ok.label, now, now);
        ok.points.forEach((points, team) => q.setPoints.run(lastInsertRowid, team, points));
        return Number(lastInsertRowid);
      });
      return { id };
    },

    updateTally(id, entry, now) {
      const ok = checkEntry(entry);
      if (ok.error) return ok;
      return inTransaction(() => {
        if (q.updateTally.run(ok.label, now, id).changes === 0) return { error: "THAT ROW IS GONE." };
        q.clearPoints.run(id);
        ok.points.forEach((points, team) => q.setPoints.run(id, team, points));
        return { id };
      });
    },

    deleteTally(id) {
      return inTransaction(() => {
        q.clearPoints.run(id);
        return q.deleteTally.run(id).changes > 0 ? { id } : { error: "THAT ROW IS GONE." };
      });
    },

    // Everything the scores page shows.
    snapshot() {
      const members = TEAMS.map(() => []);
      for (const p of q.players.all()) {
        if (p.removed_at === null && members[p.team]) members[p.team].push(p.name);
      }
      const scoresByGame = new Map();
      for (const s of q.gameScores.all()) {
        if (!scoresByGame.has(s.game_id)) scoresByGame.set(s.game_id, []);
        scoresByGame.get(s.game_id).push({ team: s.team, score: s.score, rank: s.rank });
      }
      const games = q.games.all().map((g) => ({
        id: g.id,
        endedAt: g.ended_at,
        turns: g.turns,
        settings: JSON.parse(g.settings),
        top: JSON.parse(g.top),
        ranking: (scoresByGame.get(g.id) ?? []).sort((a, b) => a.rank - b.rank || a.team - b.team),
      }));
      const pointsByRow = new Map();
      for (const p of q.tallyPoints.all()) {
        if (!pointsByRow.has(p.tally_id)) pointsByRow.set(p.tally_id, TEAMS.map(() => 0));
        pointsByRow.get(p.tally_id)[p.team] = p.points;
      }
      const tally = q.tally.all().map((t) => ({
        id: t.id,
        label: t.label,
        createdAt: t.created_at,
        updatedAt: t.updated_at,
        points: pointsByRow.get(t.id) ?? TEAMS.map(() => 0),
      }));
      const totals = TEAMS.map((_, i) => tally.reduce((sum, row) => sum + row.points[i], 0));
      return { teams: TEAMS.map((t, i) => ({ name: t.name, members: members[i] })), tally, totals, games };
    },

    // The whole record as one CSV file, for a spreadsheet after the event.
    csv() {
      const snap = this.snapshot();
      const names = TEAMS.map((t) => t.name);
      const cell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
      const rows = [["TALLY"], ["GAME", ...names]];
      for (const t of snap.tally) rows.push([t.label, ...t.points]);
      rows.push(["TOTAL", ...snap.totals], [], ["TEAMS"], ["TEAM", "PLAYER"]);
      snap.teams.forEach((t) => t.members.forEach((m) => rows.push([t.name, m])));
      rows.push([], ["PICTIONARY GAMES (SAVED AUTOMATICALLY)"], ["ENDED", "TURNS", ...names]);
      for (const g of snap.games) {
        const byTeam = names.map((_, i) => g.ranking.find((r) => r.team === i)?.score ?? "");
        rows.push([new Date(g.endedAt).toISOString(), g.turns, ...byTeam]);
      }
      return `${rows.map((r) => r.map(cell).join(",")).join("\n")}\n`;
    },

    close() {
      db.close();
    },
  };
}
