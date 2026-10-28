"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { resolveTargets } = require("./_helpers");

const SOURCE_PATTERNS = [/\.recipe\.json$/, /^SKILL\.md$/, /\.workflow\.json$/];
const IGNORED = new Set(["node_modules", ".git", "dist", "build", ".next"]);

// Mirrors the mtime-comparison staleness check the reference indexer uses:
// the index is stale exactly when some indexable source file changed more
// recently than the index artifact itself. This never runs a full index --
// it is a cheap read-only check so it is safe to call reflexively.
function newestSourceMtime(dir) {
  let newest = 0;
  let newestFile = null;
  (function walk(current) {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (
        entry.name.startsWith(".") || IGNORED.has(entry.name) ||
        entry.isSymbolicLink()
      ) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!SOURCE_PATTERNS.some((pattern) => pattern.test(entry.name))) continue;
      let mtime;
      try {
        mtime = fs.statSync(full).mtimeMs;
      } catch {
        continue;
      }
      if (mtime > newest) {
        newest = mtime;
        newestFile = full;
      }
    }
  })(dir);
  return { newest, newestFile };
}

module.exports.runRecipe = async function runRecipe(input = {}) {
  const { dir, workspace } = resolveTargets(input.args || {});
  const indexPath = path.join(workspace, "capabilities-index.json");
  if (!fs.existsSync(indexPath)) {
    return {
      status: "ok",
      reply:
        `No capability index found at ${indexPath} yet. Run a full re-index before relying on it.`,
      artifacts: [],
      metadata: { workspace, dir, indexExists: false, stale: true },
    };
  }
  let indexMtime = 0;
  let capabilityCount = null;
  try {
    indexMtime = fs.statSync(indexPath).mtimeMs;
    const parsed = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    capabilityCount = Array.isArray(parsed.capabilities)
      ? parsed.capabilities.length
      : null;
  } catch (error) {
    return {
      status: "error",
      reply:
        `Organizer could not read the existing index at ${indexPath}: ${error.message}`,
      artifacts: [],
      metadata: { code: "INDEX_UNREADABLE", workspace, dir },
    };
  }
  const { newest, newestFile } = newestSourceMtime(dir);
  const stale = newest > indexMtime;
  const lines = [
    stale
      ? `Index is stale: ${
        newestFile ? path.relative(dir, newestFile) : "a source file"
      } changed after the last index run.`
      : `Index is current: no source file has changed since the last index run.`,
  ];
  if (capabilityCount === 0) {
    lines.push(
      "WARNING: the index reports zero capabilities. That is a red flag, not a clean bill of health -- re-index and investigate before trusting routing decisions on this index.",
    );
  }
  return {
    status: "ok",
    reply: lines.join(" "),
    artifacts: [],
    metadata: {
      workspace,
      dir,
      indexExists: true,
      stale,
      capabilityCount,
      indexMtime,
      newestSourceMtime: newest,
      newestSourceFile: newestFile,
    },
  };
};
