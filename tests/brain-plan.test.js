"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const CLI = path.resolve(__dirname, "../bin/brain.js");
function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "brain-plan-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "install"), source = path.join(base, "docs");
  fs.mkdirSync(source);
  for (const name of ["a.md", "b.pdf", "c.txt"]) fs.writeFileSync(path.join(source, name), "Synthetic document, do not read during plan.");
  return { base, root, source };
}
function cli(f, ...flags) {
  return spawnSync(process.execPath, [CLI, "build", "--root", f.root, "--from", f.source, "--no-default", ...flags], { encoding: "utf8" });
}
test("build --plan inventories metadata, reports the cap, and creates no install/output", t => {
  const f = fixture(t);
  const run = cli(f, "--plan", "--max-files", "2", "--extract", "--ocr", "--remember");
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.plan, true);
  assert.equal(result.coverage.eligibleDocuments, 3);
  assert.equal(result.coverage.documentsPlanned, 2);
  assert.equal(result.coverage.documentsRead, 0);
  assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.inventoryComplete, true);
  assert.equal(result.coverage.capReached, true);
  assert.equal(result.skipped.overLimit, 1);
  assert.equal(fs.existsSync(f.root), false);
  assert.equal(run.stderr, "");
});
test("--dry-run resolves only the explicitly selected symlink root and excludes per path", t => {
  const f = fixture(t);
  const outside = path.join(f.base, "outside"); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "hidden.md"), "Outside approval");
  fs.symlinkSync(outside, path.join(f.source, "nested"), "dir");
  const chosen = path.join(f.base, "chosen"); fs.symlinkSync(f.source, chosen, "dir");
  f.source = chosen;
  const run = cli(f, "--dry-run", "--exclude", path.join(chosen, "b.pdf"), "--max-files", "10");
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.deepEqual(result.files.map(row => row.relative), ["a.md", "c.txt"]);
  assert.deepEqual(result.folders.map(row => row.path), [fs.realpathSync(chosen)]);
  assert.equal(result.skipped.symlinks, 1);
  assert.equal(result.coverage.capReached, false);
  assert.equal(result.coverage.complete, false, "An inventory cannot prove extraction coverage");
  assert.equal(fs.existsSync(f.root), false);
});
test("unknown flags and invalid explicit caps refuse before writes", t => {
  const f = fixture(t);
  for (const flags of [["--plna"], ["--max-files", "0"], ["--max-files", "9007199254740993"]]) {
    const run = cli(f, ...flags);
    assert.equal(run.status, 1);
    assert.equal(fs.existsSync(f.root), false);
  }
});
test("planning never opens source bodies, starts extraction, spawns tools or mutates the brain", async t => {
  const f = fixture(t);
  const childProcess = require("node:child_process");
  const originalSpawn = childProcess.spawnSync;
  childProcess.spawnSync = () => { throw new Error("External tool started during plan"); };
  delete require.cache[require.resolve("../lib/brain")];
  const brain = require("../lib/brain");
  const extraction = require("../lib/extraction");
  const originalRead = fs.readFileSync, originalSession = extraction.createSession;
  const originals = new Map();
  for (const name of ["writeFileSync", "mkdirSync", "renameSync", "copyFileSync", "unlinkSync"]) {
    originals.set(name, fs[name]); fs[name] = () => { throw new Error(`Forbidden mutation: ${name}`); };
  }
  fs.readFileSync = function(file, ...args) {
    if (String(file).startsWith(f.source)) throw new Error("Source body read during plan");
    return originalRead.call(this, file, ...args);
  };
  extraction.createSession = () => { throw new Error("Extraction started during plan"); };
  try {
    const result = await brain.build({ root: f.root, from: [f.source], includeDefault: false, plan: true, remember: true, extract: true, ocr: true });
    assert.equal(result.plan, true); assert.equal(result.coverage.documentsRead, 0);
  } finally {
    fs.readFileSync = originalRead; extraction.createSession = originalSession;
    childProcess.spawnSync = originalSpawn;
    delete require.cache[require.resolve("../lib/brain")];
    for (const [name, original] of originals) fs[name] = original;
  }
});

test("the default 2000-file cap is explicit and reports every omitted document", t => {
  const f = fixture(t);
  for (let i = 0; i < 1998; i++) fs.writeFileSync(path.join(f.source, `note-${i}.md`), "Synthetic");
  const run = cli(f, "--plan");
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.coverage.maxFiles, 2000);
  assert.equal(result.coverage.eligibleDocuments, 2001);
  assert.equal(result.coverage.documentsPlanned, 2000);
  assert.equal(result.skipped.overLimit, 1);
  assert.equal(fs.existsSync(f.root), false);
});
test("remembered config and existing brain output stay byte-for-byte unchanged", t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, "state"), { recursive: true });
  fs.mkdirSync(path.join(f.root, "brain"));
  const existing = {
    "brain/README.md": "Customer notes, preserve exactly.\n",
    "brain/.brain-state.json": "Existing state\n",
    "brain/.build-lock": "Existing active lock\n"
  };
  // Obtain the actual config filename without guessing the connector format.
  const configIO = require("../lib/connector-pull");
  configIO.writeConfig(f.root, { from: [f.source], build: { maxFiles: 1 } });
  for (const [name, contents] of Object.entries(existing)) {
    if (name.startsWith("brain/")) fs.writeFileSync(path.join(f.root, name), contents);
  }
  const snapshot = dir => fs.readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name)).flatMap(entry => entry.isDirectory() ? snapshot(path.join(dir, entry.name)) : [[path.relative(f.root, path.join(dir, entry.name)), fs.readFileSync(path.join(dir, entry.name), "hex")]]);
  const before = snapshot(f.root);
  const run = spawnSync(process.execPath, [CLI, "build", "--root", f.root, "--plan", "--remember"], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.coverage.maxFiles, 1);
  assert.equal(result.coverage.documentsPlanned, 1);
  assert.deepEqual(snapshot(f.root), before);
});
test("planning refuses brain and state roots even when selected through symlinks", t => {
  const f = fixture(t);
  for (const folder of ["brain", "state"]) {
    const dir = path.join(f.root, folder); fs.mkdirSync(dir, { recursive: true });
    const link = path.join(f.base, `selected-${folder}`); fs.symlinkSync(dir, link, "dir");
    const run = cli({ ...f, source: link }, "--plan");
    assert.equal(run.status, 1); assert.match(run.stderr, /is inside/);
  }
});
