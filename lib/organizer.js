"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { sqlite, quote, migrate } = require("./db");
const ignored = new Set(["node_modules", ".git", "dist", "build", ".next"]);
const sourcePathUniqueTables = new Set([
  "projects",
  "recipes",
  "skills",
  "workflows",
]);
const id = (prefix, value) =>
  `${prefix}:${
    String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(
      /(^-|-$)/g,
      "",
    )
  }`;
const exists = (p) => fs.existsSync(p);
// A distribution package directory (module.spec.json + release-manifest.json)
// holds the SOURCE of a module: module/<name>/recipes/... is what the
// installer copies, not an installed capability. When the install root is also
// a distribution checkout, indexing those trees recorded every recipe twice,
// once at the doubled <name>/module/<name>/ path.
const packageSourceDirs = new Set(["module", "install", "prompts", "overrides", "source"]);
function isPackageDir(dir) {
  return exists(path.join(dir, "module.spec.json")) && exists(path.join(dir, "release-manifest.json"));
}
function walk(root) {
  const out = [], visited = new Set();
  function go(dir) {
    const real = fs.realpathSync(dir);
    if (visited.has(real)) return;
    visited.add(real);
    const packageDir = isPackageDir(dir);
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (
        ent.name.startsWith(".") || ignored.has(ent.name) ||
        ent.isSymbolicLink() ||
        (packageDir && ent.isDirectory() && packageSourceDirs.has(ent.name))
      ) continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) go(p);
      else out.push(p);
    }
  }
  go(root);
  return out.sort();
}
function rel(root, file) {
  return path.relative(root, file).split(path.sep).join("/") || ".";
}
function upsert(db, table, row) {
  const keys = Object.keys(row);
  if (sourcePathUniqueTables.has(table) && row.source_path != null) {
    sqlite(
      db,
      `DELETE FROM ${table} WHERE source_path=${quote(row.source_path)} AND id != ${quote(row.id)};`,
    );
  }
  sqlite(
    db,
    `INSERT INTO ${table} (${keys.join(",")}) VALUES (${
      keys.map((k) => quote(row[k])).join(",")
    }) ON CONFLICT(${keys[0]}) DO UPDATE SET ${
      keys.slice(1).map((k) => `${k}=excluded.${k}`).join(",")
    };`,
  );
}
// Remember only hints this indexer added. Pre-existing customer conditions are
// retained; obsolete source hints can then be removed without clearing them.
function syncSourceUseWhen(db, capabilityId, values) {
  const key = `source_use_when:${capabilityId}`;
  const prior = sqlite(db, `SELECT value FROM organizer_meta WHERE key=${quote(key)};`, true)[0];
  const owned = new Set(prior ? JSON.parse(prior.value) : []);
  const existing = new Set(sqlite(db, `SELECT value FROM capability_use_when WHERE capability_id=${quote(capabilityId)};`, true).map(row => row.value));
  const current = new Set(values);
  const statements = ["BEGIN;"];
  for (const value of owned) if (!current.has(value)) {
    statements.push(`DELETE FROM capability_use_when WHERE capability_id=${quote(capabilityId)} AND value=${quote(value)};`);
    owned.delete(value);
  }
  for (const value of current) {
    if (!existing.has(value)) owned.add(value);
    statements.push(`INSERT OR IGNORE INTO capability_use_when(capability_id,value) VALUES(${quote(capabilityId)},${quote(value)});`);
  }
  statements.push(`INSERT INTO organizer_meta(key,value) VALUES(${quote(key)},${quote(JSON.stringify([...owned]))}) ON CONFLICT(key) DO UPDATE SET value=excluded.value;`, "COMMIT;");
  sqlite(db, statements.join("\n"));
}

