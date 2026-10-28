"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pullConnectors } = require("../lib/connector-pull");
const brain = require("../lib/brain");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "history-pages-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, sources: ["mail"], account: ["fixture", "invalid.example"].join("@"), history: true, since: "2026-01-01", until: "2026-10-01", max: 1, maxPages: 10, maxItems: 10, detail: "full", paceMs: 0 };
}
function thread(id) { return { id: String(id), subject: `History topic ${id}`, date: "2026-09-01", messageCount: 1 }; }
function pages(calls, fail) {
  return { mail: { searchThreads: async args => {
    calls.push(args);
    const page = args.pageToken ? Number(args.pageToken) : 1;
    if (fail?.(page)) { const error = new Error("Quota deferred"); error.retryDeferred = true; error.nextAttemptAt = "2026-10-01T12:00:00Z"; throw error; }
    return { items: [thread(page)], nextPageToken: page < 3 ? String(page + 1) : null, complete: page === 3 };
  } } };
}
function noteFiles(root) {
  const dir = brain.brainDir(root);
  const files = [];
  const walk = folder => { if (!fs.existsSync(folder)) return; for (const row of fs.readdirSync(folder, { withFileTypes: true })) { const file = path.join(folder, row.name); if (row.isDirectory()) walk(file); else if (row.name.endsWith(".md") && fs.readFileSync(file, "utf8").includes("History topic")) files.push(file); } };
  walk(dir); return files;
}

test("three real note pages complete for exact window without tidying earlier pages", async t => {
  const options = fixture(t); const calls = [];
  const result = await pullConnectors({ ...options, adapters: pages(calls) });
  assert.equal(result.sources.mail.state, "complete");
  assert.equal(result.sources.mail.totalPages, 3);
  assert.deepEqual(calls.map(row => row.pageToken), [null, "2", "3"]);
  assert.ok(calls.every(row => row.after === "2026-01-01" && row.to === "2026-10-01"));
  assert.equal(noteFiles(options.root).length, 3);
  const checkpoint = path.join(options.root, "state", "brain-history", "mail.json");
  assert.equal(fs.statSync(checkpoint).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(checkpoint, "utf8").includes(options.account), false);
});

test("quota and cap checkpoints resume and preserve manual changes", async t => {
  const options = fixture(t); const calls = [];
  const first = await pullConnectors({ ...options, adapters: pages(calls, page => page === 2) });
  assert.equal(first.sources.mail.state, "deferred");
  assert.equal(first.sources.mail.nextAttemptAt, "2026-10-01T12:00:00Z");
  const note = noteFiles(options.root)[0];
  fs.appendFileSync(note, "\nCustomer manual addition\n");
  const second = await pullConnectors({ ...options, resume: true, maxPages: 1, adapters: pages(calls) });
  assert.equal(second.sources.mail.state, "capped");
  assert.equal(second.sources.mail.totalPages, 2);
  const final = await pullConnectors({ ...options, resume: true, adapters: pages(calls) });
  assert.equal(final.sources.mail.complete, true);
  assert.equal(noteFiles(options.root).length, 3);
  assert.match(fs.readFileSync(note, "utf8"), /Customer manual addition/);
  assert.deepEqual(calls.map(row => row.pageToken), [null, "2", "2", "3"]);
});

test("changed account or query refuses resume before reads, and explicit restart is allowed", async t => {
  const options = fixture(t); const calls = [];
  await pullConnectors({ ...options, maxPages: 1, adapters: pages(calls) });
  for (const patch of [{ account: "another" }, { detail: "metadata" }, { until: "2026-09-30" }]) {
    const result = await pullConnectors({ ...options, ...patch, resume: true, adapters: pages(calls) });
    assert.equal(result.sources.mail.state, "failed");
    assert.match(result.sources.mail.reason, /differs/);
  }
  assert.equal(calls.length, 1);
  const restarted = await pullConnectors({ ...options, restartHistory: true, adapters: pages(calls) });
  assert.equal(restarted.sources.mail.complete, true);
});

