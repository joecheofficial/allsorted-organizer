"use strict";

// Offline tests for the connector pull and the brain refresh. Fake adapters and
// a fixture message database only: no account, no network, temporary folders.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync, execFileSync } = require("node:child_process");

const brain = require("../lib/brain");
const pull = require("../lib/connector-pull");
const refresher = require("../lib/refresh");
const CLI = path.resolve(__dirname, "..", "bin", "brain.js");
const NOW = "2026-10-05T12:00:00Z";
const DAY = 86400;
const at = (daysAgo) => Math.floor(new Date(NOW).getTime() / 1000) - daysAgo * DAY;
// Written in pieces so this file never itself looks like it holds a key.
// Addresses and chat ids are joined at run time, so the file holds none.
const at_ = (user, host) => [user, host].join("@");
const FAKE_PASSWORD = ["hunter", "2", "Zq", "9x"].join("");

function root(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-pull-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function allText(dir) {
  const out = [];
  const walk = (folder) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(fs.readFileSync(full, "utf8"));
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out.join("\n");
}

function threads() {
  return [
    { id: "t1", from: `Dana Lee <${at_("dana", "example.com")}>`, subject: "Launch plan", date: "2026-10-01T09:00:00Z", messageCount: 3, snippet: "Here is the draft for the launch." },
    { id: "t2", from: `Dana Lee <${at_("dana", "example.com")}>`, subject: "Invoice question", date: "2026-09-28T09:00:00Z", messageCount: 1, snippet: `the portal password is ${FAKE_PASSWORD}` },
    { id: "t3", from: `Shop <${at_("no-reply", "shop.example")}>`, subject: "Your verification code", date: "2026-09-27T09:00:00Z", messageCount: 1, snippet: "Your code is 482913" },
  ];
}

function charges() {
  return [
    { id: "ch_1", created: at(3), amount: 12000, amount_refunded: 0, currency: "usd", status: "succeeded", billing_details: { name: "Avery Stone", email: at_("avery", "example.com"), address: { line1: "1 Hidden Street" } }, payment_method_details: { card: { last4: "4242" } }, description: "Consultation" },
    { id: "ch_2", created: at(40), amount: 5000, amount_refunded: 5000, currency: "usd", status: "succeeded", billing_details: { name: "Avery Stone" } },
    { id: "ch_3", created: at(5), amount: 900, amount_refunded: 0, currency: "usd", status: "failed", billing_details: {} },
  ];
}

function events() {
  return [
    { summary: "Planning with Dana", start: { dateTime: "2026-10-02T10:00:00Z" }, description: `dial-in passcode ${FAKE_PASSWORD}`, attendees: [{ email: at_("me", "example.com"), self: true }, { email: at_("dana", "example.com"), displayName: "Dana Lee" }] },
  ];
}

function fakeAdapters(overrides = {}) {
  const calls = [];
  return {
    calls,
    mail: { async searchThreads(args) { calls.push(["mail", args]); return overrides.threads || threads(); } },
    calendar: { async listEvents(args) { calls.push(["calendar", args]); return overrides.events || events(); } },
    payments: { async listCharges(args) { calls.push(["payments", args]); return overrides.charges || charges(); } },
    messages: { async listMessages(args) { calls.push(["messages", args]); return overrides.messages || []; } },
  };
}

function messageDb(dir) {
  const PERSON = at_("15551234567", "s.whatsapp.net");
  const GROUP = at_("120363000000000001", "g.us");
  const OLD = at_("15559999999", "s.whatsapp.net");
  const file = path.join(dir, "whatsapp", "server", "messages.db");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const rows = [
    ["m1", PERSON, 0, "See you at the studio on Friday", at(2) * 1000],
    ["m2", PERSON, 1, "Great, bringing the samples", at(2) * 1000 + 5000],
    ["m3", PERSON, 0, "Your login code is 771234", at(1) * 1000],
    ["m4", GROUP, 0, "Team update is posted", at(4) * 1000],
    ["m5", OLD, 0, "Old message", at(90) * 1000],
  ];
  const values = rows.map(([id, jid, me, text, ts]) => `('${id}','${jid}',${me},'${text.replace(/'/g, "''")}',${ts})`).join(",");
  execFileSync("sqlite3", [file, `CREATE TABLE conversations (jid TEXT PRIMARY KEY, name TEXT, push_name TEXT);
CREATE TABLE messages (id TEXT PRIMARY KEY, jid TEXT NOT NULL, from_me INTEGER NOT NULL, sender TEXT, text TEXT, timestamp INTEGER NOT NULL);
INSERT INTO conversations VALUES ('${PERSON}','Sol Park',NULL),('${GROUP}','Studio team',NULL);
INSERT INTO messages (id,jid,from_me,text,timestamp) VALUES ${values};`]);
  return file;
}

test("adapter guards let only read calls through", async () => {
  const seen = [];
  const gog = pull.readOnlyGog((input, command) => { seen.push([input.account, command]); return { status: "ok", data: [] }; }, at_("me", "example.com"));
  assert.deepEqual(gog(["gmail", "search", "after:2026/09/01", "--max", "5"]), []);
  assert.throws(() => gog(["gmail", "send", "--to", at_("x", "example.com")]), /not a read call/);
  assert.throws(() => gog(["calendar", "create", "x"]), /not a read call/);
  assert.equal(seen.length, 1);
  const methods = [];
  const stripe = pull.readOnlyStripe(async (method, endpoint) => { methods.push([method, endpoint]); return { data: [] }; });
  await stripe("/v1/charges", { limit: 1 });
  assert.throws(() => stripe("/v1/payment_links", {}), /not an allowed read/);
  assert.throws(() => stripe("/v1/refunds", {}), /not an allowed read/);
  assert.deepEqual(methods, [["GET", "/v1/charges"]]);
});

test("message filter leaves out codes, passwords and keys whole", () => {
  assert.equal(pull.safeSnippet("Your verification code is 482913"), null);
  assert.equal(pull.safeSnippet(`password: ${FAKE_PASSWORD}`), null);
  assert.equal(pull.safeSnippet("Reset your password here"), null);
  assert.equal(pull.safeSnippet(`api_key=${"sk_" + "live_" + "abcdefghijklmnop1234"}`), null);
  assert.equal(pull.safeSnippet("Account 12345678 is ready"), null);
  assert.equal(pull.safeSnippet("Your WhatsApp code: 482-193"), null);
  assert.equal(pull.safeSnippet("Your Uber code is 4821"), null);
  assert.equal(pull.safeSnippet("Use 4821 to log in"), null);
  assert.equal(pull.safeSnippet("card 4242 4242 4242 4242 exp 12/28"), null);
  assert.equal(pull.safeSnippet("Lunch on Friday?"), "Lunch on Friday?");
  assert.equal(pull.safeSnippet("We sold 2026 units"), "We sold 2026 units");
});

test("nothing is read until a source is opted in", async (t) => {
  const dir = root(t);
  const adapters = fakeAdapters();
  const result = await pull.pullConnectors({ root: dir, adapters, now: NOW });
  assert.equal(result.ok, true);
  assert.match(result.message, /No source is opted in/);
  assert.equal(adapters.calls.length, 0);
  assert.equal(fs.existsSync(path.join(dir, "brain")), false);
});

test("--plan reads, writes nothing and makes no folder", async (t) => {
  const dir = root(t);
  const result = await pull.pullConnectors({ root: dir, sources: ["mail", "payments"], adapters: fakeAdapters(), plan: true, now: NOW, verbose: true });
  assert.equal(result.ok, true);
  assert.ok(result.sources.mail.planned.includes("people/dana-lee.md"));
  assert.ok(result.sources.payments.planned.includes("sources/payments-2026-10.md"));
  assert.equal(fs.existsSync(path.join(dir, "brain")), false);
  assert.equal(fs.existsSync(path.join(dir, "state")), false);
});

test("pull writes linked, filtered notes with provenance and re-runs idempotently", async (t) => {
  const dir = root(t);
  messageDb(dir);
  const adapters = { ...fakeAdapters(), messages: pull.defaultAdapters(dir).messages };
  const options = { root: dir, sources: ["mail", "calendar", "payments", "whatsapp"], adapters, now: NOW, paceMs: 0, days: 30 };
  const first = await pull.pullConnectors(options);
  assert.equal(first.ok, true, JSON.stringify(first.sources));
  const brainDir = path.join(dir, "brain");
  const dana = fs.readFileSync(path.join(brainDir, "people", "dana-lee.md"), "utf8");
  assert.match(dana, /Launch plan/);
  assert.match(dana, /pulled\/mail/);
  assert.match(dana, /\[\[sources\/mail-launch-plan-/);
  assert.ok(fs.existsSync(path.join(brainDir, "sources", "payments-2026-10.md")));
  assert.ok(fs.existsSync(path.join(brainDir, "sources", "payments-2026-08.md")), "every month the source returns gets its own note");
  assert.ok(fs.existsSync(path.join(brainDir, "people", "avery-stone.md")));
  assert.ok(fs.existsSync(path.join(brainDir, "sources", "calendar-2026-10.md")));
  assert.match(fs.readFileSync(path.join(brainDir, "sources", "calendar-2026-10.md"), "utf8"), /\[\[people\/dana-lee/);
  const sol = fs.readFileSync(path.join(brainDir, "people", "sol-park.md"), "utf8");
  assert.match(sol, /See you at the studio/);
  assert.match(sol, /left out because/);
  assert.ok(fs.existsSync(path.join(brainDir, "topics", "whatsapp-group-studio-team.md")));
  assert.equal(fs.existsSync(path.join(brainDir, "people", "old-message.md")), false);
  const text = allText(brainDir);
  for (const banned of [FAKE_PASSWORD, "482913", "771234", "15551234567", "4242", "Hidden Street", at_("no-reply", "shop"), "dial-in"]) assert.ok(!text.includes(banned), `${banned} must never reach the brain`);
  const state = JSON.parse(fs.readFileSync(path.join(brainDir, brain.STATE_FILE), "utf8"));
  assert.equal(state.notes["people/dana-lee.md"].origin, "pull");
  assert.equal(state.notes["people/dana-lee.md"].pull, "mail");
  assert.equal(state.notes["people/sol-park.md"].pull, "messages");
  const second = await pull.pullConnectors(options);
  for (const entry of Object.values(second.sources)) {
    assert.equal(entry.written, 0);
    assert.equal(entry.updated, 0);
    assert.equal(entry.removed, 0);
  }
  assert.equal(brain.graph({ root: dir }).brokenWikilinks, 0);
});

test("tidy removes what a source no longer produces, keeps edits, and forget removes the source", async (t) => {
  const dir = root(t);
  const options = { root: dir, sources: ["mail"], adapters: fakeAdapters(), now: NOW, paceMs: 0, verbose: true };
  await pull.pullConnectors(options);
  const brainDir = path.join(dir, "brain");
  const invoice = fs.readdirSync(path.join(brainDir, "sources")).find((name) => name.startsWith("mail-invoice-question-"));
  const launch = fs.readdirSync(path.join(brainDir, "sources")).find((name) => name.startsWith("mail-launch-plan-"));
  assert.ok(invoice && launch);
  const narrowed = await pull.pullConnectors({ ...options, adapters: fakeAdapters({ threads: [threads()[2]] }) });
  for (const gone of [`sources/${invoice}`, `sources/${launch}`, "people/dana-lee.md"]) assert.ok(narrowed.sources.mail.removedNotes.includes(gone), gone);
  assert.equal(fs.existsSync(path.join(brainDir, "people", "dana-lee.md")), false);
  await pull.pullConnectors(options);
  fs.appendFileSync(path.join(brainDir, "sources", launch), "\nMy own note.\n");
  const forgotten = await pull.pullConnectors({ ...options, forget: true });
  assert.equal(forgotten.sources.mail.state, "forgotten");
  assert.ok(forgotten.sources.mail.removed >= 1);
  assert.ok(fs.existsSync(path.join(brainDir, "sources", launch)), "an edited note is never tidied away");
  assert.ok(forgotten.sources.mail.kept.includes(`sources/${launch}`));
  assert.equal(brain.graph({ root: dir }).brokenWikilinks, 0);
});

test("a pull never takes over a note someone else wrote", async (t) => {
  const dir = root(t);
  await brain.add({ root: dir, items: [{ type: "person", title: "Dana Lee", summary: "Our designer.", body: "Written by the assistant." }], paceMs: 0 });
  const result = await pull.pullConnectors({ root: dir, sources: ["mail"], adapters: fakeAdapters(), now: NOW, paceMs: 0, verbose: true });
  assert.deepEqual(result.sources.mail.redirected, [{ from: "people/dana-lee.md", to: "sources/mail-dana-lee.md" }]);
  const own = fs.readFileSync(path.join(dir, "brain", "people", "dana-lee.md"), "utf8");
  assert.match(own, /Written by the assistant/);
  assert.match(fs.readFileSync(path.join(dir, "brain", "sources", "mail-dana-lee.md"), "utf8"), /\[\[people\/dana-lee/);
});

test("a cap that cuts in warns and tidies nothing", async (t) => {
  const dir = root(t);
  await pull.pullConnectors({ root: dir, sources: ["mail"], adapters: fakeAdapters(), now: NOW, paceMs: 0 });
  const capped = await pull.pullConnectors({ root: dir, sources: ["mail"], adapters: fakeAdapters({ threads: threads().slice(2) }), now: NOW, paceMs: 0, max: 1 });
  assert.equal(capped.sources.mail.complete, false);
  assert.match(capped.sources.mail.warning, /LIMIT REACHED/);
  assert.equal(capped.sources.mail.removed, 0);
  assert.ok(fs.existsSync(path.join(dir, "brain", "people", "dana-lee.md")));
});

test("window and cap are bounded and an unknown source is refused", () => {
  const window = pull.windowFor({ days: 9999 }, new Date(NOW));
  assert.equal(window.days, pull.MAX_DAYS);
  assert.throws(() => pull.windowFor({ since: "yesterday" }), /date like/);
  assert.throws(() => pull.chosenSources({ sources: ["dropbox"] }, {}), /Unknown source/);
  assert.deepEqual(pull.chosenSources({ sources: ["email", "stripe", "whatsapp", "google-drive", "resend"] }, {}), ["mail", "payments", "messages", "drive", "sent"]);
});

test("a source that is not installed is skipped, not failed", async (t) => {
  const dir = root(t);
  const result = await pull.pullConnectors({ root: dir, sources: ["payments", "mail"], now: NOW, account: at_("me", "example.com") });
  assert.equal(result.ok, true);
  assert.equal(result.sources.payments.state, "skipped");
  assert.equal(result.sources.mail.state, "skipped");
});

test("refresh runs registered passes with provenance; outside recipes are refused", async (t) => {
  const dir = root(t);
  const recipe = path.join(dir, "catalog", "products.js");
  fs.mkdirSync(path.dirname(recipe), { recursive: true });
  fs.writeFileSync(recipe, `module.exports.runRecipe = async () => ({ notes: [{ type: "topic", title: "Product Alpha", summary: "A product.", body: "Sold online." }] });\n`);
  const outside = path.join(root(t), "evil.js");
  fs.writeFileSync(outside, "module.exports.runRecipe = async () => ({ notes: [] });\n");
  pull.writeConfig(dir, { ...refresher.example(), passes: [{ name: "products", recipe: "catalog/products.js" }, { name: "outside", recipe: outside }] });
  const result = await refresher.refresh({ root: dir, now: NOW });
  const products = result.steps.find((step) => step.name === "products");
  assert.equal(products.state, "done");
  assert.equal(result.steps.find((step) => step.name === "outside").state, "failed");
  const state = JSON.parse(fs.readFileSync(path.join(dir, "brain", brain.STATE_FILE), "utf8"));
  assert.equal(state.notes["topics/product-alpha.md"].pull, "pass-products");
  assert.equal(result.steps.at(-1).step, "graph");
});

test("the refresh schedule is off by default and a scheduled run does nothing until turned on", async (t) => {
  const dir = root(t);
  const home = root(t);
  const template = refresher.schedule({ root: dir, mode: "template", home });
  assert.equal(template.enabled, false);
  assert.match(fs.readFileSync(template.template, "utf8"), /brain<\/string><string>refresh/);
  assert.equal(fs.existsSync(path.join(home, "Library", "LaunchAgents")), false);
  const idle = await refresher.refresh({ root: dir, scheduled: true });
  assert.match(idle.message, /schedule is off/);
  const commands = [];
  const on = refresher.schedule({ root: dir, mode: "on", home, platform: "darwin", run: (command, args) => { commands.push([command, ...args]); return ""; } });
  assert.equal(on.enabled, true);
  assert.ok(fs.existsSync(on.agent));
  assert.ok(commands.some((command) => command[1] === "bootstrap"));
  assert.equal(pull.readConfig(dir).schedule.enabled, true);
  const off = refresher.schedule({ root: dir, mode: "off", home, platform: "darwin", run: () => "" });
  assert.equal(off.enabled, false);
  assert.equal(fs.existsSync(on.agent), false);
});

test("command line: pull without a source reads nothing; --plan on the message database writes nothing", (t) => {
  const dir = root(t);
  const db = messageDb(dir);
  const none = spawnSync(process.execPath, [CLI, "pull", "--root", dir], { encoding: "utf8" });
  assert.equal(none.status, 0, none.stderr);
  assert.match(JSON.parse(none.stdout).message, /No source is opted in/);
  const planned = spawnSync(process.execPath, [CLI, "pull", "--root", dir, "--source", "whatsapp", "--whatsapp-db", db, "--plan", "--days", "365"], { encoding: "utf8" });
  assert.equal(planned.status, 0, planned.stderr);
  const result = JSON.parse(planned.stdout);
  assert.ok(result.sources.messages.planned >= 2, "counts, not names");
  assert.doesNotMatch(planned.stdout + planned.stderr, /sol-park|Sol Park|people\//, "no note name is printed by default");
  const verbose = spawnSync(process.execPath, [CLI, "pull", "--root", dir, "--source", "whatsapp", "--whatsapp-db", db, "--plan", "--days", "365", "--verbose"], { encoding: "utf8" });
  assert.ok(JSON.parse(verbose.stdout).sources.messages.planned.includes("people/sol-park.md"));
  assert.equal(fs.existsSync(path.join(dir, "brain")), false);
});

// The Google tool wraps fetched text in markers whose id changes on every call.
let wrapCount = 0;
function wrap(text) {
  wrapCount += 1;
  const id = `${wrapCount}f${(wrapCount * 7919).toString(16)}`;
  return `<<<EXTERNAL_UNTRUSTED_CONTENT id="${id}">>>\nSource: google_api\n---\n${text}\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="${id}">>>`;
}
function wrappedThreads() {
  return threads().map((thread) => ({ ...thread, from: wrap(thread.from), subject: wrap(thread.subject), snippet: wrap(thread.snippet) }));
}

test("untrusted-content markers are taken off, so titles and note names stay stable", async (t) => {
  const dir = root(t);
  const run = (adapters) => pull.pullConnectors({ root: dir, sources: ["mail", "calendar"], adapters, now: NOW, paceMs: 0 });
  const wrappedEvents = () => events().map((event) => ({ ...event, summary: wrap(event.summary), attendees: event.attendees.map((person) => ({ ...person, displayName: person.displayName && wrap(person.displayName) })) }));
  const first = await run({ ...fakeAdapters({ threads: wrappedThreads(), events: wrappedEvents() }) });
  assert.equal(first.ok, true);
  const text = allText(path.join(dir, "brain"));
  assert.ok(!/UNTRUSTED|google_api|Source:\s*google/i.test(text), "no marker or wrapper header reaches a note");
  assert.ok(fs.existsSync(path.join(dir, "brain", "people", "dana-lee.md")));
  const launch = fs.readdirSync(path.join(dir, "brain", "sources")).find((name) => name.startsWith("mail-launch-plan-"));
  assert.ok(launch, "the note name comes from the bare subject");
  assert.match(fs.readFileSync(path.join(dir, "brain", "sources", launch), "utf8"), /^title: "Email: Launch plan"$/m);
  assert.match(fs.readFileSync(path.join(dir, "brain", "sources", "calendar-2026-10.md"), "utf8"), /\[\[people\/dana-lee\|Dana Lee\]\]/, "the attendee links to the person note");
  assert.match(fs.readFileSync(path.join(dir, "brain", "sources", "calendar-2026-10.md"), "utf8"), /2026-10-02: Planning with Dana/);
  const second = await run({ ...fakeAdapters({ threads: wrappedThreads(), events: wrappedEvents() }) });
  for (const entry of Object.values(second.sources)) { assert.equal(entry.written, 0); assert.equal(entry.removed, 0); assert.equal(entry.updated, 0); }
});

test("--remember saves the window and cap; --forget takes the source off the remembered list", async (t) => {
  const dir = root(t);
  await assert.rejects(pull.pullConnectors({ root: dir, sources: ["mail"], adapters: fakeAdapters(), now: NOW, remember: true, max: "lots" }), /--max/);
  assert.equal(fs.existsSync(pull.configPath(dir)), false, "nothing is saved when an option is invalid");
  await pull.pullConnectors({ root: dir, sources: ["mail", "payments"], adapters: fakeAdapters(), now: NOW, paceMs: 0, remember: true, days: 14, max: 50 });
  assert.deepEqual(pull.readConfig(dir).pull, { sources: ["mail", "payments"], days: 14, max: 50 });
  const adapters = fakeAdapters();
  await pull.pullConnectors({ root: dir, adapters, now: NOW, paceMs: 0 });
  assert.equal(adapters.calls[0][1].max, 50);
  await pull.pullConnectors({ root: dir, sources: ["mail"], forget: true, now: NOW, adapters: fakeAdapters() });
  assert.deepEqual(pull.readConfig(dir).pull.sources, ["payments"]);
});

test("two items that would write the same note are counted, not silently merged", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-pull-"));
  try {
    const result = await brain.pull({ root: dir, source: "mail", items: [{ type: "person", title: "Sam Lee" }, { type: "person", title: "Sam Lee" }], plan: true });
    assert.equal(result.notes, 1);
    assert.equal(result.rejected.length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("refresh: a skipped source is degraded, --plan runs no pass, a failed schedule rolls back", async (t) => {
  const dir = root(t);
  const recipe = path.join(dir, "catalog", "pass.js");
  const marker = path.join(dir, "ran.txt");
  fs.mkdirSync(path.dirname(recipe), { recursive: true });
  fs.writeFileSync(recipe, `module.exports.runRecipe = async () => { require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x"); return { notes: [] }; };\n`);
  pull.writeConfig(dir, { ...refresher.example(), pull: { sources: ["payments"] }, passes: [{ name: "products", recipe: "catalog/pass.js" }] });
  const planned = await refresher.refresh({ root: dir, plan: true, now: NOW });
  assert.equal(planned.steps.find((step) => step.step === "pass").state, "planned");
  assert.equal(fs.existsSync(marker), false, "a plan never runs a pass recipe");
  const real = await refresher.refresh({ root: dir, now: NOW });
  const pulled = real.steps.find((step) => step.step === "pull");
  assert.equal(pulled.state, "degraded");
  assert.equal(real.degraded, true);
  const home = root(t);
  assert.throws(() => refresher.schedule({ root: dir, mode: "on", home, platform: "darwin", run: (command, args) => { if (args[0] === "bootstrap") throw new Error("denied"); return ""; } }), /could not be turned on/);
  assert.equal(fs.existsSync(path.join(home, "Library", "LaunchAgents", `${refresher.LABEL}.plist`)), false);
  assert.notEqual(pull.readConfig(dir).schedule.enabled, true);
  fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
  fs.writeFileSync(path.join(dir, "bin", "as-run"), "#!/bin/sh\nexec \"$@\"\n");
  assert.match(refresher.schedulePlist(dir, {}), /bin\/as-run<\/string><string>/, "the scheduled job runs through the install's as-run");
});

// ---------------------------------------------------------------------------
// Drive and sent email. Fixtures follow the real shapes: `gog -j --wrap-untrusted
// drive search` returns { files: [...], nextPageToken } with Drive API v3 file
// fields, `gog -j docs cat` returns the document text, and Resend's GET /emails
// returns { object: "list", has_more, data: [...] } with created_at like
// "2026-10-01 09:00:00.123456+00".
const DOC_ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-docA";
const SHEET_ID = "1ZyXwVuTsRqPoNmLkJiHgFeDcBa9876543210_-shtB";
const KEYS_ID = "1KeYsKeYsKeYsKeYsKeYsKeYsKeYsKeYs_-keysC0";
const NOTES_ID = "1NoTeSnOtEsNoTeSnOtEsNoTeSnOtEs_-notesD0";
function driveSearch() {
  return {
    files: [
      { id: DOC_ID, name: wrap("Launch plan Q4"), mimeType: "application/vnd.google-apps.document", modifiedTime: "2026-10-03T08:15:22.512Z", size: "0", webViewLink: `https://docs.google.com/document/d/${DOC_ID}/edit`, parents: ["0AFolder"], owners: [{ displayName: "Me", emailAddress: at_("me", "example.com") }] },
      { id: SHEET_ID, name: wrap("Wholesale price list"), mimeType: "application/vnd.google-apps.spreadsheet", modifiedTime: "2026-09-29T17:02:00.000Z", webViewLink: `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit` },
      { id: KEYS_ID, name: wrap("Passwords and logins"), mimeType: "application/vnd.google-apps.spreadsheet", modifiedTime: "2026-10-01T10:00:00.000Z" },
      { id: NOTES_ID, name: wrap("Supplier notes"), mimeType: "application/vnd.google-apps.document", modifiedTime: "2026-10-02T10:00:00.000Z" },
      { id: "0AFolderIdFolderIdFolder", name: wrap("Archive"), mimeType: "application/vnd.google-apps.folder", modifiedTime: "2026-10-02T10:00:00.000Z" },
    ],
    nextPageToken: "",
  };
}
const DOC_TEXT = {
  [DOC_ID]: "Launch plan\n\nWe open the new storefront on 14 October with three products and a waitlist email.",
  [NOTES_ID]: `Supplier portal\nusername: ops\npassword: ${FAKE_PASSWORD}\n`,
};
function fakeGogRuntime(dir, calls) {
  const file = path.join(dir, "google", "recipes", "runtime.js");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `"use strict";
const search = ${JSON.stringify(driveSearch())};
const texts = ${JSON.stringify(Object.fromEntries(Object.entries(DOC_TEXT).map(([id, text]) => [id, wrap(text)])))};
module.exports.runGog = (input, command) => {
  require("node:fs").appendFileSync(${JSON.stringify(calls)}, JSON.stringify([input.account, command]) + "\\n");
  if (command[0] === "drive" && command[1] === "search") return { status: "ok", data: search };
  if (command[0] === "docs" && command[1] === "cat") return { status: "ok", data: texts[command[2]] || "" };
  return { status: "error", reply: "unexpected command" };
};
`);
}
function sentPage() {
  return {
    object: "list",
    has_more: false,
    data: [
      { id: "4ef9a417-02e9-4d39-ad75-9611e0fcc33c", to: [at_("avery", "example.com")], from: `Shop <${at_("orders", "shop.example")}>`, created_at: "2026-10-03 09:12:44.674981+00", subject: "Your order has shipped", bcc: null, cc: null, reply_to: null, last_event: "delivered", scheduled_at: null },
      { id: "5ab0c512-13fa-4e4a-be86-0722f1fdd44d", to: [at_("sol", "example.com")], from: `Shop <${at_("orders", "shop.example")}>`, created_at: "2026-10-02 11:00:01.1+00", subject: "Your order has shipped", last_event: "opened" },
      { id: "6bc1d623-24ab-4f5b-cf97-1833a2aee55e", to: [at_("sol", "example.com")], from: `Shop <${at_("login", "shop.example")}>`, created_at: "2026-10-01 07:30:00+00", subject: "Your sign-in code is 771234", last_event: "delivered" },
      { id: "7cd2e734-35bc-4a6c-d0a8-2944b3bff66f", to: [at_("dana", "example.com")], from: `Shop <${at_("orders", "shop.example")}>`, created_at: "2026-09-20 15:45:10.5+00", subject: "We miss you", last_event: "bounced" },
      { id: "8de3f845-46cd-4b7d-e1b9-3a55c4c00770", to: [at_("old", "example.com")], from: `Shop <${at_("orders", "shop.example")}>`, created_at: "2026-07-01 08:00:00+00", subject: "Old newsletter", last_event: "delivered" },
    ],
  };
}
function fakeResendModule(dir) {
  const file = path.join(dir, "resend", "src", "runtime.js");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // The fake lookup reads a variable the test sets, exactly as the module does.
  fs.writeFileSync(file, `"use strict";
module.exports.BASE_URL = "https://api.resend.example";
module.exports.getApiKey = () => { if (!process.env.BRAIN_TEST_RESEND) throw new Error("Resend is not configured."); return process.env.BRAIN_TEST_RESEND; };
`);
}

test("drive: metadata notes, a short Google Docs excerpt, credential-looking files left out whole", async (t) => {
  const dir = root(t);
  const calls = path.join(dir, "gog-calls.jsonl");
  fakeGogRuntime(dir, calls);
  const result = await pull.pullConnectors({ root: dir, sources: ["drive"], account: at_("me", "example.com"), now: NOW, paceMs: 0 });
  assert.equal(result.ok, true, JSON.stringify(result.sources));
  assert.equal(result.sources.drive.state, "pulled");
  assert.equal(result.sources.drive.leftOut, 2, "the password sheet by name, the supplier doc by its text");
  const seen = fs.readFileSync(calls, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(seen.map(([, command]) => command.slice(0, 2).join(" ")), ["drive search", "docs cat", "docs cat"], "only Google Docs are opened, never the sheet");
  assert.match(seen[0][1][2], /^modifiedTime > '2026-09-05T00:00:00' and trashed = false/);
  assert.ok(seen[0][1].includes("--raw-query"));
  assert.ok(seen.slice(1).every(([, command]) => command.includes("--max-bytes")));
  const sources = path.join(dir, "brain", "sources");
  const launch = fs.readdirSync(sources).find((name) => name.startsWith("drive-launch-plan-q4-"));
  const sheet = fs.readdirSync(sources).find((name) => name.startsWith("drive-wholesale-price-list-"));
  assert.ok(launch && sheet);
  const launchText = fs.readFileSync(path.join(sources, launch), "utf8");
  assert.match(launchText, /^title: "Document: Launch plan Q4"$/m);
  assert.match(launchText, /Kind: Google Doc/);
  assert.match(launchText, /Opening text: Launch plan We open the new storefront/);
  assert.match(launchText, /pulled\/drive/);
  assert.doesNotMatch(fs.readFileSync(path.join(sources, sheet), "utf8"), /Opening text/);
  const text = allText(path.join(dir, "brain"));
  for (const banned of [FAKE_PASSWORD, "Passwords and logins", "Supplier", "Archive", "UNTRUSTED", at_("me", "example.com"), DOC_ID]) assert.ok(!text.includes(banned), `${banned} must never reach the brain`);
  const again = await pull.pullConnectors({ root: dir, sources: ["drive"], account: at_("me", "example.com"), now: NOW, paceMs: 0 });
  assert.equal(again.sources.drive.written, 0);
  assert.equal(again.sources.drive.updated, 0);
  assert.equal(again.sources.drive.removed, 0);
});

test("drive: --plan writes nothing, the cap warns, a refused id never runs, --forget removes it", async (t) => {
  const dir = root(t);
  const calls = path.join(dir, "gog-calls.jsonl");
  fakeGogRuntime(dir, calls);
  const base = { root: dir, sources: ["drive"], account: at_("me", "example.com"), now: NOW, paceMs: 0 };
  const planned = await pull.pullConnectors({ ...base, plan: true, verbose: true });
  assert.ok(planned.sources.drive.planned.some((name) => name.startsWith("sources/drive-launch-plan-q4-")));
  assert.equal(fs.existsSync(path.join(dir, "brain")), false);
  const capped = await pull.pullConnectors({ ...base, max: 2 });
  assert.equal(capped.sources.drive.complete, false);
  assert.match(capped.sources.drive.warning, /LIMIT REACHED/);
  await assert.rejects(pull.defaultAdapters(dir, { account: at_("me", "example.com") }).drive.docText({ id: "--help" }), /not a Drive file id/);
  const noAccount = await pull.pullConnectors({ ...base, account: undefined });
  assert.equal(noAccount.sources.drive.state, "skipped");
  assert.equal(noAccount.sources.drive.code, "NEEDS_ACCOUNT");
  const forgotten = await pull.pullConnectors({ ...base, forget: true });
  assert.equal(forgotten.sources.drive.state, "forgotten");
  assert.ok(!fs.readdirSync(path.join(dir, "brain", "sources")).some((name) => name.startsWith("drive-")));
});

test("sent: monthly notes with counts and subjects, never addresses, codes or old mail", async (t) => {
  const dir = root(t);
  fakeResendModule(dir);
  const requests = [];
  const fetchImpl = async (url, init) => { requests.push({ url: String(url), method: init.method, auth: init.headers.Authorization }); return { ok: true, status: 200, json: async () => sentPage() }; };
  const previous = process.env.BRAIN_TEST_RESEND;
  process.env.BRAIN_TEST_RESEND = ["re", "test", "fixture"].join("_");
  t.after(() => { if (previous === undefined) delete process.env.BRAIN_TEST_RESEND; else process.env.BRAIN_TEST_RESEND = previous; });
  const runtime = require(path.join(dir, "resend", "src", "runtime.js"));
  const adapters = { sent: { listEmails: (args) => pull.defaultAdapters(dir, { resendRequest: pull.resendHttp(runtime.BASE_URL, runtime.getApiKey(), fetchImpl) }).sent.listEmails(args) } };
  const result = await pull.pullConnectors({ root: dir, sources: ["resend"], adapters, now: NOW, paceMs: 0 });
  assert.equal(result.ok, true, JSON.stringify(result.sources));
  assert.equal(result.sources.sent.read, 4, "the July email is outside the 30-day window");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "GET");
  assert.equal(new URL(requests[0].url).pathname, "/emails");
  assert.equal(new URL(requests[0].url).searchParams.get("limit"), "100");
  const october = fs.readFileSync(path.join(dir, "brain", "sources", "sent-email-2026-10.md"), "utf8");
  assert.match(october, /Emails sent: 3, to 2 recipients/);
  assert.match(october, /delivered 2, opened 1/);
  assert.match(october, /- Your order has shipped: 2/);
  assert.match(october, /1 email had its subject left out/);
  assert.match(october, /pulled\/sent/);
  assert.match(fs.readFileSync(path.join(dir, "brain", "sources", "sent-email-2026-09.md"), "utf8"), /bounced 1/);
  const text = allText(path.join(dir, "brain"));
  for (const banned of ["771234", "avery", "sol@", "dana@", "Old newsletter", "re_test_fixture", "4ef9a417"]) assert.ok(!text.includes(banned), `${banned} must never reach the brain`);
  const second = await pull.pullConnectors({ root: dir, sources: ["sent"], adapters, now: NOW, paceMs: 0 });
  assert.equal(second.sources.sent.written, 0);
  assert.equal(second.sources.sent.removed, 0);
});

test("sent: only GET /emails gets through; no key means skipped, a rejected key means not connected", async (t) => {
  const dir = root(t);
  const methods = [];
  const resend = pull.readOnlyResend(async (method, endpoint) => { methods.push([method, endpoint]); return { data: [] }; });
  await resend("/emails", { limit: 1 });
  assert.throws(() => resend("/emails/batch", {}), /not an allowed read/);
  assert.throws(() => resend("/domains", {}), /not an allowed read/);
  assert.deepEqual(methods, [["GET", "/emails"]]);
  const http = pull.resendHttp("https://api.resend.example", "fixture", async () => { throw new Error("must not be called"); });
  await assert.rejects(http("POST", "/emails", {}), /not a read/);
  const notInstalled = await pull.pullConnectors({ root: dir, sources: ["sent"], now: NOW });
  assert.equal(notInstalled.sources.sent.state, "skipped");
  assert.equal(notInstalled.sources.sent.code, "NOT_INSTALLED");
  fakeResendModule(dir);
  const previous = process.env.BRAIN_TEST_RESEND;
  delete process.env.BRAIN_TEST_RESEND;
  t.after(() => { if (previous !== undefined) process.env.BRAIN_TEST_RESEND = previous; });
  const noKey = await pull.pullConnectors({ root: dir, sources: ["sent"], now: NOW });
  assert.equal(noKey.sources.sent.state, "skipped");
  assert.equal(noKey.sources.sent.code, "NOT_CONNECTED");
  const rejected = pull.resendHttp("https://api.resend.example", "fixture", async () => ({ ok: false, status: 401, json: async () => ({ message: "API key is invalid" }) }));
  await assert.rejects(rejected("GET", "/emails", {}), (error) => error.code === "NOT_CONNECTED");
  assert.equal(pull.resendDate("2026-10-03 09:12:44.674981+00").toISOString(), "2026-10-03T09:12:44.674Z");
});

test("sent: pages through has_more until the window ends, bounded by the cap", async (t) => {
  const dir = root(t);
  fakeResendModule(dir);
  process.env.BRAIN_TEST_RESEND = "fixture";
  t.after(() => { delete process.env.BRAIN_TEST_RESEND; });
  const recent = (index) => ({ id: `id-${index}`, to: [at_(`p${index}`, "example.com")], created_at: `2026-10-0${1 + (index % 4)} 10:00:00+00`, subject: "Receipt", last_event: "delivered" });
  const pages = [{ object: "list", has_more: true, data: [recent(1), recent(2)] }, { object: "list", has_more: true, data: [recent(3), { ...recent(4), created_at: "2026-01-01 10:00:00+00" }] }, { object: "list", has_more: false, data: [recent(5)] }];
  const seen = [];
  const request = async (method, endpoint, params) => { seen.push(params.after || null); return pages[seen.length - 1]; };
  const rows = await pull.defaultAdapters(dir, { resendRequest: request }).sent.listEmails({ sinceSeconds: at(30), max: 100 });
  assert.deepEqual(rows.map((row) => row.id), ["id-1", "id-2", "id-3"], "stops at the first email older than the window");
  assert.deepEqual(seen, [null, "id-2"]);
  seen.length = 0;
  const capped = await pull.defaultAdapters(dir, { resendRequest: request }).sent.listEmails({ sinceSeconds: at(30), max: 1 });
  assert.equal(capped.length, 1);
  assert.equal(seen.length, 1);
});

// ---------------------------------------------------------------------------
// Detail modes, the wider free-text filter, quiet output and the refresh label.
function privateThreads() {
  return [
    { id: "p1", from: `Jane Customer <${at_("jane", "example.com")}>`, subject: "Order 12", date: "2026-10-01T09:00:00Z", messageCount: 2, snippet: "Ship to 42 Maple Street, Austin TX please" },
    { id: "p2", from: `Bob Buyer <${at_("bob", "example.com")}>`, subject: "Question about dosing", date: "2026-10-02T09:00:00Z", messageCount: 1, snippet: "How many mg per injection?" },
    { id: "p3", from: `Bob Buyer <${at_("bob", "example.com")}>`, subject: "Call me", date: "2026-10-03T09:00:00Z", messageCount: 1, snippet: "My number is 555-123-4567" },
  ];
}

test("full detail drops addresses, phone numbers and dosing text whole", async (t) => {
  const dir = root(t);
  const result = await pull.pullConnectors({ root: dir, sources: ["mail"], adapters: fakeAdapters({ threads: privateThreads() }), now: NOW, paceMs: 0 });
  assert.equal(result.detail, "full");
  const text = allText(path.join(dir, "brain"));
  for (const banned of ["Maple", "Austin", "555-123-4567", "dosing", "injection", " mg "]) assert.ok(!text.includes(banned), `${banned} must never reach the brain`);
  assert.match(text, /Order 12/, "an ordinary subject still comes through in full detail");
  for (const value of ["Ship to 42 Maple Street", ["+62", "812", "3456", "7890"].join(" "), "two vials a cycle", "any side effects?", "5mcg", "Austin TX 78701"]) assert.equal(pull.safeSnippet(value), null, value);
  assert.equal(pull.safeSnippet("Meeting 2026-10-05 at 10:30"), "Meeting 2026-10-05 at 10:30");
});

test("metadata detail: who, when and counts only, from the lock default, the setting or the flag", async (t) => {
  const dir = root(t);
  fs.writeFileSync(path.join(dir, "allsorted-dist.lock.json"), JSON.stringify({ bundle: "derived", product: { name: "Example Shop" }, brainPullDetail: "metadata" }));
  const result = await pull.pullConnectors({ root: dir, sources: ["mail", "payments", "calendar", "sent"], adapters: { ...fakeAdapters({ threads: [...threads(), ...privateThreads()] }), sent: { listEmails: async () => sentPage().data } }, now: NOW, paceMs: 0 });
  assert.equal(result.ok, true, JSON.stringify(result.sources));
  assert.equal(result.detail, "metadata");
  const brainDir = path.join(dir, "brain");
  assert.ok(!fs.readdirSync(path.join(brainDir, "sources")).some((name) => name.startsWith("mail-")), "no thread notes: their names carry subjects");
  const dana = fs.readFileSync(path.join(brainDir, "people", "dana-lee.md"), "utf8");
  assert.match(dana, /Threads in this window: 2/);
  assert.match(dana, /Messages in those threads: 4/);
  // A metadata-default distribution keeps payments to monthly totals: no
  // note per paying person at all.
  assert.equal(fs.existsSync(path.join(brainDir, "people", "avery-stone.md")), false);
  const payments = fs.readdirSync(path.join(brainDir, "sources")).filter((name) => name.startsWith("payments-"));
  assert.ok(payments.length > 0, "monthly payment totals are still written");
  for (const name of payments) assert.doesNotMatch(fs.readFileSync(path.join(brainDir, "sources", name), "utf8"), /Avery/);
  const text = allText(brainDir);
  for (const banned of ["Launch plan", "draft for the launch", "Order 12", "Planning with Dana", "Your order has shipped", "Consultation"]) assert.ok(!text.includes(banned), `${banned} must not appear in metadata detail`);
  assert.match(fs.readFileSync(path.join(brainDir, "sources", "calendar-2026-10.md"), "utf8"), /2026-10-02: event \(1 other\)/);
  assert.match(fs.readFileSync(path.join(brainDir, "sources", "sent-email-2026-10.md"), "utf8"), /Emails sent: 3/);
  const full = await pull.pullConnectors({ root: dir, sources: ["mail"], adapters: fakeAdapters(), now: NOW, paceMs: 0, detail: "full", plan: true, verbose: true });
  assert.equal(full.detail, "full", "the flag wins over the lock");
  assert.ok(full.sources.mail.planned.some((name) => name.startsWith("sources/mail-launch-plan-")));
  await assert.rejects(pull.pullConnectors({ root: dir, sources: ["mail"], adapters: fakeAdapters(), now: NOW, detail: "everything" }), /--detail is metadata or full/);
  await pull.pullConnectors({ root: dir, sources: ["mail"], adapters: fakeAdapters(), now: NOW, paceMs: 0, remember: true, detail: "full" });
  assert.equal(pull.readConfig(dir).pull.perSource.mail.detail, "full");
  assert.equal(pull.readConfig(dir).pull.detail, undefined, "no single detail for every source");
  const remembered = await pull.pullConnectors({ root: dir, adapters: fakeAdapters(), now: NOW, paceMs: 0, plan: true });
  assert.equal(remembered.detail, "full", "the remembered setting wins over the lock");
});

test("metadata detail opens no Drive document and keeps no message text", async (t) => {
  const dir = root(t);
  const calls = path.join(dir, "gog-calls.jsonl");
  fakeGogRuntime(dir, calls);
  messageDb(dir);
  const result = await pull.pullConnectors({ root: dir, sources: ["drive", "messages"], account: at_("me", "example.com"), detail: "metadata", now: NOW, paceMs: 0 });
  assert.equal(result.ok, true, JSON.stringify(result.sources));
  const seen = fs.readFileSync(calls, "utf8").trim().split("\n").map((line) => JSON.parse(line)[1].slice(0, 2).join(" "));
  assert.deepEqual(seen, ["drive search"]);
  const text = allText(path.join(dir, "brain"));
  assert.ok(!/Opening text|See you at the studio|bringing the samples/.test(text));
  assert.match(fs.readFileSync(path.join(dir, "brain", "people", "sol-park.md"), "utf8"), /Messages in this window: 3/);
});

test("the refresh launchd label follows the product name in the install's lock", async (t) => {
  const plain = root(t);
  assert.equal(refresher.labelFor(plain), refresher.LABEL);
  fs.writeFileSync(path.join(plain, "allsorted-dist.lock.json"), JSON.stringify({ bundle: "allsorted-dist" }));
  assert.equal(refresher.labelFor(plain), "ai.allsorted.brain-refresh", "All Sorted keeps its label");
  const derived = root(t);
  fs.writeFileSync(path.join(derived, "allsorted-dist.lock.json"), JSON.stringify({ bundle: "derived", product: { name: "Example Shop" } }));
  assert.equal(refresher.labelFor(derived), "ai.exampleshop.brain-refresh");
  const home = root(t);
  const template = refresher.schedule({ root: derived, mode: "template", home, nodePath: "/usr/local/bin/node" });
  assert.equal(path.basename(template.template), "ai.exampleshop.brain-refresh.plist");
  const plist = fs.readFileSync(template.template, "utf8");
  assert.match(plist, /<key>Label<\/key><string>ai\.exampleshop\.brain-refresh<\/string>/);
  assert.doesNotMatch(plist, /allsorted/);
  const agents = path.join(home, "Library", "LaunchAgents");
  fs.mkdirSync(agents, { recursive: true });
  const legacy = path.join(agents, `${refresher.LABEL}.plist`);
  fs.writeFileSync(legacy, refresher.schedulePlist(derived, {}, "/usr/local/bin/node", refresher.LABEL));
  const other = root(t);
  const commands = [];
  refresher.schedule({ root: derived, mode: "off", home, platform: "darwin", run: (command, args) => { commands.push(args.join(" ")); return ""; } });
  assert.equal(fs.existsSync(legacy), false, "the old shared-label job for this root is retired");
  assert.ok(commands.some((line) => line.endsWith(`/${refresher.LABEL}`)));
  fs.writeFileSync(legacy, refresher.schedulePlist(other, {}, "/usr/local/bin/node", refresher.LABEL));
  refresher.schedule({ root: derived, mode: "off", home, platform: "darwin", run: () => "" });
  assert.ok(fs.existsSync(legacy), "another install's job is left alone");
  await assert.rejects(pull.defaultAdapters(derived, { account: at_("me", "example.com") }).drive.docText({ id: "-abcdefghijk" }), /not a Drive file id/);
});

// PeptAIOS review 4 (P1 privacy): one remembered pull.detail served every
// source. messages remembered as metadata, then payments remembered as full
// (even though payments was skipped as not installed) turned full detail on
// for messages too, and the daily refresh rewrote every WhatsApp note in full.
test("remembered detail is per source, and a skipped source never changes settings", async (t) => {
  const dir = root(t);
  fs.writeFileSync(path.join(dir, "allsorted-dist.lock.json"), JSON.stringify({ bundle: "derived", product: { name: "Example Shop" }, brainPullDetail: "metadata" }));
  const messagesOnly = { ...fakeAdapters(), payments: { listCharges: async () => { const error = new Error("The Stripe module is not installed."); error.code = "NOT_INSTALLED"; throw error; } } };
  const first = await pull.pullConnectors({ root: dir, sources: ["mail"], adapters: messagesOnly, now: NOW, paceMs: 0, remember: true, detail: "metadata" });
  assert.equal(first.sources.mail.state, "pulled");
  const before = fs.readFileSync(pull.configPath(dir), "utf8");
  const second = await pull.pullConnectors({ root: dir, sources: ["payments"], adapters: messagesOnly, now: NOW, paceMs: 0, remember: true, detail: "full" });
  assert.equal(second.sources.payments.state, "skipped");
  assert.deepEqual(second.notRemembered, ["payments"]);
  assert.match(second.message, /payments: skipped \(The Stripe module is not installed\.\)/);
  assert.equal(fs.readFileSync(pull.configPath(dir), "utf8"), before, "a skipped source changed the remembered settings");
  const config = pull.readConfig(dir).pull;
  assert.deepEqual(config.sources, ["mail"]);
  assert.equal(config.perSource.mail.detail, "metadata");
  assert.equal(config.detail, undefined);
  // The daily refresh reads the remembered settings: mail stays metadata.
  const refreshed = await refresher.refresh({ root: dir, adapters: messagesOnly, now: NOW, paceMs: 0 });
  const pullStep = refreshed.steps.find((step) => step.step === "pull");
  assert.equal(pullStep.sources.mail.detail, "metadata");
  // Once payments really reads, its own full detail is remembered for it alone.
  const withStripe = { ...fakeAdapters(), payments: fakeAdapters().payments };
  await pull.pullConnectors({ root: dir, sources: ["payments"], adapters: withStripe, now: NOW, paceMs: 0, remember: true, detail: "full" });
  const after = pull.readConfig(dir).pull;
  assert.equal(after.perSource.payments.detail, "full");
  assert.equal(after.perSource.mail.detail, "metadata");
});

test("an old single pull.detail migrates to the stricter value for every source", async (t) => {
  const dir = root(t);
  fs.writeFileSync(path.join(dir, "allsorted-dist.lock.json"), JSON.stringify({ bundle: "derived", product: { name: "Example Shop" }, brainPullDetail: "metadata" }));
  fs.mkdirSync(path.join(dir, "state"), { recursive: true });
  fs.writeFileSync(pull.configPath(dir), JSON.stringify({ pull: { sources: ["mail", "messages"], detail: "full", account: "owner" } }));
  const settings = pull.readConfig(dir).pull;
  const perSource = pull.perSourceSettings(dir, settings);
  assert.equal(perSource.mail.detail, "metadata", "ambiguous full against a metadata default keeps the stricter");
  assert.equal(perSource.messages.detail, "metadata");
  assert.equal(perSource.mail.account, "owner");
  assert.equal(perSource.messages.account, undefined, "the old Google account is not a WhatsApp setting");
  const plan = await pull.pullConnectors({ root: dir, adapters: fakeAdapters(), now: NOW, paceMs: 0, plan: true });
  assert.equal(plan.details.mail, "metadata");
  // On a full-default distribution an old full stays full.
  const plain = root(t);
  fs.mkdirSync(path.join(plain, "state"), { recursive: true });
  fs.writeFileSync(pull.configPath(plain), JSON.stringify({ pull: { sources: ["mail"], detail: "full" } }));
  assert.equal(pull.perSourceSettings(plain, pull.readConfig(plain).pull).mail.detail, "full");
  fs.writeFileSync(pull.configPath(plain), JSON.stringify({ pull: { sources: ["mail"], detail: "metadata" } }));
  assert.equal(pull.perSourceSettings(plain, pull.readConfig(plain).pull).payments.detail, "metadata");
});

test("a skipped remembered source is named with its reason in the refresh summary", async (t) => {
  const dir = root(t);
  fs.mkdirSync(path.join(dir, "state"), { recursive: true });
  fs.writeFileSync(pull.configPath(dir), JSON.stringify({ pull: { sources: ["mail", "payments"] } }));
  const adapters = { ...fakeAdapters(), payments: { listCharges: async () => { const error = new Error("The Stripe module is not installed."); error.code = "NOT_INSTALLED"; throw error; } } };
  const refreshed = await refresher.refresh({ root: dir, adapters, now: NOW, paceMs: 0 });
  const step = refreshed.steps.find((entry) => entry.step === "pull");
  assert.equal(step.state, "degraded");
  assert.match(step.reason, /payments skipped \(NOT_INSTALLED: The Stripe module is not installed\.\)/);
  assert.deepEqual(step.skipped, ["payments"]);
});


test("remembered brain sources, exclusions and limits survive build and refresh", async (t) => {
  const dir = root(t);
  const docs = path.join(dir, "documents");
  const excluded = path.join(docs, "generated");
  fs.mkdirSync(excluded, { recursive: true });
  fs.writeFileSync(path.join(docs, "large.md"), "# Large note\n\n" + "Complete source content.\n".repeat(12000));
  fs.writeFileSync(path.join(excluded, "copy.md"), "# Generated copy\n");
  pull.writeConfig(dir, { pull: { sources: [] }, passes: [], schedule: { enabled: false } });
  const built = await brain.build({ root: dir, from: [docs], includeDefault: false, exclude: [excluded], maxFiles: 5000, maxNoteBytes: 1048576, remember: true });
  const config = pull.readConfig(dir);
  assert.deepEqual(config.from, [docs]);
  assert.deepEqual(config.build, { maxFiles: 5000, maxNoteBytes: 1048576, exclude: [excluded] });
  assert.equal(config.schedule.enabled, false);
  assert.equal(built.coverage.complete, true);
  assert.equal(built.coverage.documentsRead, 1);
  assert.equal(built.coverage.eligibleDocuments, 1);
  assert.equal(built.coverage.truncatedDocuments, 0);
  const refreshed = await refresher.refresh({ root: dir });
  const step = refreshed.steps.find((entry) => entry.step === "build");
  assert.equal(step.coverage.complete, true);
  assert.equal(step.coverage.documentsRead, 1);
  assert.equal(step.coverage.truncatedDocuments, 0);
  const state = JSON.parse(fs.readFileSync(path.join(dir, "brain", ".brain-state.json"), "utf8"));
  const note = Object.keys(state.notes).find((name) => state.notes[name].title === "Large note");
  assert.doesNotMatch(fs.readFileSync(path.join(dir, "brain", note), "utf8"), /Cut here/);
});


test("coverage and refresh report missing, capped and truncated sources as incomplete", async (t) => {
  const dir = root(t);
  const docs = path.join(dir, "docs");
  fs.mkdirSync(docs);
  fs.writeFileSync(path.join(docs, "one.md"), "# One\n\n" + "Knowledge.\n".repeat(100));
  fs.writeFileSync(path.join(docs, "two.md"), "# Two\n\nSecond source");
  const built = await brain.build({ root: dir, from: [docs, path.join(dir, "missing")], includeDefault: false, maxFiles: 1, maxNoteBytes: 20, remember: true });
  assert.equal(built.coverage.eligibleDocuments, 2);
  assert.equal(built.coverage.documentsRead, 1);
  assert.equal(built.coverage.truncatedDocuments, 1);
  assert.equal(built.coverage.complete, false);
  assert.equal(built.degraded, true);
  assert.equal(built.skipped.missingFolders.length, 1);
  const refreshed = await refresher.refresh({ root: dir });
  assert.equal(refreshed.degraded, true);
  assert.equal(refreshed.steps.find((entry) => entry.step === "build").state, "degraded");
  assert.equal(refreshed.steps.find((entry) => entry.step === "build").coverage.complete, false);
});


test("a refused source becomes a failed refresh receipt", async (t) => {
  const dir = root(t);
  brain.init({ root: dir });
  pull.writeConfig(dir, { from: [path.join(dir, "brain")] });
  const result = await refresher.refresh({ root: dir });
  assert.equal(result.ok, false);
  assert.equal(result.steps.find((entry) => entry.step === "build").state, "failed");
  assert.match(result.steps.find((entry) => entry.step === "build").reason, /brain folder itself/);
});


test("coverage preserves content from documents describing the same person", async (t) => {
  const dir = root(t);
  const docs = path.join(dir, "people");
  fs.mkdirSync(docs);
  fs.writeFileSync(path.join(docs, "one.md"), "# Dana Lee\n\nFirst document detail.");
  fs.writeFileSync(path.join(docs, "two.md"), "# Dana Lee\n\nSecond document detail.");
  const built = await brain.build({ root: dir, from: [docs], includeDefault: false });
  assert.equal(built.coverage.complete, true);
  const text = fs.readFileSync(path.join(dir, "brain", "people", "dana-lee.md"), "utf8");
  assert.match(text, /First document detail/);
  assert.match(text, /Second document detail/);
});


test("explicit exclusions cover the source root and its ancestors", async (t) => {
  const dir = root(t);
  const docs = path.join(dir, "docs");
  fs.mkdirSync(docs);
  fs.writeFileSync(path.join(docs, "note.md"), "# Excluded document");
  for (const exclude of [[docs], [dir]]) {
    const built = await brain.build({ root: dir, from: [docs], includeDefault: false, exclude });
    assert.equal(built.coverage.eligibleDocuments, 0);
    assert.equal(built.coverage.documentsRead, 0);
    assert.equal(built.notes, 0);
  }
});


test("an extracted original can be excluded as an individual file", async (t) => {
  const dir = root(t);
  const docs = path.join(dir, "docs");
  fs.mkdirSync(docs);
  const excluded = path.join(docs, "original.md");
  fs.writeFileSync(excluded, "# Original represented by imported chunks");
  fs.writeFileSync(path.join(docs, "retained.md"), "# Retained document");
  const built = await brain.build({ root: dir, from: [docs], includeDefault: false, exclude: [excluded] });
  assert.equal(built.coverage.documentsRead, 1);
});

test("a window longer than the maximum is clamped loudly, never silently", async () => {
  const byDays = pull.windowFor({ days: 9999 }, new Date(NOW));
  assert.deepEqual(byDays.clamped, { requested: "9999 days", applied: `${pull.MAX_DAYS} days`, maxDays: pull.MAX_DAYS });
  const bySince = pull.windowFor({ since: "2020-01-01" }, new Date(NOW));
  assert.equal(bySince.clamped.requested, "2020-01-01");
  assert.equal(bySince.days, pull.MAX_DAYS);
  assert.equal(pull.windowFor({ days: 30 }, new Date(NOW)).clamped, undefined);
  assert.equal(pull.windowFor({ since: "2026-09-01" }, new Date(NOW)).clamped, undefined);
});

test("a clamped pull says so in its result", async (t) => {
  const dir = root(t);
  const result = await pull.pullConnectors({ root: dir, sources: ["mail"], adapters: fakeAdapters(), plan: true, now: NOW, since: "2020-01-01" });
  assert.equal(result.window.clamped.requested, "2020-01-01");
  assert.match(result.warnings[0], /^WINDOW CLAMPED: asked for 2020-01-01/);
  const normal = await pull.pullConnectors({ root: dir, sources: ["mail"], adapters: fakeAdapters(), plan: true, now: NOW, days: 30 });
  assert.equal(normal.warnings, undefined);
});