function cap(db, row, aliases = [], use = [], avoid = []) {
  upsert(db, "capabilities", row);
  syncSourceUseWhen(db, row.id, use);
  for (
    const [table, values] of [["capability_aliases", aliases], ["capability_avoid_when", avoid]]
  ) {
    for (const value of values.filter(Boolean)) {
      sqlite(
        db,
        `INSERT OR IGNORE INTO ${table}(capability_id,value) VALUES (${
          quote(row.id)
        },${quote(value)});`,
      );
    }
  }
  sqlite(
    db,
    `INSERT OR IGNORE INTO capability_sources(capability_id,source_path) VALUES (${
      quote(row.id)
    },${quote(row.source_path)});`,
  );
}
// Source-authored routing hints only, bounded to keep the exported index small.
function useWhen(metadata, description = metadata?.description) {
  const explicit = metadata?.use_when ?? metadata?.["when-to-use"];
  const values = explicit === undefined ? [description] : Array.isArray(explicit) ? explicit : [explicit];
  return [...new Set(values.filter(value => typeof value === "string").map(value => value.replace(/\s+/g, " ").trim().slice(0, 500)).filter(Boolean))].slice(0, 16);
}

function skillMetadata(file) {
  if (fs.statSync(file).size > 1024 * 1024) return {};
  const { splitFrontMatter, parseFrontMatter } = require("./brain");
  const yaml = splitFrontMatter(fs.readFileSync(file, "utf8")).yaml;
  const metadata = parseFrontMatter(yaml);
  // The shared parser handles scalar strings and lists. Read common YAML block
  // scalars as their authored text rather than exporting the literal '>' or '|'.
  const lines = yaml.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const block = lines[index].match(/^(description|use_when|when-to-use):\s*[>|][-+]?\s*(?:#.*)?$/);
    if (!block) continue;
    const text = [];
    while (index + 1 < lines.length && (!lines[index + 1].trim() || /^\s/.test(lines[index + 1]))) text.push(lines[++index].trim());
    metadata[block[1]] = text.join(" ").replace(/\s+/g, " ").trim();
  }
  return metadata;
}

function migrateSkillCapability(db, oldId, newId, source) {
  const legacy = sqlite(db, `SELECT * FROM capabilities WHERE id=${quote(oldId)} AND type='skill' AND source_path=${quote(source)};`, true)[0];
  const legacySkill = sqlite(db, `SELECT * FROM skills WHERE id=${quote(oldId)} AND source_path=${quote(source)};`, true)[0];
  const metadataKey = `skill_id_metadata:${newId}`;
  if ((legacy || legacySkill) && oldId !== newId) {
    // SQLite produces a coherent snapshot even if the database uses WAL. A
    // snapshot failure stops migration before any legacy row is changed.
    const marker = sqlite(db, "SELECT value FROM organizer_meta WHERE key='skill_id_migration_snapshot';", true)[0];
    if (!marker) {
      const snapshot = `${db}.skill-id-migration-${crypto.randomUUID()}.db`;
      sqlite(db, `VACUUM INTO ${quote(snapshot)};`);
      sqlite(db, `INSERT INTO organizer_meta(key,value) VALUES('skill_id_migration_snapshot',${quote(snapshot)});`);
    }
    const genericDescription = "Skill " + path.basename(path.dirname(source));
    const retained = {
      ...(legacy?.description && legacy.description !== genericDescription ? { description: legacy.description } : {}),
      ...(legacySkill?.version ? { skillsVersion: legacySkill.version } : {}),
      ...(legacySkill?.description && legacySkill.description !== genericDescription ? { skillsDescription: legacySkill.description } : {}),
    };
    const statements = ["BEGIN;", `INSERT OR IGNORE INTO organizer_meta(key,value) VALUES(${quote(metadataKey)},${quote(JSON.stringify(retained))});`];
    if (legacy) {
      statements.push(`INSERT OR IGNORE INTO capabilities SELECT ${quote(newId)},type,execution_lane,source_path,description,priority,version FROM capabilities WHERE id=${quote(oldId)} AND source_path=${quote(source)};`);
      for (const table of ["capability_aliases", "capability_use_when", "capability_avoid_when"]) {
        statements.push(`INSERT OR IGNORE INTO ${table} SELECT ${quote(newId)},value FROM ${table} WHERE capability_id=${quote(oldId)};`, `DELETE FROM ${table} WHERE capability_id=${quote(oldId)};`);
      }
      statements.push(`INSERT OR IGNORE INTO capability_sources SELECT ${quote(newId)},source_path FROM capability_sources WHERE capability_id=${quote(oldId)};`, `DELETE FROM capability_sources WHERE capability_id=${quote(oldId)};`);
      statements.push(`INSERT OR IGNORE INTO recipe_capabilities SELECT recipe_id,${quote(newId)} FROM recipe_capabilities WHERE capability_id=${quote(oldId)};`, `DELETE FROM recipe_capabilities WHERE capability_id=${quote(oldId)};`);
      statements.push(`UPDATE fastpaths SET capability_id=${quote(newId)} WHERE capability_id=${quote(oldId)};`, `DELETE FROM capabilities WHERE id=${quote(oldId)};`);
    }
    statements.push("COMMIT;");
    sqlite(db, statements.join("\n"));
  }
  const current = sqlite(db, `SELECT priority,version FROM capabilities WHERE id=${quote(newId)} AND source_path=${quote(source)};`, true)[0];
  const retained = sqlite(db, `SELECT value FROM organizer_meta WHERE key=${quote(metadataKey)};`, true)[0];
  return { ...current, ...(retained ? JSON.parse(retained.value) : {}) };
}

function structured(db, root, files) {
  for (const file of files) {
    const r = rel(root, file);
    if (file.endsWith(".recipe.json")) {
      let x;
      try {
        x = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {
        continue;
      }
      const rid = id("recipe", x.id || path.basename(file, ".recipe.json"));
      upsert(db, "recipes", {
        id: rid,
        source_path: r,
        description: x.description || x.title || "",
        version: x.version || "1",
      });
      cap(db, {
        id: rid,
        type: "recipe",
        execution_lane: "recipe_dispatcher",
        source_path: r,
        description: x.description || x.title || "",
        priority: 90,
        version: x.version || "1",
      }, [x.title, ...(x.phrases || []), ...(x.tags || [])], useWhen(x, x.description || x.title));
    } else if (path.basename(file) === "SKILL.md") {
      const name = path.basename(path.dirname(file));
      // The exact relative path is lossless: punctuation and case differences
      // cannot collapse two skills into the same slug.
      const sid = `skill:${rel(fs.realpathSync(root), fs.realpathSync(file))}`;
      const previous = migrateSkillCapability(db, id("skill", name), sid, r);
      const metadata = skillMetadata(file);
      const description = typeof metadata.description === "string" ? metadata.description.trim().slice(0, 500) : "";
      upsert(db, "skills", {
        id: sid,
        source_path: r,
        description: previous.skillsDescription || description || "Skill " + name,
        version: previous.skillsVersion || "1",
      });
      cap(db, {
        id: sid,
        type: "skill",
        execution_lane: "worker_skill",
        source_path: r,
        description: previous.description || description || "Skill " + name,
        priority: previous.priority ?? 40,
        version: previous.version || "1",
      }, [name, id("skill", name), metadata.name].filter(value => typeof value === "string"), useWhen(metadata, description));
    } else if (file.endsWith(".workflow.json")) {
      let x;
      try {
        x = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {
        continue;
      }
      const wid = id("workflow", x.id || path.basename(file, ".workflow.json"));
      upsert(db, "workflows", {
        id: wid,
        source_path: r,
        description: x.description || "",
        version: x.version || "1",
      });
      cap(db, {
        id: wid,
        type: "workflow",
        execution_lane: "workflow",
        source_path: r,
        description: x.description || "",
        priority: 80,
        version: x.version || "1",
      }, [x.name], useWhen(x));
    } else if (path.basename(file) === "agent-registry.json") {
      let x;
      try {
        x = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {
        continue;
      }
      for (const a of Array.isArray(x) ? x : (x.agents || [])) {
        const aid = id("agent", a.id || a.name);
        upsert(db, "agents", {
          id: aid,
          name: a.name || a.id,
          source_path: r,
          description: a.description || "",
          version: a.version || "1",
        });
        cap(db, {
          id: aid,
          type: "agent",
          execution_lane: "worker_skill",
          source_path: r,
          description: a.description || "",
          priority: 50,
          version: a.version || "1",
        }, a.tags || [], useWhen(a));
      }
    }
  }
}
function inference(db, root, files) {
  const pkgFiles = files.filter((f) => path.basename(f) === "package.json");
  for (const pkgFile of pkgFiles) {
    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
    } catch {
      continue;
    }
    const dir = path.dirname(pkgFile),
      p = rel(root, dir),
      pid = id("project", pkg.name || path.basename(dir));
    upsert(db, "projects", {
      id: pid,
      name: pkg.name || path.basename(dir),
      source_path: p,
      description: pkg.description || "",
      version: pkg.version || "1",
    });
    for (
      const domain of String(pkg.keywords || []).split(",").filter(Boolean)
    ) {
      sqlite(
        db,
        `INSERT OR IGNORE INTO project_domains(project_id,domain) VALUES(${
          quote(pid)
        },${quote(domain)});`,
      );
    }
    const commands = Object.keys(pkg.scripts || {});
    const bins = typeof pkg.bin === "object"
      ? Object.keys(pkg.bin)
      : pkg.bin
      ? [pkg.name]
      : [];
    const cid = id("capability", pkg.name || path.basename(dir));
    // npm script names ("draft", "send", "start", "status", "doctor") are
    // generic verbs every project shares. As aliases they routed "draft an
    // email" to Meta Ads and "send" to Slack, so they are not aliases. An index
    // built by an earlier version still holds them: remove exactly those.
    const kept = new Set([pkg.name, ...bins].filter(Boolean));
    const stale = commands.filter((command) => !kept.has(command));
    if (stale.length) {
      sqlite(
        db,
        `DELETE FROM capability_aliases WHERE capability_id=${quote(cid)} AND value IN (${
          stale.map(quote).join(",")
        });`,
      );
    }
    cap(
      db,
      {
        id: cid,
        type: "project",
        execution_lane: "worker_skill",
        source_path: p,
        description: pkg.description ||
          `Project ${pkg.name || path.basename(dir)}`,
        priority: 60,
        version: pkg.version || "1",
      },
      [pkg.name, ...bins],
      useWhen(pkg, pkg.description),
    );
  }
}
function emitIndex(db, workspace, root) {
  const rows = sqlite(db, "SELECT * FROM capabilities ORDER BY id;", true);
  const ids = rows.map((row) => quote(row.id)).join(",");
  const valuesByCapability = (table) => {
    const grouped = new Map(rows.map((row) => [row.id, []]));
    if (!ids) return grouped;
    for (
      const row of sqlite(
        db,
        `SELECT capability_id,value FROM ${table} WHERE capability_id IN (${ids}) ORDER BY capability_id,value;`,
        true,
      )
    ) grouped.get(row.capability_id).push(row.value);
    return grouped;
  };
  const aliases = valuesByCapability("capability_aliases");
  const useWhen = valuesByCapability("capability_use_when");
  const avoidWhen = valuesByCapability("capability_avoid_when");
  const capabilities = rows.map((x) => ({
    id: x.id,
    type: x.type,
    execution_lane: x.execution_lane,
    source_path: x.source_path,
    description: x.description,
    aliases: aliases.get(x.id),
    use_when: useWhen.get(x.id),
    avoid_when: avoidWhen.get(x.id),
    runtime_requirements: [],
    priority: Number(x.priority),
    version: x.version,
  }));
  const output = {
    schema_version: 1,
    version: 1,
    generated_at: new Date().toISOString(),
    generator_version: 1,
    scan_dir: root,
    lanes: { recipe_dispatcher: [], worker_skill: [], workflow: [] },
    capabilities,
  };
  for (const x of capabilities) output.lanes[x.execution_lane]?.push(x.id);
  fs.mkdirSync(workspace, { recursive: true });
  const payload = JSON.stringify(output, null, 2) + "\n";
  fs.writeFileSync(path.join(workspace, "capabilities-index.json"), payload);

  // Write the copy the ROUTER reads as well. All Sorted Dispatch resolves its index at
  // <home>/workspace/capabilities-index.json while this module writes
  // <home>/capabilities-index.json, one directory apart, and nothing surfaced the
  // disagreement. On a real install that meant a customer could rebuild this index
  // perfectly, verify it, and change nothing about how anything routed: the router's
  // copy had 0 of 432 entries resolving while this one had 799 of 799.
  //
  // This module is documented as the thing that keeps routing accurate, so it writes
  // both rather than leaving the two halves to disagree in silence.
  try {
    const routerWorkspace = path.join(workspace, "workspace");
    if (path.basename(workspace) !== "workspace") {
      fs.mkdirSync(routerWorkspace, { recursive: true });
      fs.writeFileSync(path.join(routerWorkspace, "capabilities-index.json"), payload);
    }
  } catch (error) {
    // Never fail an index because the second copy could not be written; report it.
    console.warn(`[organizer] wrote the primary index but not the router copy: ${error.message}`);
  }
  return output;
}
function proposeFastpaths(db) {
  const caps = sqlite(
    db,
    "SELECT * FROM capabilities WHERE type='project' ORDER BY id;",
    true,
  );
  const counts = sqlite(
    db,
    "SELECT status,COUNT(*) count FROM fastpaths WHERE status != 'retired' GROUP BY status;",
    true,
  );
  const n = Object.fromEntries(counts.map((x) => [x.status, +x.count]));
  for (
    const candidate of sqlite(
      db,
      "SELECT intent FROM fastpaths WHERE status='probation' AND hit_count_7d >= 3 ORDER BY intent;",
      true,
    )
  ) {
    if ((n.stable || 0) >= 20) break;
    sqlite(
      db,
      `UPDATE fastpaths SET status='stable' WHERE intent=${
        quote(candidate.intent)
      };`,
    );
    n.probation = (n.probation || 0) - 1;
    n.stable = (n.stable || 0) + 1;
  }
  for (const c of caps) {
    if (
      (n.probation || 0) >= 10 || (n.probation || 0) + (n.stable || 0) >= 30
    ) break;
    const intent = `use ${c.id.replace(/^capability:/, "").replace(/-/g, " ")}`;
    const seen = sqlite(
      db,
      `SELECT intent FROM fastpaths WHERE intent=${quote(intent)};`,
      true,
    );
    if (seen.length) continue;
    sqlite(
      db,
      `INSERT INTO fastpaths(intent,status,last_seen_at,cli,stop_rule,capability_id,project_path,evidence) VALUES(${
        quote(intent)
      },'probation',datetime('now'),${quote("organizer index")},${
        quote("Stop after matching capability.")
      },${quote(c.id)},${quote(c.source_path)},${
        quote("inferred from package.json")
      });`,
    );
    sqlite(
      db,
      `INSERT INTO fastpath_match_terms(intent,term) VALUES(${quote(intent)},${
        quote(c.id.replace(/^capability:/, ""))
      });`,
    );
    n.probation = (n.probation || 0) + 1;
  }
}
function readTaskClassConfig(workspace) {
  const configPath = path.join(workspace, "config", "task-classes.json");
  if (!exists(configPath)) return { path: configPath, taskClasses: 0 };
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (!config || typeof config !== "object" || !config.taskClasses || typeof config.taskClasses !== "object") {
    throw new Error("Invalid config/task-classes.json");
  }
  return { path: configPath, taskClasses: Object.keys(config.taskClasses).length };
}
// Rows whose source file is gone. The index used to be add-only, so every
// recipe any earlier version shipped stayed routable forever and failed the
// installer's disk check (customer report 2026-10-05). Absolute source paths
// (rows added by hand with "organizer add") are left alone.
const sourceTables = ["agents", "projects", "recipes", "skills", "workflows", "capabilities"];
// One myos-brain.db can hold rows from more than one indexed folder, each
// relative to its own folder. A row is only this folder's to prune when
// source_roots says this folder recorded it and no other folder did. Rows
// from before source_roots existed belong to the folder recorded as the last
// scan_root (the install root, for an installer-built index).
function ownedBy(db, root, previousRoot) {
  const roots = new Map();
  for (const row of sqlite(db, "SELECT source_path,scan_root FROM source_roots;", true)) {
    if (!roots.has(row.source_path)) roots.set(row.source_path, new Set());
    roots.get(row.source_path).add(row.scan_root);
  }
  // A legacy row (no source_roots entry) is taken as this folder's only when
  // this folder was the last one indexed AND its first path segment exists
  // here: a row another folder wrote (e.g. "recipes/x" from a project
  // folder) is left alone.
  return (source) => {
    const seen = roots.get(source);
    if (!seen) {
      const lastWasHere = previousRoot === undefined || previousRoot === null || previousRoot === root;
      const top = String(source).split("/")[0];
      return lastWasHere && Boolean(top) && exists(path.join(root, top));
    }
    return seen.size === 1 && seen.has(root);
  };
}
function staleRows(db, root, { previousRoot } = {}) {
  const prior = previousRoot !== undefined ? previousRoot : (sqlite(db, "SELECT value FROM organizer_meta WHERE key='scan_root';", true)[0] || {}).value;
  const mine = ownedBy(db, root, prior);
  const gone = (source) => typeof source === "string" && source !== "" && !path.isAbsolute(source) && mine(source) && !exists(path.join(root, source));
  const rows = [];
  for (const table of sourceTables) {
    for (const row of sqlite(db, `SELECT id,source_path FROM ${table} WHERE source_path IS NOT NULL AND source_path != '';`, true)) {
      if (gone(row.source_path)) rows.push({ table, id: row.id, source_path: row.source_path });
    }
  }
  for (const row of sqlite(db, "SELECT capability_id,source_path FROM capability_sources;", true)) {
    if (gone(row.source_path)) rows.push({ table: "capability_sources", id: row.capability_id, source_path: row.source_path });
  }
  return rows;
}
function pruneStaleRows(db, root, { dryRun = false, previousRoot } = {}) {
  const rows = staleRows(db, root, { previousRoot });
  if (dryRun || !rows.length) return rows;
  // Snapshot once before the first prune of a database (rows recorded before
  // source_roots existed are pruned on that run).
  const marker = sqlite(db, "SELECT value FROM organizer_meta WHERE key='prune_snapshot';", true)[0];
  if (!marker) {
    const snapshot = `${db}.before-prune-${new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "")}`;
    try { fs.copyFileSync(db, snapshot); } catch { /* the prune still runs; the installer backs the file up too */ }
    sqlite(db, `INSERT INTO organizer_meta(key,value) VALUES('prune_snapshot',${quote(snapshot)}) ON CONFLICT(key) DO NOTHING;`);
  }
  const statements = ["BEGIN;"];
  for (const row of rows) {
    if (row.table === "capability_sources") {
      statements.push(`DELETE FROM capability_sources WHERE capability_id=${quote(row.id)} AND source_path=${quote(row.source_path)};`);
      statements.push(`DELETE FROM source_roots WHERE source_path=${quote(row.source_path)} AND scan_root=${quote(root)};`);
      continue;
    }
    statements.push(`DELETE FROM source_roots WHERE source_path=${quote(row.source_path)} AND scan_root=${quote(root)};`);
    statements.push(`DELETE FROM ${row.table} WHERE id=${quote(row.id)} AND source_path=${quote(row.source_path)};`);
    if (row.table === "capabilities") {
      for (const table of ["capability_aliases", "capability_use_when", "capability_avoid_when", "capability_sources", "recipe_capabilities"]) {
        statements.push(`DELETE FROM ${table} WHERE capability_id=${quote(row.id)} AND NOT EXISTS (SELECT 1 FROM capabilities WHERE id=${quote(row.id)});`);
      }
      statements.push(`UPDATE fastpaths SET capability_id=NULL WHERE capability_id=${quote(row.id)} AND NOT EXISTS (SELECT 1 FROM capabilities WHERE id=${quote(row.id)});`);
    }
    if (row.table === "recipes") statements.push(`DELETE FROM recipe_capabilities WHERE recipe_id=${quote(row.id)} AND NOT EXISTS (SELECT 1 FROM recipes WHERE id=${quote(row.id)});`);
    if (row.table === "agents") statements.push(`DELETE FROM agent_projects WHERE agent_id=${quote(row.id)} AND NOT EXISTS (SELECT 1 FROM agents WHERE id=${quote(row.id)});`);
    if (row.table === "projects") {
      statements.push(`DELETE FROM agent_projects WHERE project_id=${quote(row.id)} AND NOT EXISTS (SELECT 1 FROM projects WHERE id=${quote(row.id)});`);
      statements.push(`DELETE FROM project_domains WHERE project_id=${quote(row.id)} AND NOT EXISTS (SELECT 1 FROM projects WHERE id=${quote(row.id)});`);
    }
  }
  statements.push("COMMIT;");
  sqlite(db, statements.join("\n"));
  return rows;
}
// Every source_path this walk wrote belongs to this folder.
function recordSourceRoots(db, root) {
  const paths = new Set();
  for (const table of [...sourceTables, "capability_sources"]) {
    for (const row of sqlite(db, `SELECT source_path FROM ${table} WHERE source_path IS NOT NULL AND source_path != '';`, true)) {
      if (!path.isAbsolute(row.source_path) && exists(path.join(root, row.source_path))) paths.add(row.source_path);
    }
  }
  if (!paths.size) return;
  const statements = ["BEGIN;", ...[...paths].map((source) => `INSERT OR IGNORE INTO source_roots(source_path,scan_root) VALUES (${quote(source)},${quote(root)});`), "COMMIT;"];
  sqlite(db, statements.join("\n"));
}
function index({ dir, workspace, dbPath }) {
  const db = dbPath || path.join(workspace, "myos-brain.db");
  migrate(db);
  const previousRoot = (sqlite(db, "SELECT value FROM organizer_meta WHERE key='scan_root';", true)[0] || {}).value ?? null;
  sqlite(
    db,
    `INSERT INTO organizer_meta(key,value) VALUES('scan_root',${
      quote(dir)
    }) ON CONFLICT(key) DO UPDATE SET value=excluded.value;`,
  );
  const files = walk(dir);
  structured(db, dir, files);
  inference(db, dir, files);
  recordSourceRoots(db, dir);
  const pruned = pruneStaleRows(db, dir, { previousRoot });
  const output = emitIndex(db, workspace, dir);
  proposeFastpaths(db);
  const taskClassConfig = readTaskClassConfig(workspace);
  return { db, capabilities: output.capabilities.length, staleRowsRemoved: pruned.length, taskClassConfig };
}
function audit({ workspace, dbPath }) {
  const db = dbPath || path.join(workspace, "myos-brain.db");
  migrate(db);
  const root = (sqlite(
    db,
    "SELECT value FROM organizer_meta WHERE key='scan_root';",
    true,
  )[0] || {}).value || workspace;
  const bad = [];
  for (
    const table of [
      "agents",
      "projects",
      "recipes",
      "skills",
      "workflows",
      "capabilities",
    ]
  ) {
    for (
      const row of sqlite(
        db,
        `SELECT id,source_path FROM ${table} WHERE source_path IS NOT NULL AND source_path != '';`,
        true,
      )
    ) {
      const p = path.join(root, row.source_path);
      if (!exists(p)) bad.push(`${table}:${row.id} dead source_path`);
    }
  }
  for (
    const x of sqlite(
      db,
      "SELECT capability_id FROM capability_aliases UNION SELECT capability_id FROM capability_use_when UNION SELECT capability_id FROM capability_avoid_when;",
      true,
    )
  ) {
    if (
      !sqlite(
        db,
        `SELECT id FROM capabilities WHERE id=${quote(x.capability_id)};`,
        true,
      ).length
    ) bad.push(`orphan capability:${x.capability_id}`);
  }
  const c = Object.fromEntries(
    sqlite(
      db,
      "SELECT status,COUNT(*) count FROM fastpaths WHERE status != 'retired' GROUP BY status;",
      true,
    ).map((x) => [x.status, +x.count]),
  );
  if (
    (c.probation || 0) > 10 || (c.stable || 0) > 20 ||
    ((c.probation || 0) + (c.stable || 0)) > 30
  ) bad.push("fastpath slot violation");
  return bad;
}
function add({ workspace, dbPath, type, row }) {
  const db = dbPath || path.join(workspace, "myos-brain.db");
  migrate(db);
  if (!["capability", "project", "agent"].includes(type)) {
    throw new Error("type must be capability, project, or agent");
  }
  const table = type === "capability" ? "capabilities" : `${type}s`;
  if (!row.id) throw new Error("row.id is required");
  upsert(db, table, row);
}
module.exports = { migrate, index, audit, add, proposeFastpaths, staleRows, pruneStaleRows };
