import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";

const schemaPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../db/schema.sql");

let pool = null;
let connecting = null;
let lastAttempt = 0;
let lastError = null;

const RETRY_MS = 5000;

function config() {
  const database = process.env.DB_NAME || "gdg_arcade";
  if (!/^[A-Za-z0-9_]+$/.test(database)) {
    throw new Error("DB_NAME can only contain letters, numbers and underscores.");
  }
  return {
    host: process.env.DB_HOST || "127.0.0.1",
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    database,
  };
}

async function connect() {
  const { database, ...server } = config();

  // Create the database on first run, then open a pool inside it.
  const admin = await mysql.createConnection(server);
  try {
    await admin.query(
      `CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`
    );
  } finally {
    await admin.end();
  }

  const next = mysql.createPool({ ...server, database, connectionLimit: 10, timezone: "Z" });
  const sql = await fs.readFile(schemaPath, "utf8");
  const statements = sql
    .replace(/^--.*$/gm, "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const statement of statements) {
    await next.query(statement);
  }
  return next;
}

// Connects on first use and retries every few seconds if MySQL isn't up yet,
// so the arcade recovers on its own instead of needing a restart.
export async function getPool() {
  if (pool) return pool;
  if (!connecting) {
    if (Date.now() - lastAttempt < RETRY_MS) return null;
    lastAttempt = Date.now();
    connecting = connect()
      .then((p) => {
        pool = p;
        lastError = null;
        console.log(`MySQL connected (database: ${config().database})`);
        return p;
      })
      .catch((err) => {
        lastError = err;
        console.error(`MySQL not connected: ${err.message}`);
        return null;
      })
      .finally(() => {
        connecting = null;
      });
  }
  return connecting;
}

export function dbError() {
  return lastError;
}

export async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
