"use strict";
const os = require("node:os");
const path = require("node:path");

// A recipe running against a customer's own tree has no fixed workspace
// path to assume. dir defaults to the current working directory (the tree
// the caller invoked this from); workspace (where the sqlite database and
// generated capabilities-index.json land) defaults to MYOS_DISPATCH_HOME
// or ~/.myos-dispatch, matching bin/organizer.js.
function resolveTargets(args = {}) {
  const dir = path.resolve(args.dir || process.cwd());
  const workspace = path.resolve(
    args.workspace || process.env.MYOS_DISPATCH_HOME ||
      path.join(os.homedir(), ".myos-dispatch"),
  );
  return { dir, workspace };
}

module.exports = { resolveTargets };
