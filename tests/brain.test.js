"use strict";

// Offline tests for the second brain. No network, temporary folders only.
// The graph step uses a stand-in `atelier` program placed on PATH.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const CLI = path.resolve(__dirname, "..", "bin", "brain.js");
const ORGANIZER_CLI = path.resolve(__dirname, "..", "bin", "organizer.js");
const brain = require("../lib/brain");
const MARKER = "MARKER-THAT-MUST-NEVER-BE-COPIED";
// Written in pieces so this test file never itself looks like it holds a key.
const DASHES = "-".repeat(5);
const GIT_DIR = path.dirname(["/usr/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git", "/bin/git"].find((file) => fs.existsSync(file)) || "/usr/bin/git");

function workspace(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "brain-test-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "install");
  const docs = path.join(base, "documents");
  const bin = path.join(base, "bin");
  fs.mkdirSync(root);
  fs.mkdirSync(bin);
  // Stand-ins for the installer and the opener, so no test can ever install
  // or launch the real viewer. Each one only records that it was called.
  script(path.join(bin, "fake-install"), `echo called >> "${path.join(base, "install.log")}"\nif [ -n "$FAKE_INSTALL_FAILS" ]; then echo "no network" >&2; exit 1; fi\n/bin/mkdir -p "$BRAIN_OBSIDIAN_APP"\n`);
  script(path.join(bin, "fake-open"), `echo "$@" >> "${path.join(base, "open.log")}"\ncase "$1" in obsidian:*) if [ -n "$FAKE_URI_FAILS" ]; then exit 1; fi ;; esac\n`);
  // Stands in for "is the viewer running": no, unless a test says so.
  script(path.join(bin, "fake-pgrep"), `if [ -n "$FAKE_VIEWER_RUNNING" ]; then echo 4242; exit 0; fi\nexit 1\n`);
  const write = (relative, text) => {
    const file = path.join(docs, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  write("acme-launch/README.md", "---\ntitle: Acme launch\ntags: [launch]\nowner: Dana Lee\nclient: Acme Co\n---\n# Acme launch\n\nThe plan to launch the Acme line.\n\n## Timeline\n\nSee [[checklist]] and [pricing](pricing.md).\n");
  write("acme-launch/checklist.md", "# Launch checklist\n\nAttendees: Sam Ortiz, Dana Lee\n\nEverything that must be true before launch day.\n");
  write("acme-launch/pricing.md", "# Pricing\n\nThree tiers.\n");
  write("people/dana-lee.md", "# Dana Lee\n\nProject lead. Works with [[Acme Co]].\n");
  write("clients/acme-co.md", "# Acme Co\n\nA client.\n");
  write("loose-note.txt", "Loose note\n\nA note that sits in no project.\n");
  return { base, root, docs, bin, write, dir: path.join(root, "brain") };
}

function script(file, body) {
  fs.writeFileSync(file, `#!/bin/sh\n${body}`);
  fs.chmodSync(file, 0o755);
  return file;
}

function env(f, extra = {}) {
  // A bare PATH: this Node, git, and the stand-in tools folder. Nothing else.
  return { HOME: f.base, PATH: [f.bin, path.dirname(process.execPath), GIT_DIR, "/usr/bin", "/bin"].join(path.delimiter), MYOS_DISPATCH_HOME: f.root, BRAIN_OBSIDIAN_APP: "", BRAIN_OBSIDIAN_CONFIG: path.join(f.base, "viewer-vaults.json"), BRAIN_INSTALL_CMD: path.join(f.bin, "fake-install"), BRAIN_OPEN_CMD: path.join(f.bin, "fake-open"), BRAIN_PGREP_CMD: path.join(f.bin, "fake-pgrep"), ...extra };
}

function cli(f, args, extra = {}, input) {
  const child = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: env(f, extra), cwd: f.base, timeout: 60000, input });
  let json = null;
  try { json = JSON.parse(child.stdout); } catch { /* left null for the assertion to report */ }
  return { ...child, json };
}

// Atelier is only ever used from inside the install, so the stand-in goes there.
function fakeAtelier(f, where = path.join(f.root, ".external", "atelier", "node_modules", ".bin")) {
  fs.mkdirSync(where, { recursive: true });
  const file = path.join(where, "atelier");
  fs.writeFileSync(file, [
    "#!/bin/sh",
    'case "$1" in',
    "  --help) echo usage ;;",
    "  adopt) echo '{}' > atelier.project.json; echo 'atelier-output/' >> .gitignore; echo adopted ;;",
    "  graph)",
    "    mkdir -p atelier-output",
    "    nodes=$(find . -name '*.md' -not -path './.git/*' -not -name '*.proposed.md' | wc -l | tr -d ' ')",
    "    edges=$(grep -rhE '^      - \"brain:' --include='*.md' . | wc -l | tr -d ' ')",
    `    "${process.execPath}" -e 'require("fs").writeFileSync("atelier-output/knowledge.graph.json",JSON.stringify({nodes:Array(Number(process.argv[1])).fill({}),edges:Array(Number(process.argv[2])).fill({}),diagnostics:[]}))' "$nodes" "$edges"`,
    '    echo "knowledge graph: $nodes nodes · $edges edges · 0 diagnostics" ;;',
    "  *) echo unknown >&2; exit 2 ;;",
    "esac",
    "",
  ].join("\n"));
  fs.chmodSync(file, 0o755);
  return file;
}

function notes(dir) {
  const out = [];
  for (const folder of Object.values(brain.TYPE_DIRS)) {
    const full = path.join(dir, folder);
    if (!fs.existsSync(full)) continue;
    for (const name of fs.readdirSync(full)) if (name.endsWith(".md")) out.push(path.join(folder, name));
  }
  return out.sort();
}

function everyFile(dir) {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.parentPath.includes(`${path.sep}.git`))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

function snapshot(dir) {
  return Object.fromEntries([...notes(dir), brain.STATE_FILE].map((relative) => [relative, fs.readFileSync(path.join(dir, relative), "utf8")]));
}

test("init creates a plain git folder and is safe to run twice", (t) => {
  const f = workspace(t);
  const first = cli(f, ["init", "--root", f.root]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.json.git, "created");
  assert.equal(first.json.atelier, "missing");
  assert.ok(fs.existsSync(path.join(f.dir, ".git")));
  assert.ok(fs.existsSync(path.join(f.dir, "README.md")));
  assert.match(fs.readFileSync(path.join(f.dir, ".gitignore"), "utf8"), /^\*\.proposed\.md$/m);
  assert.equal(fs.existsSync(path.join(f.dir, ".obsidian")), false, "viewer settings are written only when asked for");
  fs.appendFileSync(path.join(f.dir, "README.md"), "\nMy own line.\n");
  const second = cli(f, ["init", "--root", f.root]);
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(second.json.created, []);
  assert.match(fs.readFileSync(path.join(f.dir, "README.md"), "utf8"), /My own line\./);
});

test("init adopts the folder with Atelier when Atelier is present", (t) => {
  const f = workspace(t);
  fakeAtelier(f);
  const result = cli(f, ["init", "--root", f.root]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.atelier, "adopted");
  assert.ok(fs.existsSync(path.join(f.dir, "atelier.project.json")));
  assert.match(fs.readFileSync(path.join(f.dir, ".gitignore"), "utf8"), /^\*\.proposed\.md$/m);
});

test("build writes one note per thing, with valid front matter and real links", (t) => {
  const f = workspace(t);
  const built = cli(f, ["build", "--root", f.root, "--from", f.docs, "--pace-ms", "0"]);
  assert.equal(built.status, 0, built.stderr);
  assert.equal(built.json.written, built.json.notes);
  assert.match(built.stderr, /^\+ projects\/acme-launch\.md$/m, "one progress line per note");
  const written = notes(f.dir);
  for (const expected of ["projects/acme-launch.md", "people/dana-lee.md", "people/sam-ortiz.md", "companies/acme-co.md", "topics/launch.md", "topics/documents.md", "sources/documents-acme-launch-readme.md", "sources/documents-loose-note.md"]) {
    assert.ok(written.includes(expected), `missing ${expected}`);
  }
  const ids = new Set();
  for (const relative of [...written, "README.md"]) {
    const text = fs.readFileSync(path.join(f.dir, relative), "utf8");
    const front = brain.splitFrontMatter(text).yaml;
    assert.match(front, /^kg:\n {2}id: "brain:[a-z0-9-]+"$/m, `${relative}: kg.id`);
    assert.match(front, /^ {2}audience: "private"$/m, `${relative}: kg.audience`);
    assert.match(front, /^title: ".+"$/m, `${relative}: title`);
    const id = front.match(/^ {2}id: "(.+)"$/m)[1];
    assert.ok(!ids.has(id), `${relative}: duplicate id ${id}`);
    ids.add(id);
  }
  // Every declared relation and every wikilink points at a note that exists.
  let links = 0;
  for (const relative of written) {
    const text = fs.readFileSync(path.join(f.dir, relative), "utf8");
    for (const match of text.matchAll(/^ {6}- "(brain:[^"]+)"$/gm)) assert.ok(ids.has(match[1]), `${relative}: relation to missing ${match[1]}`);
    for (const match of text.matchAll(/\[\[([^\]|]+)\|[^\]]*\]\]/g)) {
      links += 1;
      assert.ok(fs.existsSync(path.join(f.dir, `${match[1]}.md`)), `${relative}: wikilink to missing ${match[1]}`);
    }
  }
  assert.ok(links > 10);
  const project = fs.readFileSync(path.join(f.dir, "projects", "acme-launch.md"), "utf8");
  assert.match(project, /\[\[people\/dana-lee\|Dana Lee\]\]/);
  assert.match(project, /\[\[companies\/acme-co\|Acme Co\]\]/);
  const readme = fs.readFileSync(path.join(f.dir, "sources", "documents-acme-launch-readme.md"), "utf8");
  assert.match(readme, /\[\[sources\/documents-acme-launch-checklist\|/, "an existing wikilink becomes a relation");
  assert.match(readme, /\[\[sources\/documents-acme-launch-pricing\|/, "an existing markdown link becomes a relation");
  assert.match(readme, /supports:\n {6}- "brain:projects-acme-launch"/);
  assert.match(fs.readFileSync(path.join(f.dir, "people", "dana-lee.md"), "utf8"), /\[\[companies\/acme-co\|Acme Co\]\]/);
});

test("a rebuild that changes nothing changes no file", (t) => {
  const f = workspace(t);
  assert.equal(cli(f, ["build", "--root", f.root, "--from", f.docs, "--pace-ms", "0"]).status, 0);
  const before = snapshot(f.dir);
  const again = cli(f, ["build", "--root", f.root, "--from", f.docs, "--pace-ms", "0"]);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.json.written, 0);
  assert.equal(again.json.updated, 0);
  assert.equal(again.json.unchanged, again.json.notes);
  assert.deepEqual(snapshot(f.dir), before);
  assert.equal(again.stderr, "", "no note was written, so no progress line");
});

test("a note a person edited is never overwritten", (t) => {
  const f = workspace(t);
  assert.equal(cli(f, ["build", "--root", f.root, "--from", f.docs, "--pace-ms", "0"]).status, 0);
  const file = path.join(f.dir, "projects", "acme-launch.md");
  const edited = `${fs.readFileSync(file, "utf8")}\nMy private thoughts on this launch.\n`;
  fs.writeFileSync(file, edited);
  // Nothing new to say: the edited note stays and no proposal appears.
  const quiet = cli(f, ["build", "--root", f.root, "--from", f.docs, "--pace-ms", "0"]);
  assert.equal(quiet.json.protected, 1);
  assert.equal(fs.readFileSync(file, "utf8"), edited);
  assert.equal(fs.existsSync(path.join(f.dir, "projects", "acme-launch.proposed.md")), false);
  // Something new: the note still stays, and the new version lands beside it.
  f.write("acme-launch/budget.md", "# Budget\n\nOwner: Dana Lee\n\nThe numbers.\n");
  const changed = cli(f, ["build", "--root", f.root, "--from", f.docs, "--pace-ms", "0"]);
  assert.equal(changed.status, 0, changed.stderr);
  assert.deepEqual(changed.json.protectedNotes, ["projects/acme-launch.md"]);
  assert.equal(fs.readFileSync(file, "utf8"), edited);
  const proposed = fs.readFileSync(path.join(f.dir, "projects", "acme-launch.proposed.md"), "utf8");
  assert.match(proposed, /documents-acme-launch-budget/);
  assert.doesNotMatch(proposed, /My private thoughts/);
  // A note that was there before the brain was built is protected the same way.
  const stray = path.join(f.dir, "people", "sam-ortiz.md");
  fs.writeFileSync(stray, "# Sam\n\nWritten by hand.\n");
  fs.writeFileSync(path.join(f.dir, brain.STATE_FILE), JSON.stringify({ version: 1, notes: {} }));
  assert.equal(cli(f, ["build", "--root", f.root, "--from", f.docs, "--pace-ms", "0"]).status, 0);
  assert.equal(fs.readFileSync(stray, "utf8"), "# Sam\n\nWritten by hand.\n");
  assert.equal(fs.readFileSync(file, "utf8"), edited);
});

test("a rebuild tidies away its own orphan notes, never edited ones, and never from a folder it did not read in full", (t) => {
  const f = workspace(t);
  const other = path.join(f.base, "other");
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, "side-note.md"), "# Side note\n\nKept in a second folder.\n");
  const build = (...from) => cli(f, ["build", "--root", f.root, ...from.flatMap((folder) => ["--from", folder]), "--pace-ms", "0"]);
  assert.equal(build(f.docs, other).status, 0);
  const pricing = path.join(f.dir, "sources", "documents-acme-launch-pricing.md");
  const loose = path.join(f.dir, "sources", "documents-loose-note.md");
  const side = path.join(f.dir, "sources", "other-side-note.md");
  for (const file of [pricing, loose, side]) assert.ok(fs.existsSync(file), file);
  // A folder left off this time, or one that cannot be found, costs no note.
  assert.equal(build(f.docs).json.removed, 0);
  assert.equal(build(f.docs, path.join(f.base, "unplugged-drive")).json.removed, 0);
  assert.ok(fs.existsSync(side));
  // A document that is gone takes its unedited note with it; an edited one stays.
  fs.rmSync(path.join(f.docs, "acme-launch", "pricing.md"));
  fs.rmSync(path.join(f.docs, "loose-note.txt"));
  fs.appendFileSync(loose, "\nMy own words.\n");
  const tidy = build(f.docs, other);
  assert.equal(tidy.status, 0, tidy.stderr);
  assert.deepEqual(tidy.json.removedNotes, ["sources/documents-acme-launch-pricing.md"]);
  assert.deepEqual(tidy.json.orphansKept, ["sources/documents-loose-note.md"]);
  assert.equal(fs.existsSync(pricing), false);
  assert.match(fs.readFileSync(loose, "utf8"), /My own words/);
  assert.ok(fs.existsSync(side));
  assert.equal(cli(f, ["graph", "--root", f.root]).json.brokenWikilinks, 0);
});

