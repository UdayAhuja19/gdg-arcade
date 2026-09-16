import crypto from "node:crypto";
import express from "express";
import { getPool, dbError } from "./db.js";
import { GAME_KEYS, getGame, checkScore } from "./games.js";
import { normalizeName } from "../public/js/shared/names.js";

// Each player's best finished, visible run per game (ties go to whoever got there first).
const BEST_RUNS = `
  SELECT game, player_id, score, finished_at,
         ROW_NUMBER() OVER (PARTITION BY game, player_id ORDER BY score DESC, finished_at ASC) AS rn
  FROM runs
  WHERE hidden = 0 AND score IS NOT NULL`;

const TOP3_ALL = `
  SELECT game, playerId, name, score FROM (
    SELECT b.game, p.id AS playerId, p.name, b.score,
           ROW_NUMBER() OVER (PARTITION BY b.game ORDER BY b.score DESC, b.finished_at ASC) AS pos
    FROM (${BEST_RUNS}) b
    JOIN players p ON p.id = b.player_id
    WHERE b.rn = 1
  ) ranked
  WHERE pos <= 3
  ORDER BY game, pos`;

const TOP3_GAME = `
  SELECT p.id AS playerId, p.name, b.score
  FROM (${BEST_RUNS} AND game = ?) b
  JOIN players p ON p.id = b.player_id
  WHERE b.rn = 1
  ORDER BY b.score DESC, b.finished_at ASC
  LIMIT 3`;

const STANDING = `
  WITH best AS (
    SELECT player_id, score, finished_at FROM (${BEST_RUNS} AND game = ?) b WHERE b.rn = 1
  )
  SELECT me.score AS best,
         1 + (SELECT COUNT(*) FROM best o
              WHERE o.score > me.score OR (o.score = me.score AND o.finished_at < me.finished_at)) AS position
  FROM best me
  WHERE me.player_id = ?`;

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function rowsToBoard(rows) {
  return rows.map((r, i) => ({ rank: i + 1, playerId: r.playerId, name: r.name, score: r.score }));
}

async function top3(db, game) {
  const [rows] = await db.execute(TOP3_GAME, [game]);
  return rowsToBoard(rows);
}

async function standing(db, game, playerId) {
  const [rows] = await db.execute(STANDING, [game, playerId]);
  if (rows.length === 0) return { best: null, rank: null };
  return { best: rows[0].best, rank: Number(rows[0].position) };
}

function requireGame(key) {
  const game = getGame(key);
  if (!game) throw new ApiError(400, "THAT GAME DOESN'T EXIST.");
  return game;
}

function requireId(value, what) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new ApiError(400, `MISSING ${what}.`);
  return id;
}

