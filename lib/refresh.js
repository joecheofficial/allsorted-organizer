"use strict";

// Brain refresh: re-runs the passes that keep the second brain current, in one
// command, from the settings in <root>/state/brain-refresh-settings.json:
//
//   1. `build` over the folders listed in `from` (when any are listed);
//   2. the connector pull for the sources listed in `pull.sources`;
//   3. each registered pass in `passes`, such as a product, regulatory or page
//      pass a module ships: a recipe inside the install root whose runRecipe
//      returns `{ notes: [...] }` in the `brain add` shape. Its notes are written
//      with the pass name as their source, so the next refresh tidies away what
//      the pass no longer produces;
//   4. `graph`.
//
// The schedule is off by default. `--schedule template` writes the schedule
// file for review and loads nothing. `--schedule on` turns it on and
// `--schedule off` turns it off again. A scheduled run does nothing unless
// `schedule.enabled` is true in the settings, so a stray copy of the file
// never starts reading on its own.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const brain = require("./brain");
const connectorPull = require("./connector-pull");

const LABEL = "ai.allsorted.brain-refresh";

// The launchd label carries the product name the install's lock gives
// (product.name), so a derived distribution never shows another product's
// name in LaunchAgents. An install with no product name keeps LABEL.
function labelFor(root) {
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(root, "allsorted-dist.lock.json"), "utf8"));
    const name = typeof lock?.product?.name === "string" ? lock.product.name.trim() : "";
    const tag = name.toLowerCase().replace(/[^a-z0-9]+/g, "");
    if (!tag || tag === "allsorted" || tag.length > 40) return LABEL;
    return `ai.${tag}.brain-refresh`;
  } catch { return LABEL; }
}
const PASS_NAME = /^[a-z][a-z0-9-]{0,30}$/;

function example() {
  return {
    from: [],
    pull: { sources: [], account: "", days: connectorPull.DEFAULT_DAYS, max: connectorPull.DEFAULT_MAX },
    passes: [],
    schedule: { enabled: false, hour: 4, minute: 15 },
  };
}

function passRecipe(root, pass) {
  const name = String(pass?.name ?? "").trim().toLowerCase();
  if (!PASS_NAME.test(name)) throw new Error(`A pass name is lower-case letters, digits and dashes: "${pass?.name}" is not one.`);
  const file = path.resolve(root, String(pass.recipe || ""));
  const real = fs.existsSync(file) ? fs.realpathSync(file) : null;
  const realRoot = fs.realpathSync(root);
  const relative = real ? path.relative(realRoot, real) : "..";
  if (!real || relative.startsWith("..") || path.isAbsolute(relative) || !/\.c?js$/.test(real)) throw new Error(`The ${name} pass recipe must be a .js file inside the install root.`);
  return { name, file: real };
}

function acquireRefresh(root) {
  const file = path.join(root, "state", ".brain-refresh.lock");
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (fs.existsSync(file)) {
    let stale = false;
    try {
      const pid = JSON.parse(fs.readFileSync(file, "utf8")).pid;
      if (!Number.isInteger(pid) || pid <= 0) throw new Error("Invalid refresh lease.");
      try { process.kill(pid, 0); } catch (error) { if (error.code === "ESRCH") stale = true; }
    } catch { /* An unverified lease is preserved. */ }
    if (!stale) throw new Error("A brain refresh is already running, or its lease needs review. Its progress receipt was left alone.");
    fs.unlinkSync(file);
  }
  const fd = fs.openSync(file, "wx", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() })); } finally { fs.closeSync(fd); }
  return () => fs.unlinkSync(file);
}