test("a folder that cannot be listed never loses its notes", (t) => {
  if (process.getuid && process.getuid() === 0) return t.skip("permissions do not apply to root");
  const f = workspace(t);
  f.write("vault/a.md", "# A\n\nOne.\n");
  f.write("vault/b.md", "# B\n\nTwo.\n");
  const run = () => cli(f, ["build", "--root", f.root, "--from", f.docs, "--pace-ms", "0"]);
  assert.equal(run().status, 0);
  const before = fs.readdirSync(path.join(f.dir, "sources")).length;
  const locked = path.join(f.docs, "vault");
  fs.chmodSync(locked, 0o000);
  let blocked;
  try { blocked = run(); } finally { fs.chmodSync(locked, 0o755); }
  assert.equal(blocked.status, 0, blocked.stderr);
  assert.equal(blocked.json.removed, 0);
  assert.equal(fs.readdirSync(path.join(f.dir, "sources")).length, before);
});

test("notes from an older brain, and notes another note still links to, are never tidied away", (t) => {
  const f = workspace(t);
  const run = () => cli(f, ["build", "--root", f.root, "--from", f.docs, "--pace-ms", "0"]);
  assert.equal(run().status, 0);
  const stateFile = path.join(f.dir, brain.STATE_FILE);
  // An older brain recorded no folders for its notes.
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  for (const record of Object.values(state.notes)) delete record.roots;
  fs.writeFileSync(stateFile, JSON.stringify(state));
  fs.rmSync(path.join(f.docs, "acme-launch", "pricing.md"));
  assert.equal(run().json.removed, 0);
  assert.ok(fs.existsSync(path.join(f.dir, "sources", "documents-acme-launch-pricing.md")));
  // In a current brain, a note an `add` note links to stays.
  f.write("acme-launch/pricing.md", "# Pricing\n\nThree tiers.\n");
  assert.equal(run().status, 0);
  const items = [{ type: "project", title: "Pricing review", summary: "Looks at the tiers.", relations: [{ type: "related", target: "sources/documents-acme-launch-pricing" }] }];
  assert.equal(cli(f, ["add", "--root", f.root, "--json", "-"], {}, JSON.stringify(items)).status, 0);
  fs.rmSync(path.join(f.docs, "acme-launch", "pricing.md"));
  const kept = run();
  assert.equal(kept.json.removed, 0);
  assert.ok(kept.json.orphansKept.includes("sources/documents-acme-launch-pricing.md"));
  assert.equal(cli(f, ["graph", "--root", f.root]).json.brokenWikilinks, 0);
});

test("tidy keeps a note linked from any note it will not rewrite, by any link form, through chains", (t) => {
  const f = workspace(t);
  f.write("meetings/kickoff.md", "---\nattendees: Zed Quill\n---\n# Kickoff\n\nThe first meeting.\n");
  f.write("meetings/retro.md", "---\nattendees: Ola Brent\n---\n# Retro\n\nLooking back.\n");
  // Ida's only meeting sits in a folder of its own, so no kept note chains to her.
  f.write("calls/review.md", "---\nattendees: Ida Moss\n---\n# Review\n\nA check-in.\n");
  const run = () => cli(f, ["build", "--root", f.root, "--from", f.docs, "--pace-ms", "0"]);
  assert.equal(run().status, 0);
  const people = (name) => path.join(f.dir, "people", `${name}.md`);
  for (const name of ["zed-quill", "ola-brent", "ida-moss"]) assert.ok(fs.existsSync(people(name)), name);
  // A hand edit links to Zed by the short Obsidian form, the README links to Ola by title.
  const edited = path.join(f.dir, "sources", "documents-acme-launch-pricing.md");
  fs.appendFileSync(edited, "\nAsk [[zed-quill]] about this.\n");
  fs.appendFileSync(path.join(f.dir, "README.md"), "\nSee [[Ola Brent]].\n");
  // Zed's note links to the kickoff source, so the kickoff stays while Zed stays.
  for (const meeting of ["kickoff", "retro"]) fs.rmSync(path.join(f.docs, "meetings", `${meeting}.md`));
  fs.rmSync(path.join(f.docs, "calls", "review.md"));
  const tidy = run();
  assert.equal(tidy.status, 0, tidy.stderr);
  assert.ok(fs.existsSync(people("zed-quill")), "short-form link from an edited note");
  assert.ok(fs.existsSync(people("ola-brent")), "title link from the README");
  assert.ok(fs.existsSync(path.join(f.dir, "sources", "documents-meetings-kickoff.md")), "linked from a kept note");
  assert.equal(fs.existsSync(people("ida-moss")), false, "nothing links to Ida, so her note goes");
  assert.equal(cli(f, ["graph", "--root", f.root]).json.brokenWikilinks, 0);
});

test("plain markdown links protect notes too, and an unreadable note stops the tidy", (t) => {
  if (process.getuid && process.getuid() === 0) return t.skip("permissions do not apply to root");
  const f = workspace(t);
  f.write("calls/review.md", "---\nattendees: Ida Moss\n---\n# Review\n\nA check-in.\n");
  f.write("calls/sync.md", "---\nattendees: Max Ruiz\n---\n# Sync\n\nA call.\n");
  const run = () => cli(f, ["build", "--root", f.root, "--from", f.docs, "--pace-ms", "0"]);
  assert.equal(run().status, 0);
  const edited = path.join(f.dir, "sources", "documents-acme-launch-pricing.md");
  fs.appendFileSync(edited, "\nAsk [Ida](../people/ida-moss.md) about this.\n");
  fs.rmSync(path.join(f.docs, "calls", "review.md"));
  const kept = run();
  assert.equal(kept.status, 0, kept.stderr);
  assert.ok(fs.existsSync(path.join(f.dir, "people", "ida-moss.md")), "a markdown link keeps the note");
  // An unreadable note might link to anything, so nothing is tidied and nothing crashes.
  fs.rmSync(path.join(f.docs, "calls", "sync.md"));
  const blocker = path.join(f.dir, "topics", "private.md");
  fs.writeFileSync(blocker, "# Private\n");
  fs.chmodSync(blocker, 0o000);
  let blocked;
  try { blocked = run(); } finally { fs.chmodSync(blocker, 0o644); }
  assert.equal(blocked.status, 0, blocked.stderr);
  assert.equal(blocked.json.removed, 0);
  assert.match(blocked.json.tidy, /could not be read/);
  assert.ok(fs.existsSync(path.join(f.dir, "people", "max-ruiz.md")));
});

test("a garbled lock is taken over, and a long encoded line is removed quickly", (t) => {
  const f = workspace(t);
  assert.equal(cli(f, ["init", "--root", f.root]).status, 0);
  fs.writeFileSync(path.join(f.dir, ".brain.lock"), "");
  assert.equal(cli(f, ["build", "--root", f.root, "--from", f.docs, "--pace-ms", "0"]).status, 0);
  const blob = "QUJD".repeat(250000);
  const started = Date.now();
  const out = brain.copyContent(`# Image\n\nBefore.\n${blob}\na.${"a.".repeat(20000)}\nAfter.\n`, () => null, 10_000_000, "x");
  assert.ok(Date.now() - started < 3000, `filter took ${Date.now() - started} ms`);
  assert.ok(!out.includes(blob.slice(0, 64)));
  assert.match(out, /Before\./);
  assert.match(out, /After\./);
});

test("one build at a time: a live lock is refused, a stale one is taken over", (t) => {
  const f = workspace(t);
  assert.equal(cli(f, ["init", "--root", f.root]).status, 0);
  const lock = path.join(f.dir, ".brain.lock");
  fs.writeFileSync(lock, String(process.pid === 1 ? 2 : process.ppid));
  const refused = cli(f, ["build", "--root", f.root, "--from", f.docs, "--pace-ms", "0"]);
  assert.notEqual(refused.status, 0);
  assert.match(`${refused.stdout}${refused.stderr}`, /Another brain build is running/);
  fs.writeFileSync(lock, "999999");
  const taken = cli(f, ["build", "--root", f.root, "--from", f.docs, "--pace-ms", "0"]);
  assert.equal(taken.status, 0, taken.stderr);
  assert.equal(fs.existsSync(lock), false);
});

