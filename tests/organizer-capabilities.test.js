"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { index, migrate } = require("../lib/organizer");
const { sqlite, quote } = require("../lib/db");
function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "organizer-caps-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const dir = path.join(base, "code"), workspace = path.join(base, "workspace"), dbPath = path.join(workspace, "myos-brain.db");
  fs.mkdirSync(dir); fs.mkdirSync(workspace);
  const write = (name, content) => { const file = path.join(dir, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };
  return { base, dir, workspace, dbPath, write };
}
test("same-basename skills retain unique path IDs and truthful source-authored use_when", t => {
  const f = fixture(t);
  f.write("content-studio/first/skill/SKILL.md", "---\nname: First capability\ndescription: Render supplied presentation slides.\nuse_when:\n  - Render a presentation from supplied slides\n---\n# First\n");
  f.write("content-studio/second/skill/SKILL.md", "---\nname: Second capability\ndescription: Export the supplied newsletter.\n---\n# Second\n");
  f.write("demo.recipe.json", JSON.stringify({ id: "demo", description: "Actual recipe description", "when-to-use": ["Explicit recipe use"] }));
  f.write("demo.workflow.json", JSON.stringify({ id: "demo", description: "Actual workflow description" }));
  index(f);
  const rows = sqlite(f.dbPath, "SELECT * FROM capabilities ORDER BY id", true);
  const skills = rows.filter(row => row.type === "skill");
  assert.equal(skills.length, 2);
  assert.notEqual(skills[0].id, skills[1].id);
  const output = JSON.parse(fs.readFileSync(path.join(f.workspace, "capabilities-index.json")));
  const first = output.capabilities.find(row => row.source_path.includes("first/skill"));
  const second = output.capabilities.find(row => row.source_path.includes("second/skill"));
  assert.deepEqual(first.use_when, ["Render a presentation from supplied slides"]);
  assert.deepEqual(second.use_when, ["Export the supplied newsletter."]);
  assert.ok(first.aliases.includes("skill")); assert.ok(first.aliases.includes("skill:skill"));
  assert.deepEqual(output.capabilities.find(row => row.id === "recipe:demo").use_when, ["Explicit recipe use"]);
  assert.deepEqual(output.capabilities.find(row => row.id === "workflow:demo").use_when, ["Actual workflow description"]);
  index(f);
  assert.equal(sqlite(f.dbPath, "SELECT count(*) n FROM skills", true)[0].n, 2);
});
test("legacy skill IDs migrate customer metadata and references after a real SQLite snapshot", t => {
  const f = fixture(t), source = "content-studio/skill/SKILL.md";
  f.write(source, "---\ndescription: Source description\n---\n# Skill\n");
  f.write("customer.recipe.json", JSON.stringify({ id: "customer", description: "Customer recipe" }));
  migrate(f.dbPath);
  sqlite(f.dbPath, `INSERT INTO recipes VALUES('recipe:customer','customer.recipe.json','Customer recipe','1');
    INSERT INTO recipe_capabilities VALUES('recipe:customer','skill:skill');
    INSERT INTO skills VALUES('skill:skill',${quote(source)},'Customer skill description','1');
    INSERT INTO capabilities VALUES('skill:skill','skill','worker_skill',${quote(source)},'Customer capability description',77,'9');
    INSERT INTO capability_aliases VALUES('skill:skill','customer alias');
    INSERT INTO capability_use_when VALUES('skill:skill','Customer use condition');
    INSERT INTO capability_avoid_when VALUES('skill:skill','Customer avoid condition');
    INSERT INTO capability_sources VALUES('skill:skill',${quote(source)});
    INSERT INTO fastpaths(intent,status,capability_id) VALUES('customer-intent','stable','skill:skill');
    INSERT INTO capabilities VALUES('customer:foreign','skill','worker_skill','customer-owned.md','Foreign row',88,'1');`);
  f.write("customer-owned.md", "Foreign source");
  index(f);
  const migrated = sqlite(f.dbPath, "SELECT * FROM capabilities WHERE type='skill' AND id != 'customer:foreign'", true);
  assert.equal(migrated.length, 1); assert.notEqual(migrated[0].id, "skill:skill");
  assert.equal(sqlite(f.dbPath, "SELECT description FROM skills", true)[0].description, "Customer skill description");
  assert.equal(migrated[0].priority, 77);
  assert.equal(migrated[0].description, "Customer capability description");
  assert.equal(migrated[0].version, "9");
  const newId = migrated[0].id;
  assert.equal(sqlite(f.dbPath, "SELECT capability_id FROM recipe_capabilities WHERE recipe_id='recipe:customer'", true)[0].capability_id, newId);
  assert.ok(sqlite(f.dbPath, `SELECT * FROM capability_sources WHERE capability_id=${quote(newId)} AND source_path=${quote(source)}`, true).length);
  for (const [table,value] of [["capability_aliases","customer alias"], ["capability_use_when","Customer use condition"], ["capability_avoid_when","Customer avoid condition"]]) {
    assert.ok(sqlite(f.dbPath, `SELECT * FROM ${table} WHERE capability_id=${quote(newId)} AND value=${quote(value)}`, true).length);
  }
  assert.equal(sqlite(f.dbPath, "SELECT capability_id FROM fastpaths WHERE intent='customer-intent'", true)[0].capability_id, newId);
  assert.equal(sqlite(f.dbPath, "SELECT count(*) n FROM capabilities WHERE id='customer:foreign'", true)[0].n, 1);
  const snapshots = fs.readdirSync(f.workspace).filter(name => name.includes("skill-id-migration") && name.endsWith(".db"));
  assert.equal(snapshots.length, 1);
  assert.equal(sqlite(path.join(f.workspace, snapshots[0]), "SELECT priority FROM capabilities WHERE id='skill:skill'", true)[0].priority, 77);
  f.write(source, "---\ndescription: Revised source description\n---\n");
  index(f);
  assert.deepEqual(sqlite(f.dbPath, `SELECT value FROM capability_use_when WHERE capability_id=${quote(newId)} ORDER BY value`, true).map(row => row.value), ["Customer use condition", "Revised source description"]);
  assert.equal(fs.readdirSync(f.workspace).filter(name => name.includes("skill-id-migration") && name.endsWith(".db")).length, 1);
  assert.equal(sqlite(f.dbPath, `SELECT priority FROM capabilities WHERE id=${quote(newId)}`, true)[0].priority, 77);
});
test("an unrelated legacy basename capability is retained rather than reassigned", t => {
  const f = fixture(t);
  f.write("one/skill/SKILL.md", "---\ndescription: One skill\n---\n");
  f.write("foreign.md", "Foreign source"); migrate(f.dbPath);
  sqlite(f.dbPath, "INSERT INTO capabilities VALUES('skill:skill','skill','worker_skill','foreign.md','Customer foreign metadata',99,'1'); INSERT INTO capability_aliases VALUES('skill:skill','foreign alias');");
  index(f);
  assert.equal(sqlite(f.dbPath, "SELECT source_path FROM capabilities WHERE id='skill:skill'", true)[0].source_path, "foreign.md");
  assert.equal(sqlite(f.dbPath, "SELECT count(*) n FROM capabilities WHERE type='skill'", true)[0].n, 2);
});