async function refresh(options = {}) {
  const root = path.resolve(options.root || brain.defaultRoot());
  const config = connectorPull.readConfig(root);
  const plan = options.plan === true;
  const result = { ok: true, command: "refresh", root, plan, steps: [] };
  if (options.scheduled && config.schedule?.enabled !== true) {
    result.message = "The brain refresh schedule is off in the settings, so this scheduled run did nothing.";
    return result;
  }
  const release = plan ? () => {} : acquireRefresh(root);
  try {
  const from = Array.isArray(config.from) ? config.from.map(String).filter(Boolean) : [];
  const passes = Array.isArray(config.passes) ? config.passes : [];
  const hasPull = Array.isArray(config.pull?.sources) && config.pull.sources.length > 0;
  const total = Number(from.length > 0) + Number(hasPull) + passes.length;
  const previous = brain.readRunRecord(root, "brain-refresh.json");
  const startedAt = new Date().toISOString();
  const receipt = { schemaVersion: 1, taskClass: "default_automation", intent: "brain_refresh", at: startedAt, startedAt, finishedAt: null, status: "running", ok: true, degraded: false, progress: { completed: 0, total: total ? total + 1 : 0, step: null }, lastSuccess: previous?.lastSuccess || null, errors: [], steps: result.steps };
  const save = (step = null) => {
    if (plan) return;
    receipt.ok = result.ok;
    receipt.degraded = result.degraded === true;
    receipt.progress = { ...receipt.progress, completed: result.steps.filter(entry => entry.state !== "running").length, step };
    receipt.errors = result.steps.filter(entry => ["failed", "partly failed"].includes(entry.state)).map(entry => ({ step: entry.step, code: "REFRESH_STEP_FAILED", message: entry.reason || "Step failed." }));
    brain.writeRunRecord(root, "brain-refresh.json", receipt);
  };
  save();
  const execute = async (entry, work) => {
    result.steps.push(entry);
    if (plan) { entry.state = "planned"; return; }
    entry.state = "running";
    save(entry.step);
    try { await work(entry); }
    catch (error) { result.ok = false; Object.assign(entry, { state: "failed", reason: String(error.message).slice(0, 300) }); }
    save();
  };
  if (from.length) await execute({ step: "build", folders: from }, async entry => {
    const built = await brain.build({ ...config.build, root, from, includeDefault: false, paceMs: options.paceMs ?? 0 });
    if (built.degraded || built.warnings?.length) result.degraded = true;
    Object.assign(entry, { coverage: built.coverage, extraction: built.extraction?.counts, state: built.degraded || built.warnings?.length ? "degraded" : "done", notes: built.notes, written: built.written, updated: built.updated, removed: built.removed, ...(built.warnings?.length ? { warnings: built.warnings } : {}) });
  });
  if (hasPull) await execute({ step: "pull" }, async entry => {
    const pulled = await connectorPull.pullConnectors({ root, adapters: options.adapters, now: options.now, paceMs: options.paceMs ?? 0 });
    if (!pulled.ok) result.ok = false;
    const left = Object.entries(pulled.sources).filter(([, value]) => value.state === "skipped" || value.complete === false).map(([name]) => name);
    if (left.length) result.degraded = true;
    const why = left.map(name => { const value = pulled.sources[name]; return value.state === "skipped" ? `${name} skipped (${value.code}: ${value.reason})` : `${name} cut off at the item limit`; });
    Object.assign(entry, { state: !pulled.ok ? "partly failed" : left.length ? "degraded" : "done", sources: pulled.sources, window: pulled.window, ...(!pulled.ok ? { reason: "A connected-source pull failed. Inspect sources for its error." } : {}), ...(left.length ? { reason: `not fully read: ${why.join("; ")}`, skipped: left.filter(name => pulled.sources[name].state === "skipped") } : {}) });
  });
  for (const pass of passes) await execute({ step: "pass", name: String(pass?.name ?? "") }, async entry => {
    if (options.scheduled) throw new Error("Custom passes require an interactive refresh; unattended execution is disabled.");
    const { name, file } = passRecipe(root, pass);
    entry.name = name;
    const output = await Promise.resolve(require(file).runRecipe({ ...(pass.input && typeof pass.input === "object" ? pass.input : {}), root, readOnly: true }));
    if (output?.status === "error" || output?.ok === false) throw new Error(output.reply || "The pass returned a failure.");
    const items = Array.isArray(output?.notes) ? output.notes : Array.isArray(output?.metadata?.notes) ? output.metadata.notes : null;
    if (!items) throw new Error("the recipe returned no notes list");
    const written = await brain.pull({ root, source: `pass-${name}`, items, complete: output.complete !== false, paceMs: options.paceMs ?? 0 });
    if (written.rejected?.length) throw new Error(`The pass returned ${written.rejected.length} invalid notes.`);
    if (output.complete === false || written.protected > 0) result.degraded = true;
    Object.assign(entry, { state: output.complete === false || written.protected > 0 ? "degraded" : "done", notes: written.notes, written: written.written, updated: written.updated, removed: written.removed });
  });
  if (total) await execute({ step: "graph" }, async entry => {
    const graphed = brain.graph({ root });
    if (graphed.degraded) result.degraded = true;
    // Missing optional Atelier degrades the run; an installed but failed graph fails it.
    const failed = graphed.atelier?.present === true && (graphed.atelier?.file === null || graphed.degraded);
    if (failed) result.ok = false;
    Object.assign(entry, { state: failed ? "failed" : graphed.degraded ? "degraded" : "done", notes: graphed.notes, wikilinks: graphed.wikilinks, brokenWikilinks: graphed.brokenWikilinks, degraded: graphed.degraded, ...(failed ? { reason: (graphed.warnings || []).join(" ").slice(0, 300) } : {}) });
  });
  if (!total) result.message = `Nothing to refresh yet. List folders, sources or passes in ${connectorPull.configPath(root)}.`;
  if (!plan) {
    receipt.finishedAt = new Date().toISOString();
    receipt.status = !result.ok ? "failed" : result.degraded ? "degraded" : "done";
    if (result.ok && !result.degraded && total) receipt.lastSuccess = receipt.finishedAt;
    save();
    result.receipt = receipt;
  }
  return result;
  } finally { release(); }
}