test("ordinary lines that mention secrets are kept, and the remaining key shapes are removed", () => {
  const hex = "0123456789abcdef".repeat(2);
  const keep = ["Secretary: Margaret Smith", "Tokenomics: deflationary supply", "passwordless: enabled across all apps", "design tokens = colors and spacing", "Our secret: everything is relationships", "The secret = consistency over intensity", "Credentials: provided by HR on day one", "max_tokens: 100000", "client = Anthropic(api_key=os.environ['KEY'])", "def call(api_key=None):", "Password: ask Sam", "token: see the docs", "Key: the launch is on 14 October", "-H \"apikey: $SUPABASE_SERVICE_KEY\"", "header apikey: ${EVOLUTION_API_KEY}", "RESEND_API_KEY=<your key here>", "token: {{ secrets.GH_TOKEN }}", "api_key=process.env.OPENAI_API_KEY", "apikey = EVOLUTION_API_KEY", "- [incident] key=user-1234:a2ee5f9c0d sources=mac", "Local keys: see the vault", "SELECT value FROM settings WHERE key='target-2026-q4'", "PIN: Bali office", "Pass: the deal to Sam", "User / admin guide", "Key results: 3 new clients", "Token gating: members only", "Login / signup page redesign", "Password protected: yes", "Wifi password is on the fridge", "password reset link: https://example.com/reset", "Password policy applies to all staff", "Password: required", "Login: use the staff portal / single sign-on", "user flow / onboarding2026", "Login with Google / Apple2026", "Wifi: available in all rooms", "Pass rate: 92%", "Passport: renew 2026-11", "PIN code is printed on the card", "Pass the 2026 budget"];
  const tail = "Q7wX2mN9pL4kR8tV1yB6cZ3h";
  const remove = [`export OPENAI_KEY=${tail}`, `machine api.example.com login sam password ${tail}`, `Authorization: Basic ${Buffer.from("sam:" + tail).toString("base64")}`, `xoxe-1-${tail}`, `| password | Hunter2xyz99 |`, `VERCEL_TOKEN="vcp_${tail}"`, `apikey: ${tail}`, `OPENAI_KEY=${tail}`, `BOT=1234567890:AA${tail}${tail}`, "**Password:** Hunter2xyz99", "Password Hunter2xyz99", "wifi password is Bali2026guest", "Login: sam.ortiz / Hunter2xyz99", `"key": "${tail}"`, "password: %Tr0ub4dor&3", "password=$Hunter2xyz99", "password: hunter2", "password=correcthorsebatterystaple", "DB_PASS=Hunter2xyz99", "pw: Hunter2xy", "pin: 482913", `API key: ${hex}`, `Mailchimp API key: ${hex}-us21`, "PIN 4829", "Gate code: 4829", "Alarm code 4829", "pass is Hunter2xyz99", "PW - Hunter2xyz99", "Password \u2014 Hunter2xyz99", `API Key - ${hex.slice(0, 20)}`, "Wifi: BaliVilla2026", "Wi-Fi: Villa Guest / Bali2026guest", "Gmail: sam.acme / Hunter2xyz99", "Instagram: acmebali / Hunter2xyz99", "PIN: 4829", "Bank PIN: 4829"];
  const out = brain.copyContent(`# T\n\n${[...keep, ...remove].join("\n")}\n`, () => null, 100000, "x");
  for (const line of keep) assert.ok(out.includes(line), `wrongly removed: ${line}`);
  for (const line of remove) assert.ok(!out.includes(line), `not removed: ${line}`);
  const putty = brain.copyContent(`# K\n\nPuTTY-User-Key-File-3: ssh-ed25519\nPrivate-Lines: 1\n${tail}\nPrivate-MAC: ${tail}\nafter\n`, () => null, 100000, "x");
  assert.ok(!putty.includes(tail));
  assert.match(putty, /after/);
});

test("folders are skipped only when their whole name says they hold logins or keys", (t) => {
  const f = workspace(t);
  for (const folder of ["Secret Santa 2025", "Wallet App Redesign", "2FA Rollout", "Secretary Notes"]) f.write(`${folder}/notes.md`, `# ${folder}\n\nOrdinary notes.\n`);
  for (const folder of ["Passwords", "recovery codes", "API Keys", ".ssh"]) f.write(`${folder}/notes.md`, `# Hidden\n\n${MARKER}\n`);
  const run = cli(f, ["build", "--root", f.root, "--from", f.docs, "--pace-ms", "0"]);
  assert.equal(run.status, 0, run.stderr);
  const names = fs.readdirSync(path.join(f.dir, "sources")).join(" ");
  for (const slug of ["secret-santa-2025", "wallet-app-redesign", "2fa-rollout", "secretary-notes"]) assert.match(names, new RegExp(slug));
  const all = fs.readdirSync(path.join(f.dir, "sources")).map((name) => fs.readFileSync(path.join(f.dir, "sources", name), "utf8")).join("\n");
  assert.ok(!all.includes(MARKER));
});

test("real key formats, secret fields, secret links and key blocks never reach a note", (t) => {
  const f = workspace(t);
  // Each value is assembled at run time so this file never holds a real-looking key.
  const tail = "Q7wX2mN9pL4kR8tV1yB6cZ3h";
  const sk = ["s", "k"].join("");
  const lines = [
    `ANTHROPIC_API_KEY=${sk}-ant-api03-${tail}`,
    `OPENAI=${sk}-proj-abc_def-${tail}`,
    `{"password": "hunter2hunter2"}`,
    `"api_key": "${tail}"`,
    `DB_PASSWORD=${tail}`,
    `client_secret: ${tail}`,
    `https://api.example.com/v1?access_token=${tail}`,
    `https://maps.example.com/js?key=AIza${tail}${tail}`,
    `aws_secret_access_key = ${tail}`,
    `github_pat_${tail}${tail}`,
    `Authorization: Bearer ${tail}${tail}`,
    `postgres://admin:${tail}@db.example.com/app`,
  ];
  const block = [`${DASHES}BEGIN PGP PRIVATE KEY BLOCK${DASHES}`, tail, tail, `${DASHES}END PGP PRIVATE KEY BLOCK${DASHES}`];
  f.write("acme-launch/setup-notes.md", `# Setup notes\n\nKeep this line.\n\n${lines.join("\n")}\n\n${block.join("\n")}\n\nAnd this one.\n`);
  f.write("Passwords/bank.md", `# Bank\n\n${MARKER}\n`);
  f.write("recovery codes/github.md", `# Codes\n\n${MARKER}\n`);
  const run = cli(f, ["build", "--root", f.root, "--from", f.docs, "--pace-ms", "0"]);
  assert.equal(run.status, 0, run.stderr);
  const all = [];
  const walk = (dir) => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name); if (entry.name === ".git") continue; if (entry.isDirectory()) walk(full); else all.push(fs.readFileSync(full, "utf8")); } };
  walk(f.dir);
  const text = all.join("\n");
  assert.ok(!text.includes(tail), "a secret value reached the brain");
  assert.ok(!text.includes(MARKER), "a file inside a secret-named folder was read");
  const note = fs.readFileSync(path.join(f.dir, "sources", "documents-acme-launch-setup-notes.md"), "utf8");
  assert.match(note, /Keep this line\./);
  assert.match(note, /And this one\./);
  assert.ok(run.json.skipped.secrets >= 2);
});

test("scripts with combining marks keep distinct names", () => {
  assert.notEqual(brain.slugify("दीपा"), brain.slugify("दीपु"));
  assert.notEqual(brain.slugify("สมชาย"), brain.slugify("สมชัย"));
  assert.equal(brain.slugify("दीपा"), brain.slugify("दीपा"));
});