test("source routing hints are bounded, and source descriptions can refresh after indexing", t => {
  const f = fixture(t);
  f.write("tools/one/SKILL.md", "---\ndescription: Original authored description\n---\n");
  f.write("package.json", JSON.stringify({ name: "demo", description: "Run the authored project tools", use_when: ["x".repeat(900), ...Array.from({length: 30}, (_,i) => `Actual condition ${i}`)] }));
  f.write("agent-registry.json", JSON.stringify({ agents: [{ id: "demo", description: "Actual agent role", use_when: "Explicit agent use" }] }));
  index(f);
  f.write("tools/one/SKILL.md", "---\ndescription: Updated authored description\n---\n");
  index(f);
  const output = JSON.parse(fs.readFileSync(path.join(f.workspace, "capabilities-index.json")));
  assert.equal(output.capabilities.find(row => row.type === "skill").description, "Updated authored description");
  assert.deepEqual(output.capabilities.find(row => row.type === "skill").use_when, ["Updated authored description"]);
  const project = output.capabilities.find(row => row.id === "capability:demo");
  assert.equal(project.use_when.length, 16);
  assert.equal(Math.max(...project.use_when.map(value => value.length)), 500);
  assert.deepEqual(output.capabilities.find(row => row.id === "agent:demo").use_when, ["Explicit agent use"]);
});

