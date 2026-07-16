"use strict";

const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { pathExists } = require("./target-resolve");

function detectPackageManager(targetDir) {
  if (pathExists(path.join(targetDir, "pnpm-lock.yaml"))) return { command: "pnpm", args: ["install"] };
  if (pathExists(path.join(targetDir, "yarn.lock"))) return { command: "yarn", args: ["install"] };
  return { command: "npm", args: ["install"] };
}

function installDependencies(targetDir, options = {}) {
  const manager = detectPackageManager(targetDir);
  if (options.dryRun) return manager;
  execFileSync(manager.command, manager.args, { cwd: targetDir, stdio: "inherit" });
  return manager;
}

module.exports = { detectPackageManager, installDependencies };