test("a rebuild refreshes the document text of a note the assistant enriched, and keeps the assistant's words", (t) => {
  const f = workspace(t);
  f.write("plan.md", "# Plan\n\nVersion one of the plan.\n\n## Where this came from\n\nA heading inside the document itself.\n");
  assert.equal(cli(f, ["build", "--root", f.root, "--from", f.docs, "--pace-ms", "0"]).status, 0);
  const file = path.join(f.dir, "sources", "documents-plan.md");
  const items = [{ type: "source", note: "sources/documents-plan", title: "Plan", summary: "The assistant's summary.", body: "What the assistant understood.\n\n## Content\n\nnot a real section", relations: [{ type: "related", target: "Dana Lee" }] }];
  const added = cli(f, ["add", "--root", f.root, "--json", "-"], {}, JSON.stringify(items));
  assert.equal(added.status, 0, added.stderr);
  let note = fs.readFileSync(file, "utf8");
  assert.match(note, /Version one of the plan/, "add kept the copied document text even with a look-alike heading inside it");
  assert.match(note, /### Content/);
  f.write("plan.md", "# Plan\n\nVersion two of the plan.\n");
  const rebuilt = cli(f, ["build", "--root", f.root, "--from", f.docs, "--pace-ms", "0"]);
  assert.equal(rebuilt.status, 0, rebuilt.stderr);
  note = fs.readFileSync(file, "utf8");
  assert.match(note, /Version two of the plan/);
  assert.doesNotMatch(note, /Version one of the plan/);
  assert.match(note, /The assistant's summary\./);
  assert.match(note, /What the assistant understood\./);
  assert.match(note, /\[\[people\/dana-lee\|/);
});

test("a cut keeps the fence that was open and names a small cap honestly", (t) => {
  const f = workspace(t);
  f.write("long.md", `# Long\n\n~~~\n${"line of code\n".repeat(80)}~~~\n`);
  assert.equal(cli(f, ["build", "--root", f.root, "--from", f.docs, "--pace-ms", "0", "--max-note-bytes", "300"]).status, 0);
  const note = fs.readFileSync(path.join(f.dir, "sources", "documents-long.md"), "utf8");
  assert.match(note, /first 300 bytes/);
  const content = note.slice(note.indexOf("## Content"));
  assert.equal((content.match(/^~~~/gm) || []).length % 2, 0, "the cut left a code block open");
});

test("key files, .env files and secret lines are never copied into the brain", (t) => {
  const f = workspace(t);
  f.write(".env", `API_KEY=${MARKER}\n`);
  f.write("acme-launch/.env.local", `${MARKER}\n`);
  f.write("acme-launch/prod.env", `${MARKER}\n`);
  f.write("acme-launch/id_rsa", `${MARKER}\n`);
  f.write("acme-launch/server.pem", `${MARKER}\n`);
  f.write("acme-launch/passwords.md", `# Logins\n\n${MARKER}\n`);
  f.write("acme-launch/api-token.txt", `${MARKER}\n`);
  f.write("acme-launch/node_modules/pkg/README.md", `# Pkg\n\n${MARKER}\n`);
  f.write("acme-launch/.git/description.md", `# Git\n\n${MARKER}\n`);
  f.write("acme-launch/.hidden/notes.md", `# Hidden\n\n${MARKER}\n`);
  f.write("acme-launch/photo.md", Buffer.concat([Buffer.from(`# Photo ${MARKER}`), Buffer.alloc(4)]));
  f.write("acme-launch/setup.md", `# Setup\n\npassword: ${MARKER}-abcdef\n\nThe real summary line.\n`);
  const built = cli(f, ["build", "--root", f.root, "--from", f.docs, "--pace-ms", "0"]);
  assert.equal(built.status, 0, built.stderr);
  assert.ok(built.json.skipped.secrets >= 6, JSON.stringify(built.json.skipped));
  for (const file of everyFile(f.dir)) assert.ok(!fs.readFileSync(file, "utf8").includes(MARKER), `${file} contains text from a file that must not be read`);
  assert.ok(!notes(f.dir).some((name) => /password|token|env|rsa|pem|hidden|pkg|photo/.test(name)));
  assert.match(fs.readFileSync(path.join(f.dir, "sources", "documents-acme-launch-setup.md"), "utf8"), /The real summary line\./);
});

test("links that point outside the named folders are not followed", (t) => {
  const f = workspace(t);
  const outside = path.join(f.base, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "private.md"), `# Private\n\n${MARKER}\n`);
  fs.symlinkSync(outside, path.join(f.docs, "acme-launch", "linked-folder"));
  fs.symlinkSync(path.join(outside, "private.md"), path.join(f.docs, "acme-launch", "linked-file.md"));
  const built = cli(f, ["build", "--root", f.root, "--from", f.docs, "--pace-ms", "0"]);
  assert.equal(built.status, 0, built.stderr);
  assert.equal(built.json.skipped.symlinks, 2);
  for (const file of everyFile(f.dir)) assert.ok(!fs.readFileSync(file, "utf8").includes(MARKER), `${file} followed a link out of the folder`);
  assert.ok(!notes(f.dir).some((name) => /linked|private/.test(name)));
  // The brain folder itself is never read back in as a source.
  const whole = cli(f, ["build", "--root", f.root, "--from", f.root, "--no-default", "--pace-ms", "0"]);
  assert.equal(whole.status, 0, whole.stderr);
  assert.ok(!notes(f.dir).some((name) => name.includes("install-brain")));
});

test("graph without Atelier still counts notes and links, and says so plainly", (t) => {
  const f = workspace(t);
  assert.equal(cli(f, ["build", "--root", f.root, "--from", f.docs, "--pace-ms", "0"]).status, 0);
  const graphed = cli(f, ["graph", "--root", f.root]);
  assert.equal(graphed.status, 0, graphed.stderr);
  assert.equal(graphed.json.degraded, true);
  assert.equal(graphed.json.atelier.present, false);
  assert.equal(graphed.json.notes, notes(f.dir).length);
  assert.ok(graphed.json.wikilinks > 10);
  assert.equal(graphed.json.brokenWikilinks, 0);
  assert.match(graphed.json.warnings.join(" "), /Atelier is not installed/);
  const record = JSON.parse(fs.readFileSync(path.join(f.root, "state", "brain-graph.json"), "utf8"));
  assert.equal(record.degraded, true);
  assert.equal(record.notes, graphed.json.notes);
});

test("graph saves local history under a neutral name and reads the Atelier counts", (t) => {
  const f = workspace(t);
  fakeAtelier(f);
  assert.equal(cli(f, ["init", "--root", f.root]).status, 0);
  assert.equal(cli(f, ["build", "--root", f.root, "--from", f.docs, "--pace-ms", "0"]).status, 0);
  const graphed = cli(f, ["graph", "--root", f.root]);
  assert.equal(graphed.status, 0, graphed.stderr);
  assert.equal(graphed.json.degraded, false);
  assert.equal(graphed.json.atelier.nodes, graphed.json.notes + 1, "every note plus the README");
  assert.ok(graphed.json.atelier.edges > 0);
  const log = spawnSync("git", ["-C", f.dir, "log", "--format=%an <%ae>"], { encoding: "utf8", env: env(f) });
  assert.equal(log.stdout.trim(), "All Sorted <brain@localhost>");
  assert.equal(spawnSync("git", ["-C", f.dir, "remote"], { encoding: "utf8", env: env(f) }).stdout.trim(), "", "the brain has no remote and is never pushed");
  assert.equal(spawnSync("git", ["-C", f.dir, "status", "--porcelain"], { encoding: "utf8", env: env(f) }).stdout.trim(), "");
  const again = cli(f, ["graph", "--root", f.root]);
  assert.equal(again.json.commit, "nothing new");
  const status = cli(f, ["status", "--root", f.root]);
  assert.equal(status.json.atelier, "present");
  assert.equal(status.json.lastGraph.edges, graphed.json.atelier.edges);
  assert.equal(status.json.notes, graphed.json.notes);
});

test("add takes notes from the assistant, links them, and respects edits", (t) => {
  const f = workspace(t);
  assert.equal(cli(f, ["build", "--root", f.root, "--from", f.docs, "--pace-ms", "0"]).status, 0);
  const items = [
    { type: "topic", title: "Spring campaign", summary: "The theme tying the launch work together.", body: "Longer notes.", relations: [{ type: "related", target: "Acme launch" }, { type: "belongs_to", target: "companies/acme-co" }, { type: "supports", target: "Nobody Known" }, { type: "inspired by", target: "Dana Lee" }], source: "conversation" },
    { type: "project", title: "Acme launch", summary: "Launch of the Acme line, led by Dana.", relations: [{ type: "depends_on", target: "Spring campaign" }] },
    { type: "weather", title: "Nope" },
    { type: "person" },
  ];
  const added = cli(f, ["add", "--root", f.root, "--json", "-", "--pace-ms", "0"], {}, JSON.stringify(items));
  assert.equal(added.status, 0, added.stderr);
  assert.equal(added.json.written, 1);
  assert.equal(added.json.updated, 1);
  assert.equal(added.json.rejected.length, 2);
  assert.deepEqual(added.json.unresolved, [{ note: "topics/spring-campaign.md", target: "Nobody Known" }]);
  assert.equal(added.json.warnings.length, 1);
  const topic = fs.readFileSync(path.join(f.dir, "topics", "spring-campaign.md"), "utf8");
  assert.match(topic, /belongs_to:\n {6}- "brain:companies-acme-co"/);
  assert.match(topic, /\[\[projects\/acme-launch\|Acme launch\]\] \(related\)/);
  assert.match(topic, /\[\[people\/dana-lee\|Dana Lee\]\] \(related\)/);
  assert.doesNotMatch(topic, /Nobody Known/);
  const project = fs.readFileSync(path.join(f.dir, "projects", "acme-launch.md"), "utf8");
  assert.match(project, /Launch of the Acme line, led by Dana\./);
  assert.match(project, /depends_on:\n {6}- "brain:topics-spring-campaign"/);
  assert.match(project, /\[\[people\/dana-lee\|Dana Lee\]\]/, "relations found by the build are kept");
  // A plain rebuild keeps what the assistant added.
  const rebuilt = cli(f, ["build", "--root", f.root, "--from", f.docs, "--pace-ms", "0"]);
  assert.equal(rebuilt.json.kept, 1);
  assert.equal(fs.readFileSync(path.join(f.dir, "projects", "acme-launch.md"), "utf8"), project);
  // An edited note is not overwritten by add either.
  fs.appendFileSync(path.join(f.dir, "topics", "spring-campaign.md"), "\nMine.\n");
  const second = cli(f, ["add", "--root", f.root, "--json", "-", "--pace-ms", "0"], {}, JSON.stringify([{ type: "topic", title: "Spring campaign", summary: "A different summary." }]));
  assert.equal(second.json.protected, 1);
  assert.match(fs.readFileSync(path.join(f.dir, "topics", "spring-campaign.md"), "utf8"), /Mine\./);
  assert.match(fs.readFileSync(path.join(f.dir, "topics", "spring-campaign.proposed.md"), "utf8"), /A different summary\./);
  const bad = cli(f, ["add", "--root", f.root, "--json", "-"], {}, "{not json");
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /not valid JSON/);
});

// F-33 (customer report 2026-10-20): re-adding a note merged its relations, so
// a renamed target left the old link behind.
test("re-adding a note replaces the relations add gave it and leaves other notes alone", (t) => {
  const f = workspace(t);
  assert.equal(cli(f, ["build", "--root", f.root, "--from", f.docs, "--pace-ms", "0"]).status, 0);
  const add = (items) => {
    const result = cli(f, ["add", "--root", f.root, "--json", "-", "--pace-ms", "0"], {}, JSON.stringify(items));
    assert.equal(result.status, 0, result.stderr);
    return result.json;
  };
  const read = (relative) => fs.readFileSync(path.join(f.dir, relative), "utf8");
  add([
    { type: "topic", title: "Old name", summary: "Target before the rename." },
    { type: "topic", title: "New name", summary: "Target after the rename." },
    { type: "topic", title: "Other note", summary: "Links somewhere itself.", relations: [{ type: "related", target: "Old name" }] },
    { type: "topic", title: "Note A", summary: "The note being re-added.", relations: [{ type: "related", target: "Old name" }] },
  ]);
  // The build found Dana Lee as the owner of Acme launch; add links it too.
  add([{ type: "project", title: "Acme launch", relations: [{ type: "depends_on", target: "Old name" }] }]);
  assert.match(read("topics/note-a.md"), /\[\[topics\/old-name\|/);
  const otherBefore = read("topics/other-note.md");

  add([
    { type: "topic", title: "Note A", relations: [{ type: "related", target: "New name" }] },
    { type: "project", title: "Acme launch", relations: [{ type: "depends_on", target: "New name" }] },
  ]);
  const noteA = read("topics/note-a.md");
  assert.doesNotMatch(noteA, /old-name/, "A -> Old name is gone");
  assert.match(noteA, /\[\[topics\/new-name\|New name\]\] \(related\)/, "A -> New name is present");
  assert.match(noteA, /The note being re-added\./, "the summary given earlier is kept");
  const acme = read("projects/acme-launch.md");
  assert.doesNotMatch(acme, /old-name/);
  assert.match(acme, /depends_on:\n {6}- "brain:topics-new-name"/);
  assert.match(acme, /\[\[people\/dana-lee\|Dana Lee\]\]/, "links the file pass found are kept");
  assert.equal(read("topics/other-note.md"), otherBefore, "another note's link to Old name is untouched");
  const state = JSON.parse(read(brain.STATE_FILE));
  assert.deepEqual(state.notes["topics/note-a.md"].relations, [{ type: "related", target: "topics/new-name" }]);
  assert.ok(state.notes["topics/other-note.md"].relations.some((relation) => relation.target === "topics/old-name"));

  // Leaving relations out keeps them; several items for one note add up.
  add([{ type: "topic", title: "Note A", summary: "Only the summary changes." }]);
  assert.match(read("topics/note-a.md"), /topics\/new-name/);
  add([
    { type: "topic", title: "Note A", relations: [{ type: "related", target: "Old name" }] },
    { type: "topic", title: "Note A", relations: [{ type: "supports", target: "New name" }] },
  ]);
  const both = read("topics/note-a.md");
  assert.match(both, /\[\[topics\/old-name\|Old name\]\] \(related\)/);
  assert.match(both, /\[\[topics\/new-name\|New name\]\] \(supports\)/);
  assert.doesNotMatch(both, /New name\]\] \(related\)/);
  // A plain rebuild keeps the replaced relations.
  assert.equal(cli(f, ["build", "--root", f.root, "--from", f.docs, "--pace-ms", "0"]).status, 0);
  assert.doesNotMatch(read("projects/acme-launch.md"), /old-name/);
});

test("open without --install only says how to get the viewer", (t) => {
  const f = workspace(t);
  assert.equal(cli(f, ["init", "--root", f.root]).status, 0);
  const missing = cli(f, ["open", "--root", f.root]);
  assert.equal(missing.status, 0, missing.stderr);
  assert.equal(missing.json.viewer, "missing");
  assert.equal(missing.json.opened, false);
  assert.deepEqual(missing.json.install, { attempted: false });
  assert.match(missing.json.message, /obsidian\.md\/download/);
  assert.match(missing.json.message, /--install/);
  assert.equal(fs.existsSync(path.join(f.dir, ".obsidian")), false);
  assert.equal(fs.existsSync(path.join(f.base, "install.log")), false, "nothing was installed");
  assert.equal(fs.existsSync(path.join(f.base, "open.log")), false, "nothing was launched");
});

test("open --install installs the viewer and opens straight into the graph view", (t) => {
  const f = workspace(t);
  assert.equal(cli(f, ["init", "--root", f.root]).status, 0);
  const app = path.join(f.base, "Applications", "Obsidian.app");
  const vaults = path.join(f.base, "viewer-vaults.json");
  fs.writeFileSync(vaults, JSON.stringify({ vaults: { abc: { path: "/somewhere/else", ts: 1, open: true } }, theme: "dark" }));
  const opened = cli(f, ["open", "--root", f.root, "--install"], { BRAIN_OBSIDIAN_APP: app });
  assert.equal(opened.status, 0, opened.stderr);
  assert.deepEqual(opened.json.install, { attempted: true, ok: true, method: "custom command", detail: "the install command finished" });
  assert.equal(opened.json.viewer, "present");
  assert.equal(opened.json.opened, true);
  const uri = `obsidian://open?path=${encodeURIComponent(f.dir)}`;
  assert.equal(opened.json.openedWith, uri);
  assert.equal(fs.readFileSync(path.join(f.base, "open.log"), "utf8").trim(), uri);
  assert.match(opened.json.message, /say yes/);
  // The first window is the graph view.
  const viewer = (name) => JSON.parse(fs.readFileSync(path.join(f.dir, ".obsidian", name), "utf8"));
  const space = viewer("workspace.json");
  const leaf = space.main.children[0].children[0];
  assert.equal(space.main.children.length, 1);
  assert.equal(leaf.type, "leaf");
  assert.equal(leaf.state.type, "graph");
  assert.equal(space.active, leaf.id);
  const graph = viewer("graph.json");
  assert.equal(graph.showOrphans, true);
  assert.equal(graph.showArrow, true);
  assert.deepEqual(graph.colorGroups.map((group) => group.query), ["path:projects", "path:people", "path:companies", "path:topics", "path:sources"]);
  assert.ok(graph.colorGroups.every((group) => Number.isInteger(group.color.rgb) && group.color.a === 1));
  assert.equal(viewer("core-plugins.json").graph, true);
  assert.deepEqual(viewer("community-plugins.json"), []);
  // The brain is added to the app's own vault list; the vault already there stays.
  const listed = JSON.parse(fs.readFileSync(vaults, "utf8"));
  assert.equal(listed.theme, "dark");
  assert.equal(listed.vaults.abc.path, "/somewhere/else");
  assert.equal(listed.vaults.abc.open, true, "another vault is left exactly as it was");
  const backups = fs.readdirSync(f.base).filter((name) => name.startsWith("viewer-vaults.json.brain-backup-"));
  assert.equal(backups.length, 1, "the vault list is backed up before it is changed");
  assert.equal(fs.readFileSync(path.join(f.base, backups[0]), "utf8"), JSON.stringify({ vaults: { abc: { path: "/somewhere/else", ts: 1, open: true } }, theme: "dark" }));
  const mine = Object.values(listed.vaults).filter((vault) => vault.path === f.dir);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].open, true);
  assert.equal(opened.json.vaultList, "added");
  assert.equal(opened.json.appCheck.matches, false, "a folder that is not a signed app is reported, not blocked");
  assert.match(opened.json.warnings.join(" "), /not signed as Obsidian/);
  // A second run installs nothing, and never replaces what the app now owns.
  fs.writeFileSync(path.join(f.dir, ".obsidian", "workspace.json"), '{"mine":true}');
  fs.writeFileSync(path.join(f.dir, ".obsidian", "graph.json"), '{"scale":3}');
  const again = cli(f, ["open", "--root", f.root, "--install"], { BRAIN_OBSIDIAN_APP: app });
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(again.json.install, { attempted: false });
  assert.deepEqual(again.json.viewerConfig, []);
  assert.equal(again.json.vaultList, "already listed");
  assert.equal(fs.readFileSync(path.join(f.dir, ".obsidian", "workspace.json"), "utf8"), '{"mine":true}');
  assert.equal(fs.readFileSync(path.join(f.dir, ".obsidian", "graph.json"), "utf8"), '{"scale":3}');
  assert.equal(fs.readFileSync(path.join(f.base, "install.log"), "utf8").trim(), "called", "the installer ran once");
  assert.equal(Object.values(JSON.parse(fs.readFileSync(vaults, "utf8")).vaults).filter((vault) => vault.path === f.dir).length, 1);
  // The viewer settings never enter the graph as notes, and git keeps ignoring the window layout.
  assert.match(fs.readFileSync(path.join(f.dir, ".gitignore"), "utf8"), /^\.obsidian\/workspace\.json$/m);
});

