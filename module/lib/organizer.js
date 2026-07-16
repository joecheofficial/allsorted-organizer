"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { sqlite, quote, migrate } = require("./db");
const ignored = new Set(["node_modules", ".git", "dist", "build", ".next"]);
const id = (prefix, value) =>
  `${prefix}:${
    String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(
      /(^-|-$)/g,
      "",
    )
  }`;
const exists = (p) => fs.existsSync(p);
function walk(root) {
  const out = [], visited = new Set();
  function go(dir) {
    const real = fs.realpathSync(dir);
    if (visited.has(real)) return;
    visited.add(real);
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (
        ent.name.startsWith(".") || ignored.has(ent.name) ||
        ent.isSymbolicLink()
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
  return path.relative(root, file).split(path.sep).join("/");
}
function upsert(db, table, row) {
  const keys = Object.keys(row);
  sqlite(
    db,
    `INSERT INTO ${table} (${keys.join(",")}) VALUES (${
      keys.map((k) => quote(row[k])).join(",")
    }) ON CONFLICT(${keys[0]}) DO UPDATE SET ${
      keys.slice(1).map((k) => `${k}=excluded.${k}`).join(",")
    };`,
  );
}
function cap(db, row, aliases = [], use = [], avoid = []) {
  upsert(db, "capabilities", row);
  for (
    const [table, values] of [["capability_aliases", aliases], [
      "capability_use_when",
      use,
    ], ["capability_avoid_when", avoid]]
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
      }, [x.title, ...(x.phrases || []), ...(x.tags || [])]);
    } else if (path.basename(file) === "SKILL.md") {
      const name = path.basename(path.dirname(file));
      const sid = id("skill", name);
      upsert(db, "skills", {
        id: sid,
        source_path: r,
        description: "Skill " + name,
        version: "1",
      });
      cap(db, {
        id: sid,
        type: "skill",
        execution_lane: "worker_skill",
        source_path: r,
        description: "Skill " + name,
        priority: 40,
        version: "1",
      }, [name]);
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
      }, [x.name]);
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
        }, a.tags || []);
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
      [pkg.name, ...commands, ...bins],
      commands,
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
  fs.writeFileSync(
    path.join(workspace, "capabilities-index.json"),
    JSON.stringify(output, null, 2) + "\n",
  );
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
function index({ dir, workspace, dbPath }) {
  const db = dbPath || path.join(workspace, "myos-brain.db");
  migrate(db);
  sqlite(
    db,
    `INSERT INTO organizer_meta(key,value) VALUES('scan_root',${
      quote(dir)
    }) ON CONFLICT(key) DO UPDATE SET value=excluded.value;`,
  );
  const files = walk(dir);
  structured(db, dir, files);
  inference(db, dir, files);
  const output = emitIndex(db, workspace, dir);
  proposeFastpaths(db);
  return { db, capabilities: output.capabilities.length };
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
module.exports = { migrate, index, audit, add, proposeFastpaths };