test("crash after writes repeats page safely; repeated tokens fail and keep cursor", async t => {
  const options = fixture(t);
  let failOnce = true;
  const crashing = { mail: { searchThreads: async () => ({ items: [thread(1)], nextPageToken: "2", complete: false }) } };
  const result = await pullConnectors({ ...options, adapters: crashing, onNote: () => { if (failOnce) { failOnce = false; throw new Error("fixture interruption"); } } });
  assert.equal(result.sources.mail.state, "failed");
  const resumed = await pullConnectors({ ...options, resume: true, adapters: crashing });
  assert.equal(resumed.sources.mail.state, "failed");
  assert.match(resumed.sources.mail.reason, /repeated/);
  assert.equal(noteFiles(options.root).length, 1);
});

test("history plan writes no checkpoint or notes and requires fixed window", async t => {
  const options = fixture(t); let calls = 0;
  const result = await pullConnectors({ ...options, plan: true, adapters: { mail: { searchThreads: () => { calls++; } } } });
  assert.equal(result.sources.mail.state, "planned");
  assert.equal(calls, 0);
  assert.deepEqual(fs.readdirSync(options.root), []);
  await assert.rejects(pullConnectors({ ...options, until: undefined }), /fixed/);
});

test("item budget spans resumes; changing restart binding cannot reuse old account cursor", async t => {
  const options = fixture(t); const calls = [];
  await pullConnectors({ ...options, maxPages: 1, maxItems: 1, adapters: pages(calls) });
  const capped = await pullConnectors({ ...options, resume: true, maxItems: 1, adapters: pages(calls) });
  assert.equal(capped.sources.mail.state, "capped");
  assert.equal(calls.length, 1);
  await pullConnectors({ ...options, account: "another", restartHistory: true, maxPages: 1, adapters: pages(calls) });
  const refused = await pullConnectors({ ...options, resume: true, adapters: pages(calls) });
  assert.equal(refused.sources.mail.state, "failed");
  assert.match(refused.sources.mail.reason, /differs/);
});

test("same person's earlier page evidence and relations survive later pages", async t => {
  const options = fixture(t); const calls = [];
  const adapter = pages(calls);
  const original = adapter.mail.searchThreads;
  adapter.mail.searchThreads = async args => {
    const data = await original(args);
    data.items[0].from = `Fixture Person <${["fixture", "invalid.example"].join("@")}>`;
    return data;
  };
  const result = await pullConnectors({ ...options, adapters: adapter });
  assert.equal(result.sources.mail.complete, true);
  const person = fs.readFileSync(path.join(brain.brainDir(options.root), "people", "fixture-person.md"), "utf8");
  assert.equal((person.match(/history-page-/g) || []).length >= 3, true);
  assert.ok(noteFiles(options.root).length >= 3);
});

test("forget archives the old cursor; resume cannot falsely report complete", async t => {
  const options = fixture(t); const calls = [];
  await pullConnectors({ ...options, adapters: pages(calls) });
  await pullConnectors({ ...options, history: false, forget: true, adapters: pages(calls) });
  const resumed = await pullConnectors({ ...options, resume: true, adapters: pages(calls) });
  assert.equal(resumed.sources.mail.state, "failed");
  assert.match(resumed.sources.mail.reason, /No history checkpoint/);
});

test("calendar pages in the same month preserve every event digest", async t => {
  const options = fixture(t);
  const adapters = { calendar: { listEvents: async ({ pageToken }) => ({ items: [{ summary: pageToken ? "Second meeting" : "First meeting", start: { dateTime: "2026-09-02T10:00:00Z" } }], nextPageToken: pageToken ? null : "next", complete: Boolean(pageToken) }) } };
  const result = await pullConnectors({ ...options, sources: ["calendar"], adapters });
  assert.equal(result.sources.calendar.complete, true);
  const sources = path.join(brain.brainDir(options.root), "sources");
  const all = fs.readdirSync(sources).map(file => fs.readFileSync(path.join(sources, file), "utf8")).join("\n");
  assert.match(all, /First meeting/);
  assert.match(all, /Second meeting/);
});
