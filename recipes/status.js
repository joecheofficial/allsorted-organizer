"use strict";

// Zero-network readiness report.
//
// This module needs no API key and no account: it indexes a directory you
// already have on disk. What it genuinely needs is the sqlite3 command-line
// tool and a writable workspace directory, so that is what this reports.
// Inventing a credential to check would be dishonest; reporting nothing at all
// would leave "why did indexing fail?" unanswerable.
//
// This runs no indexing and makes no network call. The sqlite3 lookup walks
// PATH; when a database exists, a read query checks the last index refresh.

const fs = require("node:fs");
const path = require("node:path");
const { resolveTargets } = require("./_helpers");
const { sqlite } = require("../lib/db");

function findOnPath(binary) {
  for (const directory of String(process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
    const names = process.platform === "win32" ? [`${binary}.exe`, binary] : [binary];
    for (const name of names) {
      const candidate = path.join(directory, name);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // Not in this directory, keep looking.
      }
    }
  }
  return null;
}

function nearestExisting(target) {
  let current = path.resolve(target);
  for (;;) {
    if (fs.existsSync(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

module.exports.runRecipe = async function runRecipe(input = {}) {
  const { dir, workspace } = resolveTargets(input.args || {});
  const sqlitePath = findOnPath("sqlite3");
  const workspaceExists = fs.existsSync(workspace);
  const databasePath = path.join(workspace, "myos-brain.db");
  const indexPath = path.join(workspace, "capabilities-index.json");

  let workspaceWritable = false;
  try {
    fs.accessSync(nearestExisting(workspace), fs.constants.W_OK);
    workspaceWritable = true;
  } catch {
    workspaceWritable = false;
  }

  const databaseExists = fs.existsSync(databasePath);
  const indexExists = fs.existsSync(indexPath);
  const ready = Boolean(sqlitePath) && workspaceWritable;

  let lastRunAt = null;
  let nightlyRefreshStale = true;
  let nightlyRefresh = "never recorded. Run reconcile-index, then schedule-nightly.";
  if (databaseExists && sqlitePath) {
    try {
      const hasMeta = sqlite(databasePath, "SELECT name FROM sqlite_master WHERE type='table' AND name='organizer_meta';", true).length > 0;
      if (hasMeta) lastRunAt = (sqlite(databasePath, "SELECT value FROM organizer_meta WHERE key='last_run_at';", true)[0] || {}).value ?? null;
      if (lastRunAt !== null) {
        const age = Date.now() - Date.parse(lastRunAt);
        if (!Number.isFinite(age)) nightlyRefresh = "timestamp is invalid. Run reconcile-index again.";
        else if (age < 0) nightlyRefresh = "timestamp is in the future. Check your computer clock.";
        else {
          nightlyRefreshStale = age > 36 * 60 * 60 * 1000;
          const hours = Math.floor(age / 3600000);
          const minutes = Math.floor(age / 60000);
          nightlyRefresh = hours > 0 ? `${hours} hour${hours === 1 ? "" : "s"} ago`
            : minutes > 0 ? `${minutes} minute${minutes === 1 ? "" : "s"} ago` : "just now";
          if (nightlyRefreshStale) nightlyRefresh += ". More than 36 hours have passed. Run reconcile-index, then schedule-nightly to restore the nightly refresh.";
        }
      }
    } catch { nightlyRefresh = "could not read the timestamp. Check the database and run reconcile-index again."; }
  } else if (databaseExists) {
    nightlyRefresh = "could not check without sqlite3. Install sqlite3 and rerun this check.";
  }

  const lines = [
    "Credentials: none required. There is no API key and no account. This reads a directory you already have and writes only inside its own workspace.",
    sqlitePath
      ? `sqlite3 command: found at ${sqlitePath}.`
      : "sqlite3 command: NOT found on PATH. Install sqlite3 and rerun; indexing cannot run without it.",
    `Workspace directory: ${workspace} ${workspaceExists ? "(exists)" : "(not created yet, it is created on the first index run)"}.`,
    workspaceWritable
      ? "Workspace: writable."
      : "Workspace: NOT writable. Fix the directory permissions, or point MYOS_DISPATCH_HOME at somewhere you can write.",
    databaseExists ? "Database: present." : "Database: not created yet, so nothing has been indexed here.",
    indexExists ? "Capability index: present." : "Capability index: not generated yet.",
    `${nightlyRefreshStale ? "RED FLAG: " : ""}Last nightly index refresh: ${nightlyRefresh}`,
    `Directory that would be indexed by default: ${dir}.`,
    ready
      ? "Ready: yes."
      : "Ready: no. Resolve the item(s) marked NOT above, then rerun this check.",
  ];

  return {
    status: "ok",
    reply: lines.join("\n"),
    metadata: {
      lastRunAt,
      nightlyRefreshStale,
      credentialsRequired: false,
      configured: ready,
      sqlitePath,
      workspace,
      workspaceExists,
      workspaceWritable,
      databasePath,
      databaseExists,
      indexPath,
      indexExists,
      dir,
      network: false,
    },
  };
};