function tokensMatch(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Wrong PINs lock the admin API for a short while.
const pinLock = { failures: 0, until: 0 };

function requireAdmin(req) {
  const pin = process.env.ADMIN_PIN;
  if (!pin) throw new ApiError(503, "SET ADMIN_PIN IN .ENV TO USE THE ADMIN PAGE.");
  if (Date.now() < pinLock.until) throw new ApiError(429, "TOO MANY WRONG PINS. WAIT 30 SECONDS.");
  if (!tokensMatch(req.get("x-admin-pin") ?? "", pin)) {
    pinLock.failures += 1;
    if (pinLock.failures >= 5) {
      pinLock.failures = 0;
      pinLock.until = Date.now() + 30_000;
    }
    throw new ApiError(401, "WRONG PIN.");
  }
  pinLock.failures = 0;
}

export function createApi() {
  const api = express.Router();
  api.use(express.json({ limit: "10kb" }));

  api.get("/health", async (req, res) => {
    const db = await getPool();
    res.json({ db: Boolean(db) });
  });

  // Everything below needs MySQL.
  api.use(async (req, res, next) => {
    const db = await getPool();
    if (!db) {
      const detail = dbError()?.code === "ER_ACCESS_DENIED_ERROR" ? " CHECK DB_USER AND DB_PASSWORD IN .ENV." : "";
      throw new ApiError(503, `SCORES AREN'T SAVING RIGHT NOW: THE DATABASE IS OFFLINE.${detail}`);
    }
    req.db = db;
    next();
  });

  api.post("/players", async (req, res) => {
    const result = normalizeName(req.body?.name);
    if (result.error) throw new ApiError(422, result.error);
    await req.db.execute(
      "INSERT INTO players (name, name_key) VALUES (?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)",
      [result.name, result.key]
    );
    const [rows] = await req.db.execute("SELECT id, name FROM players WHERE name_key = ?", [result.key]);
    res.json({ player: rows[0] });
  });

  api.get("/leaderboard", async (req, res) => {
    if (req.query.game) {
      const game = requireGame(req.query.game);
      const body = { game: game.key, top3: await top3(req.db, game.key) };
      if (req.query.playerId) {
        body.me = await standing(req.db, game.key, requireId(req.query.playerId, "PLAYER"));
      }
      return res.json(body);
    }
    const [rows] = await req.db.execute(TOP3_ALL);
    const boards = Object.fromEntries(GAME_KEYS.map((key) => [key, []]));
    for (const row of rows) {
      boards[row.game]?.push({ rank: boards[row.game].length + 1, playerId: row.playerId, name: row.name, score: row.score });
    }
    res.json({ boards });
  });

  api.post("/runs", async (req, res) => {
    const game = requireGame(req.body?.game);
    const playerId = requireId(req.body?.playerId, "PLAYER");
    const [players] = await req.db.execute("SELECT id FROM players WHERE id = ?", [playerId]);
    if (players.length === 0) throw new ApiError(404, "PLAYER NOT FOUND. ENTER YOUR NAME AGAIN.");
    const token = crypto.randomBytes(24).toString("hex");
    const [result] = await req.db.execute("INSERT INTO runs (player_id, game, token) VALUES (?, ?, ?)", [
      playerId,
      game.key,
      token,
    ]);
    res.status(201).json({ runId: result.insertId, token });
  });

  api.post("/runs/:id/finish", async (req, res) => {
    const runId = requireId(req.params.id, "RUN");
    const score = req.body?.score;
    const conn = await req.db.getConnection();
    let run;
    try {
      await conn.beginTransaction();
      const [rows] = await conn.execute(
        `SELECT id, player_id AS playerId, game, token, finished_at AS finishedAt,
                TIMESTAMPDIFF(MICROSECOND, started_at, NOW(3)) / 1000000 AS elapsed
         FROM runs WHERE id = ? FOR UPDATE`,
        [runId]
      );
      run = rows[0];
      if (!run || !tokensMatch(req.body?.token ?? "", run.token)) {
        throw new ApiError(404, "THIS GAME WASN'T STARTED PROPERLY. PLAY AGAIN.");
      }
      if (run.finishedAt) throw new ApiError(409, "THIS SCORE IS ALREADY SAVED.");

      const problem = checkScore(getGame(run.game), score, Number(run.elapsed));
      if (problem) {
        // Close the run so the same token can't be retried with a smaller number.
        await conn.execute("UPDATE runs SET finished_at = NOW(3) WHERE id = ?", [runId]);
        await conn.commit();
        throw new ApiError(422, problem);
      }

      await conn.execute("UPDATE runs SET score = ?, finished_at = NOW(3) WHERE id = ?", [score, runId]);
      await conn.commit();
    } catch (err) {
      await conn.rollback().catch(() => {});
      throw err;
    } finally {
      conn.release();
    }

    const [prev] = await req.db.execute(
      "SELECT MAX(score) AS best FROM runs WHERE player_id = ? AND game = ? AND hidden = 0 AND score IS NOT NULL AND id <> ?",
      [run.playerId, run.game, runId]
    );
    const previousBest = prev[0].best;
    const board = await top3(req.db, run.game);
    const me = await standing(req.db, run.game, run.playerId);
    const third = board[2];
    const pointsToTop3 = me.rank > 3 && third ? third.score - me.best + 1 : 0;

    res.json({
      score,
      best: me.best,
      isNewBest: score > 0 && (previousBest == null || score > previousBest),
      rank: me.rank,
      pointsToTop3,
      top3: board,
    });
  });

  // ---------- Admin ----------
  api.get("/admin/overview", async (req, res) => {
    requireAdmin(req);
    const [stats] = await req.db.execute(
      `SELECT game, COUNT(*) AS plays, COUNT(DISTINCT player_id) AS players
       FROM runs WHERE score IS NOT NULL GROUP BY game`
    );
    const [[totals]] = await req.db.execute("SELECT COUNT(*) AS players FROM players");
    res.json({
      players: totals.players,
      games: GAME_KEYS.map((key) => {
        const row = stats.find((s) => s.game === key);
        return { game: key, plays: row?.plays ?? 0, players: row?.players ?? 0 };
      }),
    });
  });

  api.get("/admin/runs", async (req, res) => {
    requireAdmin(req);
    const game = requireGame(req.query.game);
    const [rows] = await req.db.execute(
      `SELECT r.id, r.score, r.hidden, r.finished_at AS finishedAt, p.id AS playerId, p.name
       FROM runs r JOIN players p ON p.id = r.player_id
       WHERE r.game = ? AND r.score IS NOT NULL
       ORDER BY r.score DESC, r.finished_at ASC
       LIMIT 100`,
      [game.key]
    );
    res.json({ runs: rows.map((r) => ({ ...r, hidden: Boolean(r.hidden) })) });
  });

  api.post("/admin/runs/:id/hide", async (req, res) => {
    requireAdmin(req);
    const hidden = req.body?.hidden === false ? 0 : 1;
    await req.db.execute("UPDATE runs SET hidden = ? WHERE id = ?", [hidden, requireId(req.params.id, "RUN")]);
    res.json({ ok: true });
  });

  api.post("/admin/players/:id/hide", async (req, res) => {
    requireAdmin(req);
    await req.db.execute("UPDATE runs SET hidden = 1 WHERE player_id = ?", [requireId(req.params.id, "PLAYER")]);
    res.json({ ok: true });
  });

  api.post("/admin/reset", async (req, res) => {
    requireAdmin(req);
    if (req.body?.confirm !== "RESET") throw new ApiError(400, "TYPE RESET TO CONFIRM.");
    await req.db.query("DELETE FROM runs");
    await req.db.query("DELETE FROM players");
    res.json({ ok: true });
  });

  api.use((req, res) => {
    res.status(404).json({ error: "NOT FOUND." });
  });

  api.use((err, req, res, next) => {
    if (err instanceof ApiError) {
      return res.status(err.status).json({ error: err.message });
    }
    if (err.type === "entity.parse.failed" || err.type === "entity.too.large") {
      return res.status(400).json({ error: "BAD REQUEST." });
    }
    console.error(err);
    res.status(500).json({ error: "SOMETHING BROKE ON THE SERVER. TRY AGAIN." });
  });

  return api;
}
