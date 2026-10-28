"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { freshness } = require("../lib/freshness");
const CLI = path.resolve(__dirname, "..", "bin", "brain.js");
const DAY = 86400000;

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "brain-fresh-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const b = path.join(root, "brain");
  for (const d of ["people", "projects", "sources", "archive"]) fs.mkdirSync(path.join(b, d), { recursive: true });
  const docs = path.join(root, "docs"); fs.mkdirSync(docs);
  const old = new Date(Date.now() - 300 * DAY);
  fs.writeFileSync(path.join(docs, "march.md"), "x"); fs.utimesSync(path.join(docs, "march.md"), old, old);
  const note = (rel, front, body) => fs.writeFileSync(path.join(b, rel), `---\n${front}\n---\n\n${body}\n`);
  // Generated note whose source is 10 months old: dated by its source, not its own mtime.
  note("people/alex.md", 'title: "Alex"\nkg:\n  status: "active"', "# Alex\n\nAlex is 30 and moving to San Francisco. Founder of a studio.\n\n## Where this came from\n\n- `docs/march.md`\n");
  note("projects/site.md", `title: "Site"\nupdated: "${new Date(Date.now() - 10 * DAY).toISOString().slice(0, 10)}"`, "# Site\n\nPrice is 4000 per month.");
  note("projects/old-plan.md", 'title: "Old plan"\nkg:\n  status: "archived"', "# Old plan");
  note("archive/2024.md", 'title: "2024"', "# 2024 notes");
  fs.writeFileSync(path.join(b, "people", "alex.proposed.md"), "ignored");
  fs.mkdirSync(path.join(root, "state"));
  fs.writeFileSync(path.join(root, "state", "brain-graph.json"), JSON.stringify({ at: "2026-10-20T10:00:00.000Z" }));
  return { root, b };
}

test("freshness marks live and archival notes and lists old notes with facts that change", (t) => {
  const { root, b } = setup(t);
  const before = fs.readFileSync(path.join(b, "people", "alex.md"), "utf8");
  const r = freshness({ root, months: 6 });
  assert.equal(r.lastUpdated.graph, "2026-10-20T10:00:00.000Z");
  assert.equal(r.counts.notes, 4, "proposed copies are not counted");
  assert.equal(r.counts.archival, 3);
  assert.deepEqual(r.archivalByReason, { status: 1, folder: 1, age: 1 });
  assert.equal(r.stale.length, 1);
  assert.equal(r.stale[0].path, path.join("people", "alex.md"));
  assert.deepEqual(r.stale[0].facts.sort(), ["age", "city", "role"]);
  assert.equal(r.viewNote, null, "read-only without --write");
  assert.ok(!fs.existsSync(path.join(b, "FRESHNESS.md")));
  assert.equal(fs.readFileSync(path.join(b, "people", "alex.md"), "utf8"), before);
});

test("--write adds one view note with wikilinks and a run record, and never edits notes", (t) => {
  const { root, b } = setup(t);
  const r = spawnSync(process.execPath, [CLI, "freshness", "--root", root, "--months", "6", "--write"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const view = fs.readFileSync(path.join(b, "FRESHNESS.md"), "utf8");
  assert.match(view, /^---\ntitle: "Graph freshness"\nupdated: "\d{4}-\d{2}-\d{2}"/);
  assert.match(view, /Graph last built: 2026-10-20T10:00:00.000Z/);
  assert.match(view, /- \[\[people\/alex\]\]: (?:age|city|role)/);
  assert.match(view, /\[\[projects\/old-plan\]\] \(status/);
  assert.ok(fs.existsSync(path.join(root, "state", "brain-freshness.json")));
  // A second run does not count its own view note.
  assert.equal(freshness({ root, months: 6 }).counts.notes, 4);
});

test("a customer's own vault is read, never written", (t) => {
  const { root } = setup(t);
  const vault = path.join(root, "MyVault"); fs.mkdirSync(vault);
  const f = path.join(vault, "me.md");
  fs.writeFileSync(f, "I am 30 and based in Lisbon.");
  const old = new Date(Date.now() - 400 * DAY); fs.utimesSync(f, old, old);
  const r = freshness({ root, months: 6, vaults: [vault], write: true });
  assert.ok(r.stale.some(s => s.where === "MyVault" && s.facts.includes("age") && s.facts.includes("city")));
  assert.deepEqual(fs.readdirSync(vault), ["me.md"]);
  assert.match(fs.readFileSync(path.join(root, "brain", "FRESHNESS.md"), "utf8"), /`MyVault\/me\.md`/);
  assert.throws(() => freshness({ root, months: 0 }), /positive/);
});