test("folded skill metadata stays truthful and punctuation-distinct paths do not collide", t => {
  const f = fixture(t);
  f.write("tools/one-two/SKILL.md", "---\ndescription: >-\n  Render supplied slides\n  with the approved template.\nwhen-to-use: |\n  Render a supplied presentation\n---\n");
  f.write("tools/one_two/SKILL.md", "---\ndescription: Other authored description\n---\n");
  index(f);
  const output = JSON.parse(fs.readFileSync(path.join(f.workspace, "capabilities-index.json")));
  assert.equal(output.capabilities.filter(row => row.type === "skill").length, 2);
  const folded = output.capabilities.find(row => row.source_path.includes("one-two/"));
  assert.equal(folded.description, "Render supplied slides with the approved template.");
  assert.deepEqual(folded.use_when, ["Render a supplied presentation"]);
});
test("a legacy skill row cannot authorize moving a foreign legacy capability", t => {
  const f = fixture(t), source = "one/skill/SKILL.md";
  f.write(source, "---\ndescription: One source\n---\n"); f.write("foreign.md", "Customer foreign source");
  migrate(f.dbPath);
  sqlite(f.dbPath, `INSERT INTO skills VALUES('skill:skill',${quote(source)},'Customer skills metadata','7'); INSERT INTO capabilities VALUES('skill:skill','skill','worker_skill','foreign.md','Customer foreign capability',99,'9'); INSERT INTO capability_aliases VALUES('skill:skill','foreign alias');`);
  index(f);
  assert.deepEqual(sqlite(f.dbPath, "SELECT source_path,description,priority,version FROM capabilities WHERE id='skill:skill'", true), [{ source_path: "foreign.md", description: "Customer foreign capability", priority: 99, version: "9" }]);
  assert.equal(sqlite(f.dbPath, "SELECT count(*) n FROM capability_aliases WHERE capability_id='skill:skill' AND value='foreign alias'", true)[0].n, 1);
  assert.deepEqual(sqlite(f.dbPath, "SELECT description,version FROM skills", true), [{ description: "Customer skills metadata", version: "7" }]);
});
test("npm script names never become capability aliases, and an older index loses them", t => {
  const f = fixture(t);
  f.write("meta-ads/package.json", JSON.stringify({ name: "meta-ads-agent", description: "Meta ads", bin: { "meta-ads": "src/index.js" }, scripts: { draft: "node d.js", send: "node s.js", start: "node a.js", status: "node b.js", doctor: "node c.js" } }));
  f.write("slack/package.json", JSON.stringify({ name: "slack-agent", description: "Slack", scripts: { send: "node s.js", "slack-agent": "node x.js" } }));
  migrate(f.dbPath);
  // An index written by the earlier organizer, which added every script name.
  for (const value of ["draft", "send", "start", "status", "doctor", "customer alias"]) sqlite(f.dbPath, `INSERT INTO capability_aliases VALUES('capability:meta-ads-agent',${quote(value)});`);
  index(f);
  const output = JSON.parse(fs.readFileSync(path.join(f.workspace, "capabilities-index.json")));
  const meta = output.capabilities.find(row => row.id === "capability:meta-ads-agent");
  const slack = output.capabilities.find(row => row.id === "capability:slack-agent");
  for (const generic of ["draft", "send", "start", "status", "doctor"]) {
    assert.ok(!meta.aliases.includes(generic), `meta-ads keeps no "${generic}" alias`);
    assert.ok(!slack.aliases.includes(generic), `slack keeps no "${generic}" alias`);
  }
  assert.ok(meta.aliases.includes("meta-ads-agent")); assert.ok(meta.aliases.includes("meta-ads"));
  assert.ok(slack.aliases.includes("slack-agent"), "a script named like the package keeps its alias");
  assert.ok(meta.aliases.includes("customer alias"), "aliases the customer added stay");
});
