"use strict";
const path = require("node:path");
const brain = require("../lib/brain");
const { resolveTargets } = require("./_helpers");

// Opens the second brain folder in Obsidian, on the graph view. The viewer is
// installed only when args.install is true; otherwise a missing viewer just
// gets the one line that installs it.
module.exports.runRecipe = async function runRecipe(input = {}) {
  const args = input.args || {};
  const root = path.resolve(args.root || resolveTargets(args).workspace);
  try {
    const result = brain.open({ root, launch: args.launch !== false, install: args.install === true });
    return { status: "ok", reply: result.message, artifacts: [{ type: "document", label: "Second brain folder", url: `file://${result.brain}` }], metadata: { ...result, network: false } };
  } catch (error) {
    return { status: "error", reply: `The second brain could not be opened: ${error.message}`, artifacts: [], metadata: { code: "BRAIN_OPEN_FAILED", root } };
  }
};