test("open falls back to opening the app with the folder when the link is not handled", (t) => {
  const f = workspace(t);
  assert.equal(cli(f, ["init", "--root", f.root]).status, 0);
  const app = path.join(f.base, "Obsidian.app");
  fs.mkdirSync(app);
  const opened = cli(f, ["open", "--root", f.root], { BRAIN_OBSIDIAN_APP: app, FAKE_URI_FAILS: "1" });
  assert.equal(opened.status, 0, opened.stderr);
  assert.equal(opened.json.opened, true);
  assert.equal(opened.json.openedWith, `open -a ${app}`);
  const calls = fs.readFileSync(path.join(f.base, "open.log"), "utf8").trim().split("\n");
  assert.equal(calls.length, 2);
  assert.equal(calls[1], `-a ${app} ${f.dir}`);
  // Settings the customer already has are left alone.
  fs.writeFileSync(path.join(f.dir, ".obsidian", "app.json"), '{"mine":true}');
  cli(f, ["open", "--root", f.root], { BRAIN_OBSIDIAN_APP: app });
  assert.equal(fs.readFileSync(path.join(f.dir, ".obsidian", "app.json"), "utf8"), '{"mine":true}');
});

test("a viewer install that fails never blocks the brain", (t) => {
  const f = workspace(t);
  assert.equal(cli(f, ["init", "--root", f.root]).status, 0);
  const app = path.join(f.base, "Applications", "Obsidian.app");
  const failed = cli(f, ["open", "--root", f.root, "--install"], { BRAIN_OBSIDIAN_APP: app, FAKE_INSTALL_FAILS: "1" });
  assert.equal(failed.status, 0, failed.stderr);
  assert.equal(failed.json.install.attempted, true);
  assert.equal(failed.json.install.ok, false);
  assert.match(failed.json.install.detail, /no network/);
  assert.equal(failed.json.viewer, "missing");
  assert.equal(failed.json.opened, false);
  assert.match(failed.json.message, /could not be installed/);
  assert.match(failed.json.message, /plain files/);
  assert.equal(fs.existsSync(path.join(f.base, "open.log")), false);
  const built = cli(f, ["build", "--root", f.root, "--from", f.docs, "--pace-ms", "0"]);
  assert.equal(built.status, 0, built.stderr);
  assert.ok(built.json.written > 0);
});

