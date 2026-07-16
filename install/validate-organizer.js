#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const spec = require("../module.spec.json");

function parse(argv) {
  const targetAt = argv.indexOf("--target");
  const workspaceAt = argv.indexOf("--workspace");
  return { target: path.resolve(targetAt >= 0 ? argv[targetAt + 1] : workspaceAt >= 0 ? argv[workspaceAt + 1] : path.join(process.env.HOME || ".", ".myos-dispatch")) };
}

function validate({ target }) {
  execFileSync("sqlite3", ["--version"], { stdio: "ignore" });
  for (const file of spec.validate.requiredFiles) if (!fs.existsSync(path.join(target, file))) throw new Error(`Missing ${file}`);
  for (const assertion of spec.validate.assertions) if (!fs.readFileSync(path.join(target, assertion.file), "utf8").includes(assertion.contains)) throw new Error(assertion.message);

  // Index only a disposable copy. Validation must never add a DB or capability
  // index to the member's production workspace.
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "allsorted-organizer-validate-"));
  try {
    const organizer = path.join(workspace, "organizer");
    fs.cpSync(path.join(target, "organizer"), organizer, { recursive: true });
    execFileSync(process.execPath, [path.join(organizer, "bin", "organizer.js"), "index", "--dir", organizer, "--workspace", workspace], { stdio: "ignore" });
    if (!fs.existsSync(path.join(workspace, "myos-brain.db")) || !fs.existsSync(path.join(workspace, "capabilities-index.json"))) throw new Error("Organizer index output missing");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
  return true;
}

if (require.main === module) {
  try { validate(parse(process.argv.slice(2))); console.log("Organizer validation passed"); }
  catch (error) { console.error(`organizer validate: ${error.message}`); process.exit(1); }
}

module.exports = { parse, validate };
