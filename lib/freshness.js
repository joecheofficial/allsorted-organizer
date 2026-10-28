"use strict";

// Graph freshness: when was the graph last updated, which notes are live and
// which are archival, and which old notes hold facts that change over time
// (age, city, role, prices). A customer's graph view looked "90% stale"
// because a months-old note said where they lived and how old they were;
// Dispatch answered correctly from dates, but the view gave no hint.
//
// Read-only by default. With `write`, it writes one generated view note,
// <brain>/FRESHNESS.md, with ordinary wikilinks so Obsidian shows it, plus the
// run record state/brain-freshness.json. It never edits a note, a vault or a
// source. Extra vaults passed with `vaults` are only read.

const fs = require("node:fs");
const path = require("node:path");
const brain = require("./brain");

const DAY_MS = 24 * 60 * 60 * 1000;
const VIEW_NOTE = "FRESHNESS.md";
const MAX_FILES = 50000;
const MAX_NOTE_BYTES = 512 * 1024;
const SKIP = new Set([".git", ".obsidian", ".trash", "node_modules", "atelier-output"]);

// Facts that go out of date. Each pattern names the kind a person would check.
const VOLATILE = [
  { kind: "age", re: /\b(?:I am|I'm|he is|she is|they are|aged?)\s+\d{2}\b|\bis\s+\d{2}(?=\s*(?:,|\.|and\b|years\b|$))|\b\d{2}\s*(?:years old|yo)\b|\bage:\s*\d{2}\b/i },
  { kind: "city", re: /\b(?:lives? in|living in|based in|moving to|moved to|relocat\w* to|home in|located in)\s+[A-Z][\w .'-]{2,}/ },
  { kind: "role", re: /\b(?:CEO|CTO|COO|CFO|founder|co-founder|head of|director|VP|manager|works at|working at|job title|role:|position:)\b/i },
  { kind: "price", re: /[$€£¥]\s?\d[\d,.]*|\b\d[\d,.]*\s?(?:USD|EUR|GBP|IDR|AUD)\b|\b(?:price|pricing|costs?|per month|\/mo|monthly fee|rate:)\b/i },
];
const ARCHIVE_PATH = /(?:^|\/)(?:_?archive[sd]?|old|attic|deprecated)(?:\/|$)/i;
const ARCHIVE_STATUS = /^(?:archived?|archival|inactive|deprecated|old|superseded)$/i;

function dateFromFront(front) {
  for (const key of ["updated", "last-updated", "last_updated", "modified", "lastmod", "date"]) {
    const v = front[key];
    if (typeof v === "string") { const t = Date.parse(v); if (Number.isFinite(t)) return t; }
  }
  return null;
}

// A generated brain note is rewritten on every build, so its own mtime says
// little. Its sources ("Where this came from") say when the fact was written.
function sourceTimes(body, roots) {
  const at = body.indexOf("\n## Where this came from\n");
  if (at < 0) return [];
  const times = [];
  for (const m of body.slice(at).matchAll(/^- `([^`]+)`$/gm)) {
    const candidates = path.isAbsolute(m[1]) ? [m[1]] : roots.map(r => path.join(r, m[1]));
    for (const c of candidates) { try { times.push(fs.statSync(c).mtimeMs); break; } catch { /* not on disk */ } }
  }
  return times;
}

function walk(dir, out, depth = 0) {
  if (depth > 12 || out.length >= MAX_FILES) return;
  let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (SKIP.has(e.name) || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out, depth + 1);
    else if (e.isFile() && /\.md$/i.test(e.name) && !/\.proposed\.md$/.test(e.name) && e.name !== VIEW_NOTE) out.push(p);
  }
}

function assess(file, base, options) {
  let st; try { st = fs.statSync(file); } catch { return null; }
  let raw = ""; try { raw = fs.readFileSync(file, "utf8").slice(0, MAX_NOTE_BYTES); } catch { return null; }
  const { yaml, body } = brain.splitFrontMatter(raw);
  const front = brain.parseFrontMatter(yaml);
  const kgStatus = (/^\s+status:\s*"?([\w-]+)"?/m.exec(yaml) || [])[1] || front.status || "";
  const fromSources = sourceTimes(body, options.sourceRoots);
  const updated = dateFromFront(front) ?? (fromSources.length ? Math.max(...fromSources) : st.mtimeMs);
  const rel = path.relative(base, file);
  const ageMonths = (options.now - updated) / (30.44 * DAY_MS);
  const archivalBy = ARCHIVE_STATUS.test(String(kgStatus)) ? "status" : ARCHIVE_PATH.test(rel.split(path.sep).join("/")) ? "folder" : ageMonths > options.months ? "age" : null;
  const facts = [];
  if (ageMonths > options.months) {
    const text = body.replace(/```[\s\S]*?```/g, "");
    for (const v of VOLATILE) if (v.re.test(text)) facts.push(v.kind);
  }
  return { path: rel, updated: new Date(updated).toISOString().slice(0, 10), ageMonths: Math.floor(ageMonths * 10) / 10, state: archivalBy ? "archival" : "live", archivalBy, facts };
}

function freshness(options = {}) {
  const root = path.resolve(options.root || brain.defaultRoot());
  const dir = brain.brainDir(root);
  const now = options.now || Date.now();
  const months = options.months == null ? 6 : Number(options.months);
  if (!Number.isFinite(months) || months <= 0) throw new Error("--months must be a positive number");
  const vaults = (options.vaults || []).map(v => path.resolve(v));
  const bases = [...(fs.existsSync(dir) ? [{ base: dir, label: "brain" }] : []), ...vaults.map(v => ({ base: v, label: path.basename(v) }))];
  if (!bases.length) throw new Error(`There is no brain at ${dir} and no --vault was given.`);
  const notes = [];
  for (const { base, label } of bases) {
    const files = []; walk(base, files);
    for (const f of files) {
      const a = assess(f, base, { now, months, sourceRoots: [root, base] });
      if (a) notes.push({ ...a, where: label, key: label === "brain" ? a.path.replace(/\.md$/i, "").split(path.sep).join("/") : null });
    }
  }
  const lastGraph = brain.readRunRecord(root, "brain-graph.json");
  const lastBuild = brain.readRunRecord(root, "brain-build.json");
  const newest = notes.reduce((m, n) => (n.updated > m ? n.updated : m), "");
  const stale = notes.filter(n => n.facts.length).sort((a, b) => a.updated.localeCompare(b.updated));
  const result = {
    ok: true, command: "freshness", root, brain: dir, months,
    lastUpdated: { graph: lastGraph ? lastGraph.at : null, build: lastBuild ? lastBuild.at : null, newestNote: newest || null },
    counts: { notes: notes.length, live: notes.filter(n => n.state === "live").length, archival: notes.filter(n => n.state === "archival").length, staleFacts: stale.length },
    stale: stale.map(({ path: p, where, updated, ageMonths, facts }) => ({ path: p, where, updated, ageMonths, facts })),
    archivalByReason: { status: notes.filter(n => n.archivalBy === "status").length, folder: notes.filter(n => n.archivalBy === "folder").length, age: notes.filter(n => n.archivalBy === "age").length },
    viewNote: null,
  };
  if (options.write && fs.existsSync(dir)) {
    result.viewNote = path.join(dir, VIEW_NOTE);
    fs.writeFileSync(result.viewNote, renderView(result, notes), { mode: 0o600 });
    result.stateFile = brain.writeRunRecord(root, "brain-freshness.json", { at: new Date(now).toISOString(), ...result, stale: result.stale.length });
  }
  return result;
}

function link(n) { return n.where === "brain" && n.key ? `[[${n.key}]]` : `\`${n.where}/${n.path}\``; }

function renderView(r, notes) {
  const lines = [
    "---",
    'title: "Graph freshness"',
    `updated: "${new Date().toISOString().slice(0, 10)}"`,
    "tags:",
    '  - "freshness"',
    "---",
    "",
    "# Graph freshness",
    "",
    `- Graph last built: ${r.lastUpdated.graph || "not yet"}`,
    `- Brain last built: ${r.lastUpdated.build || "not yet"}`,
    `- Newest note: ${r.lastUpdated.newestNote || "none"}`,
    `- Notes: ${r.counts.notes} (${r.counts.live} live, ${r.counts.archival} archival)`,
    "",
    `Archival means older than ${r.months} months, in an archive folder, or marked archived. Archival notes are history: Dispatch answers from the newest dated source first.`,
    "",
    `## Facts to check (older than ${r.months} months)`,
    "",
  ];
  const stale = notes.filter(n => n.facts.length).sort((a, b) => a.updated.localeCompare(b.updated));
  if (!stale.length) lines.push("Nothing found.");
  for (const n of stale.slice(0, 500)) lines.push(`- ${link(n)}: ${n.facts.join(", ")} (last updated ${n.updated})`);
  if (stale.length > 500) lines.push(`- and ${stale.length - 500} more in state/brain-freshness.json`);
  lines.push("", "## Archival notes", "");
  const archival = notes.filter(n => n.state === "archival").sort((a, b) => a.updated.localeCompare(b.updated));
  if (!archival.length) lines.push("None.");
  for (const n of archival.slice(0, 500)) lines.push(`- ${link(n)} (${n.archivalBy}, last updated ${n.updated})`);
  if (archival.length > 500) lines.push(`- and ${archival.length - 500} more`);
  return lines.join("\n") + "\n";
}

module.exports = { freshness, assess, VOLATILE, VIEW_NOTE };
