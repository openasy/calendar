import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Forward-only migrations (ADR 0010): append new entries, never edit or remove old ones. The calendars and contacts are
// on the mail server; this file holds sign-in (from @openasy/auth), the history of bringing the server in step with
// the file, what each room answered, and the secret links calendars are published at.
const MIGRATIONS = [
  `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   -- Each time the mail server was brought in step with the calendar file, and what changed. The last 100 are kept.
   CREATE TABLE sync_runs (
     id INTEGER PRIMARY KEY,
     at TEXT NOT NULL,
     ok INTEGER NOT NULL,
     created INTEGER NOT NULL,
     updated INTEGER NOT NULL,
     disabled INTEGER NOT NULL,
     warnings INTEGER NOT NULL,
     error TEXT
   );
   -- What a room answered to an invitation on its own, and why. Kept 90 days.
   CREATE TABLE room_answers (
     id INTEGER PRIMARY KEY,
     at TEXT NOT NULL,
     room TEXT NOT NULL,
     uid TEXT NOT NULL,
     title TEXT,
     organizer TEXT,
     answer TEXT NOT NULL CHECK (answer IN ('accepted', 'declined')),
     reason TEXT NOT NULL
   );
   CREATE INDEX room_answers_at ON room_answers (at);
   -- A calendar published at a secret address, for apps that subscribe to a link. Only the token's hash is kept.
   CREATE TABLE subscriptions (
     id TEXT PRIMARY KEY,
     token_hash TEXT NOT NULL UNIQUE,
     owner TEXT NOT NULL,
     account_id TEXT NOT NULL,
     calendar_id TEXT NOT NULL,
     name TEXT NOT NULL,
     busy INTEGER NOT NULL,
     created_at TEXT NOT NULL,
     used_at TEXT
   );
   CREATE INDEX subscriptions_owner ON subscriptions (owner)`,
];

/** Opens the product's single SQLite file in WAL mode (ADR 0011) and migrates it forward. */
export function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const row = db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations").get() as { v: number };
  for (let v = row.v; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]!);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(v + 1, new Date().toISOString());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  return db;
}
