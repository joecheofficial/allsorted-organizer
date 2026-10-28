#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { index, audit, add } = require("../lib/organizer");
function arg(name) {
  const i = process.argv.indexOf(name);
  return i < 0 ? null : process.argv[i + 1];
}
try {
  const command = process.argv[2],
    workspace = arg("--workspace") || process.env.MYOS_DISPATCH_HOME ||
      path.join(process.env.HOME || ".", ".myos-dispatch");
  if (command === "index") {
    const dir = arg("--dir");
    if (!dir) throw new Error("index requires --dir");
    // `index` replaces the capabilities index Dispatch routes from. Indexing some
    // other folder into the live install by default (the environment or
    // ~/.myos-dispatch) silently swaps the customer's routing for that folder's
    // contents. So indexing a folder other than the workspace needs an explicit
    // --workspace naming where the index goes.
    const real = (value) => { try { return fs.realpathSync(path.resolve(value)); } catch { return path.resolve(value); } };
    if (!arg("--workspace") && real(dir) !== real(workspace)) {
      throw new Error(`index --dir ${path.resolve(dir)} would replace the live capabilities index in ${path.resolve(workspace)}. Pass --workspace <folder> explicitly (use a scratch folder to index anything that is not the install root).`);
    }
    console.log(
      JSON.stringify(
        index({ dir: path.resolve(dir), workspace: path.resolve(workspace) }),
      ),
    );
  } else if (command === "audit") {
    const errors = audit({ workspace: path.resolve(workspace) });
    if (errors.length) {
      console.error(errors.join("\n"));
      process.exit(1);
    }
    console.log("Organizer audit passed");
  } else if (command === "add") {
    const type = arg("--type"), raw = arg("--json");
    if (!raw) throw new Error("add requires --json");
    add({ workspace: path.resolve(workspace), type, row: JSON.parse(raw) });
    console.log("Organizer row added");
  } else if (command === "reconcile-index") {
    const dir = arg("--dir"), dryRun = process.argv.includes("--dry-run");
    if (!dir) throw new Error("reconcile-index requires --dir");
    const { runRecipe } = require("../recipes/reconcile-index.js");
    runRecipe({
      args: { dir: path.resolve(dir), workspace: path.resolve(workspace), dryRun },
    }).then((result) => {
      console.log(JSON.stringify(result));
      if (result.ok === false || result.status !== "ok") process.exitCode = 1;
    }).catch((error) => {
      console.error(`organizer: ${error.message}`);
      process.exitCode = 1;
    });
  } else if (command === "schedule-nightly") {
    const dir = arg("--dir"), remove = process.argv.includes("--remove");
    if (!dir) throw new Error("schedule-nightly requires --dir");
    const { runRecipe } = require("../recipes/schedule-nightly.js");
    runRecipe({
      args: { dir: path.resolve(dir), workspace: path.resolve(workspace), remove },
    }).then((result) => {
      console.log(JSON.stringify(result));
      if (result.ok === false || result.status !== "ok") process.exitCode = 1;
    }).catch((error) => {
      console.error(`organizer: ${error.message}`);
      process.exitCode = 1;
    });
  } else if (command === "brain") {
    // The second brain has its own command line: organizer brain <command>.
    require("./brain.js").main(process.argv.slice(3)).then((code) => {
      process.exitCode = code;
    }).catch((error) => {
      console.error(`brain: ${error.message}`);
      process.exitCode = 1;
    });
  } else throw new Error("Usage: organizer index|audit|add|reconcile-index|schedule-nightly|brain");
} catch (error) {
  console.error(`organizer: ${error.message}`);
  process.exit(1);
}