// Stand-ins for curl, hdiutil, ditto, codesign, spctl and xattr. `signature`
// picks what codesign and spctl say about the app inside the disk image.
function diskImageTools(f) {
  const tools = path.join(f.base, "tools");
  fs.mkdirSync(tools);
  fs.writeFileSync(path.join(tools, "payload.dmg"), "pretend disk image");
  fs.writeFileSync(path.join(tools, "final-url"), "https://release-assets.githubusercontent.com/some/asset?x=1");
  fs.writeFileSync(path.join(tools, "signature"), "good");
  const log = path.join(tools, "calls.log");
  const digest = require("node:crypto").createHash("sha256").update("pretend disk image").digest("hex");
  const listing = (sum) => JSON.stringify([
    { tag_name: "v9.9.9", assets: [{ name: "Obsidian-9.9.9.apk", browser_download_url: "https://github.com/obsidianmd/obsidian-releases/releases/download/v9.9.9/Obsidian-9.9.9.apk" }] },
    { tag_name: "v9.9.8", prerelease: true, assets: [{ name: "Obsidian-9.9.8.dmg", browser_download_url: "https://github.com/obsidianmd/obsidian-releases/releases/download/v9.9.8/Obsidian-9.9.8.dmg" }] },
    { tag_name: "v9.9.7", assets: [{ name: "Obsidian-9.9.7.dmg", browser_download_url: "https://example.com/elsewhere/Obsidian-9.9.7.dmg" }] },
    { tag_name: "v9.9.6", assets: [{ name: "Obsidian-9.9.6.dmg", ...(sum ? { digest: `sha256:${sum}` } : {}), browser_download_url: "https://github.com/obsidianmd/obsidian-releases/releases/download/v9.9.6/Obsidian-9.9.6.dmg" }] },
  ]);
  const signature = `sig="$(/bin/cat "${path.join(tools, "signature")}")"`;
  const fake = {
    curl: script(path.join(tools, "curl"), `echo "curl $@" >> "${log}"\nout=""\nwhile [ $# -gt 0 ]; do if [ "$1" = "--output" ]; then out="$2"; fi; shift; done\nif [ -n "$out" ]; then /bin/cp "${path.join(tools, "payload.dmg")}" "$out"; /bin/cat "${path.join(tools, "final-url")}"; else /bin/cat "${path.join(tools, "releases.json")}"; fi\n`),
    hdiutil: script(path.join(tools, "hdiutil"), `echo "hdiutil $1" >> "${log}"\nif [ "$1" = "attach" ]; then /bin/mkdir -p "$6/Obsidian.app/Contents"; echo plist > "$6/Obsidian.app/Contents/Info.plist"; fi\nif [ "$1" = "detach" ] && [ -f "${path.join(tools, "detach-fails")}" ]; then echo "resource busy" >&2; exit 16; fi\n`),
    ditto: script(path.join(tools, "ditto"), `echo "ditto" >> "${log}"\n/bin/cp -R "$1" "$2"\n`),
    codesign: script(path.join(tools, "codesign"), `${signature}\necho "codesign $1" >> "${log}"\nif [ "$sig" = "unsigned" ]; then echo "code object is not signed at all" >&2; exit 1; fi\nif [ "$1" = "--verify" ]; then exit 0; fi\ncase "$sig" in\n  adhoc) printf 'Identifier=md.obsidian\\nSignature=adhoc\\nTeamIdentifier=not set\\n' >&2 ;;\n  wrong-team) printf 'Identifier=md.obsidian\\nTeamIdentifier=ABCDE12345\\n' >&2 ;;\n  wrong-id) printf 'Identifier=com.example.notes\\nTeamIdentifier=6JSW4SJWN9\\n' >&2 ;;\n  *) printf 'Identifier=md.obsidian\\nTeamIdentifier=6JSW4SJWN9\\n' >&2 ;;\nesac\n`),
    spctl: script(path.join(tools, "spctl"), `${signature}\necho "spctl" >> "${log}"\ncase "$sig" in\n  rejected) echo "$3: rejected" >&2; exit 3 ;;\n  not-notarized) printf '%s: accepted\\nsource=Developer ID\\n' "$3" >&2 ;;\n  *) printf '%s: accepted\\nsource=Notarized Developer ID\\norigin=Developer ID Application: Dynalist Inc. (6JSW4SJWN9)\\n' "$3" >&2 ;;\nesac\n`),
    xattr: script(path.join(tools, "xattr"), `echo "xattr $@" >> "${log}"\nif [ "$1" = "-p" ]; then exit 1; fi\n`),
  };
  const set = (name, value) => fs.writeFileSync(path.join(tools, name), value);
  return { tools, fake, log, digest, listing, set, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8") : ""), destination: path.join(f.base, "Apps", "Obsidian.app") };
}

test("the disk image install copies an app only when it is proven to be Obsidian", (t) => {
  const f = workspace(t);
  const d = diskImageTools(f);
  const install = () => brain.installViewerFromDiskImage({ tools: d.fake, destinations: [d.destination] });
  d.set("releases.json", d.listing(d.digest));

  // Every way the app can fail to be Obsidian's: nothing is copied.
  for (const [signature, reason] of [
    ["unsigned", /code signature is missing or broken/],
    ["adhoc", /signed by team "not set", not by Obsidian's publisher \(6JSW4SJWN9\)/],
    ["wrong-team", /signed by team "ABCDE12345"/],
    ["wrong-id", /signed as "com\.example\.notes", not as md\.obsidian/],
    ["rejected", /Gatekeeper did not accept it/],
    ["not-notarized", /not notarized by Apple/],
  ]) {
    d.set("signature", signature);
    const refused = install();
    assert.equal(refused.ok, false, signature);
    assert.match(refused.detail, reason, signature);
    assert.match(refused.detail, /was not copied/, signature);
    assert.equal(fs.existsSync(d.destination), false, `${signature}: nothing may be copied`);
  }
  assert.doesNotMatch(d.calls(), /ditto/);
  assert.equal(d.calls().match(/hdiutil attach/g).length, d.calls().match(/hdiutil detach/g).length, "every mounted image is detached");
  d.set("signature", "good");

  // A checksum that is published must match.
  d.set("releases.json", d.listing("0".repeat(64)));
  const before = d.calls().match(/hdiutil attach/g).length;
  const wrongSum = install();
  assert.equal(wrongSum.ok, false);
  assert.match(wrongSum.detail, /did not match the checksum/);
  assert.equal(d.calls().match(/hdiutil attach/g).length, before, "a bad download is never mounted");

  // A download that ends up somewhere other than GitHub is thrown away.
  d.set("releases.json", d.listing(d.digest));
  for (const final of ["https://downloads.example.com/Obsidian.dmg", "http://github.com/x.dmg", "not a url"]) {
    d.set("final-url", final);
    const redirected = install();
    assert.equal(redirected.ok, false, final);
    assert.match(redirected.detail, /which is not GitHub/, final);
  }
  d.set("final-url", "https://objects.githubusercontent.com/asset");
  assert.equal(fs.existsSync(d.destination), false);

  // The good case, with a detach that fails: still installed, with a warning, and nothing thrown.
  d.set("detach-fails", "");
  const installed = install();
  assert.equal(installed.ok, true, installed.detail);
  assert.equal(installed.app, d.destination);
  assert.match(installed.detail, /Obsidian 9\.9\.6 copied to .*published checksum matched, signed by Obsidian's publisher \(6JSW4SJWN9\), notarized by Apple/);
  assert.match(installed.warnings.join(" "), /could not be ejected/);
  assert.ok(fs.existsSync(path.join(d.destination, "Contents", "Info.plist")));
  fs.rmSync(path.join(d.tools, "detach-fails"));
  const calls = d.calls();
  assert.match(calls, /curl --proto =https --proto-redir =https --tlsv1\.2 --fail --location/);
  assert.match(calls, /releases\/download\/v9\.9\.6\/Obsidian-9\.9\.6\.dmg/, "the newest stable desktop release from the official address is used");
  assert.doesNotMatch(calls, /example\.com\/elsewhere|9\.9\.8/);
  assert.match(calls, /xattr -w com\.apple\.quarantine 0081;[0-9a-f]+;All Sorted; /, "the copied app is marked as downloaded so macOS checks it at first launch");

  // No published checksum: said plainly, and the signature gate still decides.
  fs.rmSync(d.destination, { recursive: true });
  d.set("releases.json", d.listing(null));
  const unsummed = install();
  assert.equal(unsummed.ok, true, unsummed.detail);
  assert.equal(unsummed.checksum, "no published checksum");
  assert.match(unsummed.detail, /no published checksum, signed by Obsidian's publisher/);

  d.set("releases.json", "[]");
  assert.match(install().detail, /no desktop disk image/);
});

test("the identity check reads the publisher, and open reports it without blocking", (t) => {
  const f = workspace(t);
  const d = diskImageTools(f);
  const app = path.join(f.base, "Obsidian.app");
  fs.mkdirSync(app);
  assert.deepEqual(brain.appIdentity(app, d.fake), { identifier: "md.obsidian", team: "6JSW4SJWN9", matches: true });
  assert.equal(brain.verifyViewerApp(app, d.fake).ok, true);
  d.set("signature", "wrong-team");
  assert.equal(brain.appIdentity(app, d.fake).matches, false);
  assert.equal(brain.OBSIDIAN_TEAM, "6JSW4SJWN9");
  assert.equal(brain.OBSIDIAN_IDENTIFIER, "md.obsidian");
  const names = ["BRAIN_OBSIDIAN_APP", "BRAIN_OBSIDIAN_CONFIG", "BRAIN_OPEN_CMD", "BRAIN_PGREP_CMD"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) process.env[name] = env(f, { BRAIN_OBSIDIAN_APP: app })[name];
  t.after(() => { for (const name of names) { if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; } });
  brain.init({ root: f.root });
  const opened = brain.open({ root: f.root, tools: d.fake });
  assert.equal(opened.opened, true);
  assert.deepEqual(opened.appCheck, { identifier: "md.obsidian", team: "ABCDE12345", matches: false });
  assert.match(opened.warnings.join(" "), /not signed as Obsidian by its publisher/);
  d.set("signature", "good");
  const again = brain.open({ root: f.root, tools: d.fake });
  assert.equal(again.appCheck.matches, true);
  assert.deepEqual(again.warnings, []);
});

test("the viewer's own vault list is backed up, never clobbered, and left alone while the app runs", (t) => {
  const f = workspace(t);
  assert.equal(cli(f, ["init", "--root", f.root]).status, 0);
  const app = path.join(f.base, "Obsidian.app");
  fs.mkdirSync(app);
  const vaults = path.join(f.base, "viewer-vaults.json");
  const backups = () => fs.readdirSync(f.base).filter((name) => name.startsWith("viewer-vaults.json.brain-backup-")).sort();
  const original = JSON.stringify({ vaults: { one: { path: "/a", ts: 1, open: true }, two: { path: "/b", ts: 2 } }, updateDisabled: true });
  // While the app runs the file is not touched at all, and the folder is still opened.
  fs.writeFileSync(vaults, original);
  const running = cli(f, ["open", "--root", f.root], { BRAIN_OBSIDIAN_APP: app, FAKE_VIEWER_RUNNING: "1" });
  assert.equal(running.status, 0, running.stderr);
  assert.equal(running.json.vaultList, "skipped: app running");
  assert.equal(running.json.opened, true);
  assert.equal(fs.readFileSync(vaults, "utf8"), original);
  assert.deepEqual(backups(), []);
  // A file that cannot be read is left alone.
  fs.writeFileSync(vaults, "{not json");
  const malformed = cli(f, ["open", "--root", f.root], { BRAIN_OBSIDIAN_APP: app });
  assert.match(malformed.json.vaultList, /^left alone/);
  assert.equal(fs.readFileSync(vaults, "utf8"), "{not json");
  fs.writeFileSync(vaults, JSON.stringify({ vaults: ["unexpected"] }));
  assert.match(cli(f, ["open", "--root", f.root], { BRAIN_OBSIDIAN_APP: app }).json.vaultList, /^left alone/);
  assert.deepEqual(backups(), []);
  // Otherwise: backed up first, the brain added, everything else untouched.
  fs.writeFileSync(vaults, original);
  const added = cli(f, ["open", "--root", f.root], { BRAIN_OBSIDIAN_APP: app });
  assert.equal(added.json.vaultList, "added");
  const after = JSON.parse(fs.readFileSync(vaults, "utf8"));
  assert.deepEqual(after.vaults.one, { path: "/a", ts: 1, open: true });
  assert.deepEqual(after.vaults.two, { path: "/b", ts: 2 });
  assert.equal(after.updateDisabled, true);
  assert.equal(Object.values(after.vaults).filter((vault) => vault.path === f.dir && vault.open === true).length, 1);
  assert.equal(backups().length, 1);
  assert.equal(fs.readFileSync(path.join(f.base, backups()[0]), "utf8"), original);
  // Already listed: no write, no new backup.
  const stamp = fs.statSync(vaults).mtimeMs;
  assert.equal(cli(f, ["open", "--root", f.root], { BRAIN_OBSIDIAN_APP: app }).json.vaultList, "already listed");
  assert.equal(fs.statSync(vaults).mtimeMs, stamp);
  assert.equal(backups().length, 1);
  // Only the last three backups are kept.
  for (let round = 0; round < 5; round += 1) {
    const now = JSON.parse(fs.readFileSync(vaults, "utf8"));
    for (const vault of Object.values(now.vaults)) if (vault.path === f.dir) delete vault.open;
    fs.writeFileSync(vaults, JSON.stringify(now));
    fs.writeFileSync(path.join(f.base, `viewer-vaults.json.brain-backup-1999010${round}T000000000Z`), "old");
    assert.equal(cli(f, ["open", "--root", f.root], { BRAIN_OBSIDIAN_APP: app }).json.vaultList, "already listed");
  }
  assert.equal(backups().length, 3);
  assert.ok(backups().every((name) => !name.includes("1999")), "the oldest backups are the ones removed");
});

test("the default pace is watchable for a small brain and bounded for a large one", () => {
  assert.equal(brain.defaultPace(0), 0);
  assert.equal(brain.defaultPace(15), brain.MAX_PACE_MS);
  assert.ok(brain.MAX_PACE_MS >= 200 && brain.MAX_PACE_MS <= 500, "a few hundred milliseconds per note");
  assert.equal(brain.PACE_BUDGET_MS, 90 * 1000);
  for (const count of [300, 2000, 20000, 1000000]) assert.ok(brain.defaultPace(count) * count <= brain.PACE_BUDGET_MS, `${count} notes pause for no more than ninety seconds in total`);
  assert.ok(brain.defaultPace(2000) < brain.defaultPace(100));
});

test("the pace option spaces out note writes so a viewer can show them arriving", async (t) => {
  const f = workspace(t);
  const seen = [];
  const started = Date.now();
  const previous = process.env.PATH;
  process.env.PATH = env(f).PATH;
  t.after(() => { process.env.PATH = previous; });
  const result = await brain.build({ root: f.root, from: [f.docs], paceMs: 20, onNote: (event) => seen.push(event.note) });
  assert.equal(seen.length, result.written);
  assert.ok(Date.now() - started >= 20 * (result.written - 1), "writes are spaced by the pace");
  assert.equal(seen[0].split("/")[0], "topics", "hub notes arrive first");
});

test("status, the recipes and the organizer command all reach the brain", async (t) => {
  const f = workspace(t);
  const empty = cli(f, ["status", "--root", f.root]);
  assert.equal(empty.status, 0, empty.stderr);
  assert.equal(empty.json.exists, false);
  const names = ["PATH", "BRAIN_OBSIDIAN_APP", "BRAIN_OBSIDIAN_CONFIG", "BRAIN_INSTALL_CMD", "BRAIN_OPEN_CMD"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) process.env[name] = env(f)[name];
  t.after(() => { for (const name of names) { if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; } });
  const built = await require("../recipes/build-brain.js").runRecipe({ args: { root: f.root, from: [f.docs], paceMs: 0 } });
  assert.equal(built.status, "ok", built.reply);
  assert.equal(built.metadata.degraded, true);
  assert.match(built.reply, /Move that one folder and the whole brain moves with it\./);
  const report = await require("../recipes/brain-status.js").runRecipe({ args: { root: f.root } });
  assert.equal(report.status, "ok");
  assert.match(report.reply, new RegExp(`Notes: ${built.metadata.notes} `));
  const opened = await require("../recipes/open-brain.js").runRecipe({ args: { root: f.root } });
  assert.equal(opened.status, "ok");
  assert.equal(opened.metadata.opened, false);
  assert.equal(opened.metadata.install.attempted, false, "the recipe installs the viewer only when asked");
  const viaOrganizer = spawnSync(process.execPath, [ORGANIZER_CLI, "brain", "status", "--root", f.root], { encoding: "utf8", env: env(f) });
  assert.equal(viaOrganizer.status, 0, viaOrganizer.stderr);
  assert.equal(JSON.parse(viaOrganizer.stdout).notes, built.metadata.notes);
  const unknown = cli(f, ["build", "--root", f.root, "--frm", f.docs]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown option/);
});

test("names in any script get their own notes with stable ids", (t) => {
  const f = workspace(t);
  f.write("people/zhang.md", "# 张伟\n\n工程师。\n");
  f.write("people/wang.md", "# 王芳\n\n设计师。与 [[张伟]] 合作。\n");
  f.write("people/ivan.md", "# Иван Петров\n\nИнженер.\n");
  f.write("people/sara.md", "# سارة أحمد\n\nمديرة.\n");
  f.write("notes/计划.md", "---\ntitle: 春季计划\nowner: 张伟\n---\n# 春季计划\n\n内容在这里。\n");
  f.write("notes/symbols.md", "# !!!\n\nA title with no letters at all.\n");
  const built = cli(f, ["build", "--root", f.root, "--from", f.docs, "--pace-ms", "0"]);
  assert.equal(built.status, 0, built.stderr);
  const written = notes(f.dir);
  for (const expected of ["people/张伟.md", "people/王芳.md", "people/иван-петров.md", "people/سارة-أحمد.md", "sources/documents-notes-计划.md"]) assert.ok(written.includes(expected), `missing ${expected} in ${written.join(", ")}`);
  assert.equal(written.filter((name) => name.startsWith("people/note")).length, 0, "no person collapses into a generic name");
  assert.equal(brain.slugify("张伟"), "张伟");
  assert.notEqual(brain.slugify("张伟"), brain.slugify("王芳"));
  assert.match(brain.slugify("!!!"), /^note-[0-9a-f]{8}$/);
  assert.notEqual(brain.slugify("!!!"), brain.slugify("???"), "titles with no letters still get different slugs");
  assert.equal(brain.slugify("!!!"), brain.slugify("!!!"));
  assert.match(fs.readFileSync(path.join(f.dir, "people", "张伟.md"), "utf8"), /^ {2}id: "brain:people-张伟"$/m);
  assert.match(fs.readFileSync(path.join(f.dir, "people", "王芳.md"), "utf8"), /\[\[people\/张伟\|张伟\]\]/);
  assert.match(fs.readFileSync(path.join(f.dir, "sources", "documents-notes-计划.md"), "utf8"), /\[\[people\/张伟\|张伟\]\] \(related\)/);
  // The same documents give the same files and ids again.
  const before = snapshot(f.dir);
  const again = cli(f, ["build", "--root", f.root, "--from", f.docs, "--pace-ms", "0"]);
  assert.equal(again.json.written + again.json.updated + again.json.protected, 0);
  assert.deepEqual(snapshot(f.dir), before);
  const counted = cli(f, ["status", "--root", f.root]);
  assert.equal(counted.json.brokenWikilinks, 0);
});

test("a source note carries the document's own text, with keys removed and links kept honest", (t) => {
  const f = workspace(t);
  f.write("acme-launch/plan.md", [
    "---", "title: Launch plan", "---", "# Launch plan", "", "The opening paragraph of the plan.", "",
    "## Steps", "", "1. Talk to [[checklist|the checklist]] and to [[Nobody Here]].", "2. Embed ![[diagram.png]] here.", "",
    `api_key = ${MARKER}0123456789`, "",
    `${DASHES}BEGIN RSA PRIVATE ${"KEY"}${DASHES}`, `${MARKER}line1`, `${MARKER}line2`, `${DASHES}END RSA PRIVATE ${"KEY"}${DASHES}`, "",
    "```sh", "if [[ -f plan.md ]]; then echo ok; fi", "```", "",
    "Inline `[[not a link]]` stays as code.", "", "The closing paragraph of the plan.", "",
  ].join("\n"));
  const built = cli(f, ["build", "--root", f.root, "--from", f.docs, "--pace-ms", "0"]);
  assert.equal(built.status, 0, built.stderr);
  const note = fs.readFileSync(path.join(f.dir, "sources", "documents-acme-launch-plan.md"), "utf8");
  const content = note.slice(note.indexOf("\n## Content\n"));
  assert.ok(note.indexOf("\n## Related\n") < note.indexOf("\n## Content\n"), "Content comes after Related");
  assert.match(content, /The opening paragraph of the plan\./);
  assert.match(content, /The closing paragraph of the plan\./);
  assert.match(content, /Talk to \[\[sources\/documents-acme-launch-checklist\|the checklist\]\] and to Nobody Here\./, "a link to a real note is kept, a link to nothing becomes plain text");
  assert.match(content, /Embed diagram\.png here\./);
  assert.equal(content.split(brain.REMOVED_LINE).length - 1, 2, "the key line and the key block are each replaced once");
  assert.ok(!note.includes(MARKER), "no part of a key is copied");
  assert.match(content, /if \[\[ -f plan\.md \]\]; then echo ok; fi/, "code is copied as it is");
  assert.match(content, /Inline `\[\[not a link\]\]` stays as code\./);
  assert.doesNotMatch(content, /^title: Launch plan$/m, "the document's own front matter is not copied");
  const counted = cli(f, ["status", "--root", f.root]);
  assert.equal(counted.json.brokenWikilinks, 0, JSON.stringify(counted.json));
  // The brain alone now holds the knowledge: the originals can go.
  fs.rmSync(f.docs, { recursive: true });
  assert.match(fs.readFileSync(path.join(f.dir, "sources", "documents-acme-launch-pricing.md"), "utf8"), /## Content\n\n# Pricing\n\nThree tiers\./);
  // The cap: the first part is kept, and the note says so and where the original is.
  const g = workspace(t);
  g.write("big/long.md", `# Long\n\n${"A full line of ordinary words to fill the page.\n".repeat(400)}`);
  const capped = cli(g, ["build", "--root", g.root, "--from", g.docs, "--pace-ms", "0", "--max-note-bytes", "2048"]);
  assert.equal(capped.status, 0, capped.stderr);
  const long = fs.readFileSync(path.join(g.dir, "sources", "documents-big-long.md"), "utf8");
  const longContent = long.slice(long.indexOf("\n## Content\n"));
  assert.ok(Buffer.byteLength(longContent) < 2048 + 400, `content is ${Buffer.byteLength(longContent)} bytes`);
  assert.match(longContent, /\[Cut here: this note holds the first 2 KB of the document\. The full original is at documents\/big\/long\.md\.\]\n$/);
  assert.equal(brain.DEFAULT_MAX_NOTE_BYTES, 200 * 1024);
  // Edit protection still covers the whole note, content included.
  fs.writeFileSync(path.join(g.dir, "sources", "documents-big-long.md"), long.replace("ordinary words", "MY words"));
  const kept = cli(g, ["build", "--root", g.root, "--from", g.docs, "--pace-ms", "0", "--max-note-bytes", "2048"]);
  assert.equal(kept.json.protected, 1);
  assert.match(fs.readFileSync(path.join(g.dir, "sources", "documents-big-long.md"), "utf8"), /MY words/);
});

test("an existing Obsidian vault used as a source reaches zero broken links", (t) => {
  const f = workspace(t);
  const vault = path.join(f.base, "My Vault");
  const put = (relative, text) => { fs.mkdirSync(path.dirname(path.join(vault, relative)), { recursive: true }); fs.writeFileSync(path.join(vault, relative), text); };
  put(".obsidian/app.json", "{}");
  put(".obsidian/plugins/x/notes.md", `# Plugin\n\n${MARKER}\n`);
  put("Home.md", "# Home [[Ideas]]\n\nStart at [[Ideas]], then [[Daily/2026-01-01|new year]], then [[Missing Page]] and [[Ideas#Later|later ideas]].\n\n![[photo.png]]\n");
  put("Ideas.md", "# Ideas\n\nBack to [[Home]]. See [[People/Dana Lee]] and [[Nowhere|a dead link]].\n\n## Later\n\nMore.\n");
  put("Daily/2026-01-01.md", "# 2026-01-01\n\nWorked on [[Ideas]] with [[Dana Lee]].\n");
  put("People/Dana Lee.md", "# Dana Lee\n\nSee [[Home]].\n");
  const built = cli(f, ["build", "--root", f.root, "--from", vault, "--no-default", "--pace-ms", "0"]);
  assert.equal(built.status, 0, built.stderr);
  const graphed = cli(f, ["graph", "--root", f.root]);
  assert.equal(graphed.json.brokenWikilinks, 0, JSON.stringify(graphed.json));
  assert.ok(graphed.json.wikilinks > 8);
  const home = fs.readFileSync(path.join(f.dir, "sources", "my-vault-home.md"), "utf8");
  assert.match(home, /^title: "Home Ideas"$/m, "a link in a heading becomes plain text in the title");
  assert.match(home, /Start at \[\[sources\/my-vault-ideas\|Ideas\]\], then \[\[topics\/daily[^\]|]*\|new year\]\]|Start at \[\[sources\/my-vault-ideas\|Ideas\]\], then \[\[sources\/my-vault-daily-2026-01-01\|new year\]\]/);
  assert.match(home, /then Missing Page and \[\[sources\/my-vault-ideas\|later ideas\]\]\./);
  assert.match(home, /\nphoto\.png\n/);
  assert.match(fs.readFileSync(path.join(f.dir, "sources", "my-vault-ideas.md"), "utf8"), /See \[\[people\/dana-lee\|People\/Dana Lee\]\] and a dead link\./);
  assert.ok(fs.existsSync(path.join(f.dir, "people", "dana-lee.md")));
  for (const file of everyFile(f.dir)) assert.ok(!fs.readFileSync(file, "utf8").includes(MARKER), "the vault's own settings folder is never read");
  // The brain's own guide holds no link syntax, and is not counted as a note.
  assert.doesNotMatch(fs.readFileSync(path.join(f.dir, "README.md"), "utf8"), /\[\[/);
  fs.appendFileSync(path.join(f.dir, "README.md"), "\nA note to self about [[something missing]].\n");
  assert.equal(cli(f, ["status", "--root", f.root]).json.brokenWikilinks, 0);
});

test("a build that is killed part way carries on cleanly", async (t) => {
  const f = workspace(t);
  for (let index = 0; index < 60; index += 1) f.write(`batch/note-${String(index).padStart(2, "0")}.md`, `# Note ${index}\n\nBody ${index}.\n`);
  const { spawn } = require("node:child_process");
  const partial = (signal) => new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, "build", "--root", f.root, "--from", f.docs, "--pace-ms", "40"], { env: env(f), cwd: f.base, stdio: ["ignore", "ignore", "pipe"] });
    let seen = 0;
    let sent = false;
    child.stderr.on("data", (chunk) => {
      seen += String(chunk).split("\n").filter((line) => line.startsWith("+ ")).length;
      if (!sent && seen >= 30) { sent = true; child.kill(signal); }
    });
    child.on("exit", (code, killedBy) => resolve({ code, killedBy, seen }));
  });
  // Killed with no chance to tidy up.
  const killed = await partial("SIGKILL");
  assert.equal(killed.killedBy, "SIGKILL");
  const onDisk = notes(f.dir).length;
  assert.ok(onDisk >= 30 && onDisk < 68, `${onDisk} notes were written before the kill`);
  const saved = Object.keys(JSON.parse(fs.readFileSync(path.join(f.dir, brain.STATE_FILE), "utf8")).notes).length;
  assert.ok(saved >= 25 && saved <= onDisk, `state was saved as the build went (${saved} of ${onDisk})`);
  const resumed = cli(f, ["build", "--root", f.root, "--from", f.docs, "--pace-ms", "0"]);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(resumed.json.protected, 0, "its own notes are never mistaken for edited ones");
  assert.equal(resumed.json.unchanged, onDisk);
  assert.equal(resumed.json.written, resumed.json.notes - onDisk);
  assert.equal(notes(f.dir).filter((name) => name.endsWith(".proposed.md")).length, 0);
  // Stopped politely: the state is saved on the way out.
  fs.rmSync(f.dir, { recursive: true });
  const stopped = await partial("SIGTERM");
  assert.equal(stopped.code, 143);
  const afterStop = notes(f.dir).length;
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(f.dir, brain.STATE_FILE), "utf8")).notes).length, afterStop, "every note written before the stop is recorded");
  // Even with the state lost entirely, identical notes are recognised as its own.
  fs.writeFileSync(path.join(f.dir, brain.STATE_FILE), JSON.stringify({ version: 1, notes: {} }));
  const recovered = cli(f, ["build", "--root", f.root, "--from", f.docs, "--pace-ms", "0"]);
  assert.equal(recovered.json.protected, 0);
  assert.equal(recovered.json.unchanged, afterStop);
});

