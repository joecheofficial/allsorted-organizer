#!/usr/bin/env node
"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os"),
  { execFileSync } = require("node:child_process");
const { atomicWriteJson } = require("./lib/atomic-write");
const { backupIntoTree } = require("./lib/backup");
const PACKAGE_ROOT = path.resolve(__dirname, "..");
function parse(argv) {
  const at = (n) => {
    const i = argv.indexOf(n);
    return i < 0 ? null : argv[i + 1];
  };
  return {
    target: at("--target") || at("--workspace") ||
      path.join(os.homedir(), ".myos-dispatch"),
    dryRun: argv.includes("--dry-run"),
    uninstall: argv.includes("--uninstall"),
  };
}
function statePath(target) {
  return path.join(target, ".allsorted-organizer-state.json");
}
function atomicCopy(source, destination) {
  const temp = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${process.pid}.${Date.now()}.tmp`,
  );
  fs.copyFileSync(source, temp);
  fs.renameSync(temp, destination);
}
function copyTree(source, destination, state, targetRoot, backupRoot, dry) {
  for (const ent of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, ent.name),
      to = path.join(destination, ent.name);
    if (ent.isDirectory()) {
      copyTree(from, to, state, targetRoot, backupRoot, dry);
      continue;
    }
    if (dry) continue;
    const relative = path.relative(targetRoot, to);
    const owned = state.files.some((item) => item.path === relative);
    const prior = !owned && fs.existsSync(to)
      ? backupIntoTree(to, targetRoot, backupRoot)
      : null;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    atomicCopy(from, to);
    if (!owned) {
      state.files.push({
        path: relative,
        backup: prior && path.relative(targetRoot, prior),
        created: !prior,
      });
    }
  }
}
function removeEmptyParents(dir, stop) {
  let current = dir;
  while (current.startsWith(`${stop}${path.sep}`)) {
    try {
      fs.rmdirSync(current);
    } catch {
      break;
    }
    current = path.dirname(current);
  }
}
function uninstall(target, dry) {
  const file = statePath(target);
  if (!fs.existsSync(file)) return;
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const item of [...state.files].reverse()) {
    const dest = path.join(target, item.path);
    if (dry) continue;
    if (item.backup && fs.existsSync(path.join(target, item.backup))) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(target, item.backup), dest);
    } else if (fs.existsSync(dest)) {
      fs.rmSync(dest, { force: true });
      removeEmptyParents(path.dirname(dest), target);
    }
  }
  if (!dry) {
    fs.rmSync(file, { force: true });
    const organizer = path.join(target, "organizer");
    try {
      fs.rmdirSync(organizer);
    } catch {}
    if (
      state.backupRoot && fs.existsSync(path.join(target, state.backupRoot))
    ) {
      console.log(
        `Organizer backup residue retained at ${
          path.join(target, state.backupRoot)
        }`,
      );
    }
  }
}
function install(options) {
  const target = path.resolve(options.target);
  if (options.uninstall) {
    uninstall(target, options.dryRun);
    return;
  }
  execFileSync("sqlite3", ["--version"], { stdio: "ignore" });
  const source = path.join(PACKAGE_ROOT, "module");
  if (!fs.existsSync(source)) {
    throw new Error("Build the organizer module before installation");
  }
  const existing = fs.existsSync(statePath(target))
    ? JSON.parse(fs.readFileSync(statePath(target), "utf8"))
    : null;
  const state = existing ||
    { files: [], backupRoot: `.allsorted-organizer-backups/${Date.now()}` };
  if (!options.dryRun) {
    fs.mkdirSync(target, { recursive: true });
    copyTree(
      source,
      path.join(target, "organizer"),
      state,
      target,
      path.join(target, state.backupRoot),
      false,
    );
    atomicWriteJson(statePath(target), state);
    execFileSync("node", [
      path.join(__dirname, "validate-organizer.js"),
      "--target",
      target,
    ], { stdio: "inherit" });
  }
}
if (require.main === module) {
  try {
    install(parse(process.argv.slice(2)));
    console.log("Organizer installation complete");
  } catch (e) {
    console.error(`organizer install: ${e.message}`);
    process.exit(1);
  }
}
module.exports = { parse, install, uninstall, removeEmptyParents };
