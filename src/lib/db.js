"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

function sqlite(dbPath, sql, json = false) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const args = json ? ["-json", dbPath, sql] : [dbPath, sql];
  const output = execFileSync("sqlite3", args, { encoding: "utf8" });
  return json ? (output.trim() ? JSON.parse(output) : []) : output;
}
function quote(value) {
  return "'" + String(value ?? "").replace(/'/g, "''") + "'";
}
function migrationDir() {
  return path.join(__dirname, "..", "migrations");
}
function migrate(dbPath) {
  sqlite(
    dbPath,
    "CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')));",
  );
  for (
    const name of fs.readdirSync(migrationDir()).filter((x) =>
      /^\d+-.+\.sql$/.test(x)
    ).sort()
  ) {
    const seen = sqlite(
      dbPath,
      `SELECT version FROM schema_migrations WHERE version=${quote(name)};`,
      true,
    );
    if (!seen.length) {
      sqlite(
        dbPath,
        `BEGIN;\n${
          fs.readFileSync(path.join(migrationDir(), name), "utf8")
        }\nINSERT INTO schema_migrations(version) VALUES (${
          quote(name)
        });\nCOMMIT;`,
      );
    }
  }
}
module.exports = { sqlite, quote, migrate };