test("the brain and the install's state folder can never be named as sources", (t) => {
  const f = workspace(t);
  assert.equal(cli(f, ["build", "--root", f.root, "--from", f.docs, "--pace-ms", "0"]).status, 0);
  const before = notes(f.dir);
  for (const inside of [f.dir, path.join(f.dir, "sources"), path.join(f.root, "state")]) {
    const refused = cli(f, ["build", "--root", f.root, "--from", inside, "--pace-ms", "0"]);
    assert.equal(refused.status, 1, inside);
    assert.match(refused.stderr, /is inside (the brain folder itself|the install's own state folder)/, inside);
  }
  // A link that points at the brain is refused the same way.
  const link = path.join(f.base, "sneaky");
  fs.symlinkSync(f.dir, link);
  assert.equal(cli(f, ["build", "--root", f.root, "--from", link, "--pace-ms", "0"]).status, 1);
  assert.deepEqual(notes(f.dir), before);
});

test("add can only ever write inside the brain's own folders", (t) => {
  const f = workspace(t);
  assert.equal(cli(f, ["init", "--root", f.root]).status, 0);
  const outside = path.join(f.base, "outside.md");
  const hostile = [
    { type: "topic", title: "../../outside", summary: "one" },
    { type: "topic", title: "/etc/passwd", summary: "two" },
    { type: "topic", title: "nul\u0000byte", summary: "three" },
    { type: "topic", title: "CON", summary: "four" },
    { type: "topic", title: "..", summary: "five" },
    { type: "topic", title: "Safe title", note: "../../outside", summary: "six" },
    { type: "topic", title: "Other safe", note: outside.replace(/\.md$/, ""), summary: "seven" },
    { type: "topic", title: "Third safe", note: "topics/../../outside", summary: "eight" },
    { type: "../../outside", title: "Bad type" },
    { type: "constructor", title: "Bad type two" },
    { type: "__proto__", title: "Bad type three" },
    { type: "topic", title: "Sourced", summary: "nine", source: "line one\nline two `rm -rf` \u0000 end", tags: ["a\nb"] },
    { type: "topic", title: "Linked [[Nowhere]]", summary: "See [[Nowhere]] and [[Sourced]].", body: "Body links [[Sourced]] and [[Nowhere|gone]]." },
  ];
  const added = cli(f, ["add", "--root", f.root, "--json", "-", "--pace-ms", "0"], {}, JSON.stringify(hostile));
  assert.equal(added.status, 0, added.stderr);
  assert.equal(added.json.rejected.length, 3, JSON.stringify(added.json.rejected));
  assert.equal(fs.existsSync(outside), false);
  const allowed = new Set(Object.values(brain.TYPE_DIRS));
  for (const entry of fs.readdirSync(f.base, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const full = path.join(entry.parentPath, entry.name);
    if (!full.startsWith(f.dir + path.sep)) { assert.ok(full.startsWith(f.docs + path.sep), `${full} was written outside the brain`); continue; }
    const relative = path.relative(f.dir, full).split(path.sep);
    if (relative.length === 1) { assert.equal(relative[0], "README.md"); continue; }
    assert.equal(relative.length, 2, full);
    assert.ok(allowed.has(relative[0]), full);
    assert.doesNotMatch(relative[1], /[\\/\u0000]|^\.\.?$/);
  }
  assert.equal(notes(f.dir).length, 10);
  const sourced = fs.readFileSync(path.join(f.dir, "topics", "sourced.md"), "utf8");
  assert.match(sourced, /^- `line one line two rm -rf end`$/m, "a source is kept to one line with no backticks");
  assert.match(sourced, /^ {2}- "a b"$/m);
  const linked = fs.readFileSync(path.join(f.dir, "topics", "linked-nowhere.md"), "utf8");
  assert.match(linked, /^title: "Linked Nowhere"$/m);
  assert.match(linked, /^See Nowhere and Sourced\.$/m, "summaries never hold links");
  assert.match(linked, /Body links \[\[topics\/sourced\|Sourced\]\] and gone\./);
  assert.equal(cli(f, ["status", "--root", f.root]).json.brokenWikilinks, 0);
});

test("add keeps the document text the file pass copied into a note", (t) => {
  const f = workspace(t);
  assert.equal(cli(f, ["build", "--root", f.root, "--from", f.docs, "--pace-ms", "0"]).status, 0);
  const added = cli(f, ["add", "--root", f.root, "--json", "-", "--pace-ms", "0"], {}, JSON.stringify([{ type: "source", title: "Pricing", note: "sources/documents-acme-launch-pricing", summary: "How the product is priced.", relations: [{ type: "related", target: "Dana Lee" }] }]));
  assert.equal(added.json.updated, 1, JSON.stringify(added.json));
  const note = fs.readFileSync(path.join(f.dir, "sources", "documents-acme-launch-pricing.md"), "utf8");
  assert.match(note, /How the product is priced\./);
  assert.match(note, /## Content\n\n# Pricing\n\nThree tiers\.\n$/);
  assert.match(note, /\[\[people\/dana-lee\|Dana Lee\]\]/);
});

test("the file limit is shared across folders and reported loudly", async (t) => {
  const f = workspace(t);
  const second = path.join(f.base, "second");
  for (let index = 0; index < 30; index += 1) f.write(`many/doc-${String(index).padStart(2, "0")}.md`, `# Doc ${index}\n\nText.\n`);
  for (let index = 0; index < 4; index += 1) { fs.mkdirSync(second, { recursive: true }); fs.writeFileSync(path.join(second, `s-${index}.md`), `# Second ${index}\n\nText.\n`); }
  const built = cli(f, ["build", "--root", f.root, "--from", f.docs, "--from", second, "--pace-ms", "0", "--max-files", "12"]);
  assert.equal(built.status, 0, built.stderr);
  assert.deepEqual(built.json.folders.map((folder) => folder.documents), [8, 4], "the small folder is read in full; the big one takes what is left");
  assert.equal(built.json.skipped.overLimit, 28);
  assert.deepEqual(built.json.skipped.cutFolders, [{ folder: f.docs, read: 8, left: 28 }]);
  assert.match(built.json.warnings[0], /^LIMIT REACHED: 28 documents were NOT read because of the 12 file limit \(documents: read 8, left out 28\)\. Run again with --max-files/);
  assert.deepEqual(brain.shareLimit([5000, 10, 300], 2000), [1690, 10, 300]);
  assert.deepEqual(brain.shareLimit([3, 3], 100), [3, 3]);
  assert.deepEqual(brain.shareLimit([0, 50], 20), [0, 20]);
  const names = ["PATH", "BRAIN_OBSIDIAN_APP", "BRAIN_OBSIDIAN_CONFIG", "BRAIN_INSTALL_CMD", "BRAIN_OPEN_CMD", "BRAIN_PGREP_CMD"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) process.env[name] = env(f)[name];
  t.after(() => { for (const name of names) { if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; } });
  const recipe = await require("../recipes/build-brain.js").runRecipe({ args: { root: f.root, from: [f.docs, second], paceMs: 0, maxFiles: 12 } });
  assert.match(recipe.reply, /LIMIT REACHED: 28 documents were NOT read/);
});

test("folders decide what a document is, and names are tidied", (t) => {
  const f = workspace(t);
  f.write("projects/apollo/CONTEXT.md", "# Apollo context\n\nThe Apollo project, described on its front page.\n\nOwner: Raj Chen\n");
  f.write("projects/apollo/README.md", "# Apollo readme\n\nA second front page, which stays a source.\n");
  f.write("projects/apollo/notes/meeting.md", "# Meeting\n\nAttendees: Raj, Codex, Claude\n\nDecisions.\n");
  f.write("projects/zephyr/index.md", "# Zephyr\n\nThe Zephyr project.\n\nOwner: Alex\n");
  f.write("clients/globex/README.md", "# About Globex\n\nGlobex is a client.\n");
  f.write("clients/globex/contract-notes.md", "# Contract notes\n\nAttendees: Alex Stone, Alex Reed\n\nTerms.\n");
  const built = cli(f, ["build", "--root", f.root, "--from", f.docs, "--pace-ms", "0"]);
  assert.equal(built.status, 0, built.stderr);
  const written = notes(f.dir);
  // A front page inside a folder under projects or clients IS that project or company.
  for (const expected of ["projects/apollo.md", "projects/zephyr.md", "companies/globex.md", "sources/documents-projects-apollo-readme.md", "sources/documents-projects-apollo-notes-meeting.md", "sources/documents-clients-globex-contract-notes.md"]) assert.ok(written.includes(expected), `missing ${expected} in ${written.join(", ")}`);
  for (const absent of ["sources/documents-projects-apollo-context.md", "sources/documents-projects-zephyr-index.md", "sources/documents-clients-globex-readme.md", "projects/projects.md", "projects/clients.md"]) assert.ok(!written.includes(absent), `${absent} should not exist`);
  const apollo = fs.readFileSync(path.join(f.dir, "projects", "apollo.md"), "utf8");
  assert.match(apollo, /^title: "Apollo"$/m, "named after the folder");
  assert.match(apollo, /The Apollo project, described on its front page\./);
  assert.match(apollo, /## Content\n\n# Apollo context/);
  assert.match(apollo, /- `documents\/projects\/apollo\/CONTEXT\.md`/);
  assert.match(fs.readFileSync(path.join(f.dir, "companies", "globex.md"), "utf8"), /## Content\n\n# About Globex\n\nGlobex is a client\./);
  assert.match(fs.readFileSync(path.join(f.dir, "sources", "documents-projects-apollo-notes-meeting.md"), "utf8"), /supports:\n {6}- "brain:projects-apollo"/);
  // "Raj" is Raj Chen, the only full name that starts with Raj.
  assert.ok(written.includes("people/raj-chen.md"));
  assert.ok(!written.includes("people/raj.md"), "a lone given name is folded into the one full name it matches");
  assert.match(fs.readFileSync(path.join(f.dir, "sources", "documents-projects-apollo-notes-meeting.md"), "utf8"), /\[\[people\/raj-chen\|Raj Chen\]\]/);
  assert.match(fs.readFileSync(path.join(f.dir, "people", "raj-chen.md"), "utf8"), /\[\[sources\/documents-projects-apollo-notes-meeting\|Meeting\]\]/);
  // "Alex" could be either Alex, so it stays on its own.
  for (const expected of ["people/alex.md", "people/alex-stone.md", "people/alex-reed.md"]) assert.ok(written.includes(expected), `missing ${expected}`);
  // Tools and roles are never people.
  for (const absent of ["people/codex.md", "people/claude.md"]) assert.ok(!written.includes(absent), `${absent} is a tool, not a person`);
  for (const word of ["Codex", "claude", "Assistant", "Support Team", "ChatGPT", "Admin"]) assert.equal(brain.looksLikeName(word, "person"), null, word);
  assert.equal(brain.looksLikeName("Claude Monet", "person"), "Claude Monet");
  assert.equal(brain.looksLikeName("Support Team", "company"), "Support Team");
  assert.equal(cli(f, ["status", "--root", f.root]).json.brokenWikilinks, 0);
});

test("status and graph show the mix of notes, and say when the assistant's pass is still to come", (t) => {
  const f = workspace(t);
  for (let index = 0; index < 40; index += 1) fs.mkdirSync(f.docs, { recursive: true }) || fs.writeFileSync(path.join(f.docs, `flat-${index}.txt`), `Flat ${index}\n\nJust text.\n`);
  for (const stale of ["acme-launch", "people", "clients"]) fs.rmSync(path.join(f.docs, stale), { recursive: true });
  assert.equal(cli(f, ["build", "--root", f.root, "--from", f.docs, "--pace-ms", "0"]).status, 0);
  const report = cli(f, ["status", "--root", f.root]);
  assert.deepEqual(report.json.byType, { topics: 1, projects: 0, companies: 0, people: 0, sources: 41 });
  assert.match(report.json.hint, /come from the assistant's `brain add` pass/);
  assert.match(cli(f, ["graph", "--root", f.root]).json.hint, /brain add/);
  const added = cli(f, ["add", "--root", f.root, "--json", "-", "--pace-ms", "0"], {}, JSON.stringify(["One", "Two", "Three"].map((name) => ({ type: "person", title: `${name} Person`, relations: [{ type: "related", target: "sources/documents-flat-0" }] }))));
  assert.equal(added.json.written, 3);
  assert.equal(cli(f, ["status", "--root", f.root]).json.hint, undefined, "three of 45 is over five percent");
});

test("only the Atelier inside the install is ever run", (t) => {
  const f = workspace(t);
  fakeAtelier(f, f.bin); // a program called atelier on PATH, outside the install
  assert.equal(cli(f, ["init", "--root", f.root]).json.atelier, "missing");
  assert.equal(cli(f, ["build", "--root", f.root, "--from", f.docs, "--pace-ms", "0"]).status, 0);
  const graphed = cli(f, ["graph", "--root", f.root]);
  assert.equal(graphed.json.degraded, true);
  assert.equal(graphed.json.atelier.present, false);
  assert.equal(fs.existsSync(path.join(f.dir, "atelier.project.json")), false);
  assert.equal(cli(f, ["status", "--root", f.root]).json.atelier, "missing");
});
