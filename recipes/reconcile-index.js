"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { resolveTargets } = require("./_helpers");
const freshness = require("./check-index-freshness");
const indexWorkspace = require("./index-workspace");
const { sqlite, quote, migrate } = require("../lib/db");
const { staleRows } = require("../lib/organizer");

function stat(file) {
  try { return fs.lstatSync(file); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function readContext(project) {
  const file = path.join(project, "CONTEXT.md");
  const info = stat(file);
  if (!info) return null;
  if (!info.isFile()) throw new Error("CONTEXT.md must be a regular file.");
  return fs.readFileSync(file, "utf8");
}

function starterContext(project, name) {
  const files = fs.readdirSync(project, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith(".") && entry.isFile())
    .map((entry) => entry.name).sort();
  const reference = ["README.md", "INDEX.md", "README", "INDEX"]
    .find((file) => files.includes(file));
  const lines = [
    "<!-- Starter stub: replace this with your project context. -->",
    `# ${name}`, "",
    "Add what this project is for, its current status, and your next step.", "",
  ];
  if (reference) {
    lines.push(`## Starting notes from ${reference}`, "",
      fs.readFileSync(path.join(project, reference), "utf8").trim().slice(0, 2000), "");
  }
  if (files.length) lines.push("## Files to start with", "", ...files.slice(0, 10).map((file) => `- ${file}`), "");
  return lines.join("\n");
}

module.exports.runRecipe = async function runRecipe(input = {}) {
  const args = input.args || {};
  const { dir, workspace } = resolveTargets(args);
  const dryRun = args.dryRun === true || args["dry-run"] === true;
  const metadata = {
    dir, workspace, dryRun, addedProjects: [], starterContexts: [],
    missingProjects: [], markedMissingProjects: [], capabilitiesRefreshed: false,
    staleCapabilities: [],
  };
  const result = (ok, summary) => ({ ok, summary, status: ok ? "ok" : "error", reply: summary, artifacts: [], metadata });
  try {
    if (!stat(dir)?.isDirectory()) throw new Error("The workspace scan directory does not exist or is not a regular directory.");
    const projectsDir = path.join(dir, "projects");
    const projectsStat = stat(projectsDir);
    if (projectsStat && !projectsStat.isDirectory()) throw new Error("The projects path must be a regular directory.");
    const indexPath = path.join(projectsDir, "_index.json");
    const indexStat = stat(indexPath);
    if (indexStat && !indexStat.isFile()) throw new Error("The project index must be a regular file.");
    const original = indexStat ? fs.readFileSync(indexPath, "utf8") : null;
    const projectIndex = original === null ? { version: 1, projects: {} } : JSON.parse(original);
    if (!projectIndex || !projectIndex.projects || typeof projectIndex.projects !== "object" || Array.isArray(projectIndex.projects)) {
      throw new Error("The project index must contain a projects object.");
    }
    const entries = projectIndex.projects;
    const indexedPaths = new Set();
    const now = new Date().toISOString();
    for (const [key, entry] of Object.entries(entries)) {
      if (!entry || typeof entry.path !== "string" || !entry.path) throw new Error(`Project ${key} needs a valid path before reconciliation.`);
      const target = path.resolve(projectsDir, entry.path);
      const relative = path.relative(projectsDir, target);
      if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
        throw new Error(`Project ${key} has a path outside the projects folder.`);
      }
      indexedPaths.add(relative);
      if (!stat(target)?.isDirectory()) {
        metadata.missingProjects.push(key);
        if (entry.status !== "missing" || !entry.missing_since) {
          entry.status = "missing";
          entry.missing_since ||= now;
          metadata.markedMissingProjects.push(key);
        }
      }
    }
    const stubs = [];
    const folders = projectsStat ? fs.readdirSync(projectsDir, { withFileTypes: true }) : [];
    for (const folder of folders.sort((a, b) => a.name.localeCompare(b.name))) {
      const name = folder.name;
      if (!folder.isDirectory() || name.startsWith("_") || name.startsWith(".") || name === "node_modules" || indexedPaths.has(name)) continue;
      if (Object.hasOwn(entries, name)) throw new Error(`Project key ${name} already points to a different folder. Review it before adding this project.`);
      const project = path.join(projectsDir, name);
      const context = readContext(project);
      const heading = context?.match(/^# +(.+?)\s*$/m)?.[1]?.trim();
      const title = heading || name;
      Object.defineProperty(entries, name, { enumerable: true, configurable: true, writable: true, value: {
        path: name, name: title,
        aliases: [...new Set([name, name.replace(/[-_]+/g, " "), title])],
        status: "needs-review", added_by: "organizer", added_at: now,
      } });
      metadata.addedProjects.push(name);
      if (context === null) {
        stubs.push({ file: path.join(project, "CONTEXT.md"), text: starterContext(project, name) });
        metadata.starterContexts.push(name);
      }
    }
    const fresh = await freshness.runRecipe({ args: { dir, workspace } });
    if (fresh.status !== "ok") throw new Error(fresh.reply);
    // Capability rows whose source file is gone (a recipe an earlier version
    // shipped). They are dropped by the refresh below; a dry run lists them.
    const brainDb = path.join(workspace, "myos-brain.db");
    if (stat(brainDb)) {
      migrate(brainDb);
      metadata.staleCapabilities = staleRows(brainDb, dir).map((row) => `${row.table}:${row.id} (${row.source_path})`);
    }
    metadata.capabilityRefreshNeeded = fresh.metadata.stale || metadata.staleCapabilities.length > 0;
    const changed = original === null || metadata.addedProjects.length > 0 || metadata.markedMissingProjects.length > 0;
    metadata.projectIndexChanged = changed;
    if (!dryRun) {
      for (const stub of stubs) fs.writeFileSync(stub.file, stub.text, { flag: "wx" });
      if (changed) {
        fs.mkdirSync(projectsDir, { recursive: true });
        // Replace the index only after a complete new copy has been written.
        const temporary = path.join(projectsDir, `._index-${process.pid}-${Date.now()}.tmp`);
        try {
          fs.writeFileSync(temporary, JSON.stringify(projectIndex, null, 2) + "\n", { flag: "wx", mode: indexStat?.mode });
          if ((stat(indexPath) ? fs.readFileSync(indexPath, "utf8") : null) !== original) {
            throw new Error("The project index changed during reconciliation. Run it again.");
          }
          fs.renameSync(temporary, indexPath);
        } finally {
          if (stat(temporary)) fs.unlinkSync(temporary);
        }
      }
      if (metadata.capabilityRefreshNeeded) {
        const refreshed = await indexWorkspace.runRecipe({ args: { dir, workspace } });
        if (refreshed.status !== "ok") throw new Error(refreshed.reply);
        metadata.capabilitiesRefreshed = true;
        metadata.capabilities = refreshed.metadata.capabilities;
      }
    }
    if (!dryRun) {
      const db = path.join(workspace, "myos-brain.db");
      migrate(db);
      sqlite(db, `INSERT INTO organizer_meta(key,value) VALUES('last_run_at',${quote(new Date().toISOString())}) ON CONFLICT(key) DO UPDATE SET value=excluded.value;`);
    }
    const added = metadata.addedProjects.length;
    const starters = metadata.starterContexts.length;
    const missing = metadata.markedMissingProjects.length;
    const lines = [
      `${dryRun ? "Would index" : "Indexed"} ${added} new project${added === 1 ? "" : "s"}.`,
      `${dryRun ? "Would write" : "Wrote"} a starter CONTEXT.md for ${starters} project${starters === 1 ? "" : "s"}.`,
    ];
    if (missing) lines.push(`${missing} indexed project folder${missing === 1 ? " is" : "s are"} missing; ${dryRun ? "would mark" : "marked"} ${missing === 1 ? "it" : "them"}.`);
    const stale = metadata.staleCapabilities.length;
    if (stale) lines.push(`${dryRun ? "Would remove" : "Removed"} ${stale} index row${stale === 1 ? "" : "s"} whose source file no longer exists.`);
    if (metadata.capabilityRefreshNeeded) lines.push(dryRun ? "Would refresh your capability index." : "Refreshed your capability index.");
    if (dryRun) lines.unshift("Dry run. No files were changed.");
    return result(true, lines.join(" "));
  } catch (error) {
    metadata.code = "RECONCILE_FAILED";
    return result(false, `Organizer could not finish reconciling your index: ${error.message}`);
  }
};
