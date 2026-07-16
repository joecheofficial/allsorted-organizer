#!/usr/bin/env node
"use strict";
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
  } else throw new Error("Usage: organizer index|audit|add");
} catch (error) {
  console.error(`organizer: ${error.message}`);
  process.exit(1);
}