// ---------------------------------------------------------------------------
// Schedule (macOS launchd), off by default

function xml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]);
}

function clock(value, max, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 && number <= max ? number : fallback;
}

function schedulePlist(root, config, nodePath = process.execPath, label = labelFor(root)) {
  const hour = clock(config.schedule?.hour, 23, 4);
  const minute = clock(config.schedule?.minute, 59, 15);
  // Through the install's as-run when it is there, so the job gets the same
  // environment (module sign-ins) as every other command the install runs.
  const asRun = path.join(root, "bin", "as-run");
  const command = [nodePath, path.join(root, "organizer", "bin", "organizer.js"), "brain", "refresh", "--root", root, "--scheduled", "--quiet"];
  const args = fs.existsSync(asRun) ? [asRun, ...command] : command;
  const logs = path.join(root, "state");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>
  <key>WorkingDirectory</key><string>${xml(root)}</string>
  <key>EnvironmentVariables</key><dict><key>MYOS_TASK_CLASS</key><string>default_automation</string><key>PATH</key><string>${xml(path.dirname(nodePath))}:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin</string></dict>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>${minute}</integer></dict>
  <key>StandardOutPath</key><string>${xml(path.join(logs, "brain-refresh.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(logs, "brain-refresh-error.log"))}</string>
</dict></plist>
`;
}

function schedule(options = {}) {
  const root = path.resolve(options.root || brain.defaultRoot());
  const mode = String(options.mode || "template");
  if (!["template", "on", "off"].includes(mode)) throw new Error("--schedule is template, on or off.");
  const run = options.run || ((command, args) => execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  const home = options.home || os.homedir();
  const config = connectorPull.readConfig(root);
  const label = labelFor(root);
  const template = path.join(root, "state", "schedules", `${label}.plist`);
  const agent = path.join(home, "Library", "LaunchAgents", `${label}.plist`);
  const domain = `gui/${typeof process.getuid === "function" ? process.getuid() : 0}`;
  fs.mkdirSync(path.dirname(template), { recursive: true });
  fs.writeFileSync(template, schedulePlist(root, config, options.nodePath, label), { mode: 0o600 });
  if (mode === "template") return { ok: true, command: "refresh", schedule: "template", label, enabled: config.schedule?.enabled === true, template, message: `The schedule file is at ${template}. Nothing was turned on. Use --schedule on to turn it on.` };
  if ((options.platform || process.platform) !== "darwin") throw new Error("Turning the schedule on or off is supported on macOS.");
  try { run("launchctl", ["bootout", `${domain}/${label}`]); } catch { /* it was not loaded */ }
  // An earlier version of this install turned the job on under the shared
  // label. Retire that copy, but only when it runs this same root.
  if (label !== LABEL) {
    const legacy = path.join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
    let ours = false;
    try { ours = fs.readFileSync(legacy, "utf8").includes(`<string>${xml(root)}</string>`); } catch { /* none */ }
    if (ours) {
      try { run("launchctl", ["bootout", `${domain}/${LABEL}`]); } catch { /* it was not loaded */ }
      fs.rmSync(legacy, { force: true });
    }
  }
  if (mode === "off") {
    fs.rmSync(agent, { force: true });
    connectorPull.writeConfig(root, { ...config, schedule: { ...(config.schedule || {}), enabled: false } });
    return { ok: true, command: "refresh", schedule: "off", enabled: false, template };
  }
  fs.mkdirSync(path.dirname(agent), { recursive: true });
  fs.copyFileSync(template, agent);
  try { run("launchctl", ["bootstrap", domain, agent]); }
  catch (error) {
    // Roll back: no file left in LaunchAgents, the setting stays off.
    fs.rmSync(agent, { force: true });
    throw new Error(`The schedule could not be turned on: ${String(error.message).split("\n")[0]}`);
  }
  connectorPull.writeConfig(root, { ...config, schedule: { ...(config.schedule || {}), enabled: true } });
  return { ok: true, command: "refresh", schedule: "on", label, enabled: true, template, agent, time: `${String(clock(config.schedule?.hour, 23, 4)).padStart(2, "0")}:${String(clock(config.schedule?.minute, 59, 15)).padStart(2, "0")}` };
}

module.exports = { acquireRefresh, LABEL, labelFor, example, refresh, schedule, schedulePlist, passRecipe };
