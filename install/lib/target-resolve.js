"use strict";

const fs = require("node:fs");
const path = require("node:path");

function pathExists(filePath) {
  try { fs.accessSync(filePath); return true; } catch { return false; }
}

function validateTargetShape(targetDir, shape = {}) {
  if (!targetDir || !pathExists(targetDir)) return false;
  for (const relativePath of shape.requiredPaths || []) {
    if (!pathExists(path.join(targetDir, relativePath))) return false;
  }
  for (const group of shape.anyOf || []) {
    if (!group.some((relativePath) => pathExists(path.join(targetDir, relativePath)))) return false;
  }
  return true;
}

function resolveTargetDir(explicitTarget, config = {}) {
  if (explicitTarget) {
    const resolved = path.resolve(explicitTarget);
    if (validateTargetShape(resolved, config.shape)) return resolved;
    throw new Error(config.notFoundMessage || `Explicit target is not compatible: ${resolved}`);
  }
  const candidates = [];
  let cursor = process.cwd();
  const parentDepth = Number.isInteger(config.parentDepth) ? config.parentDepth : 5;
  for (let depth = 0; depth <= parentDepth; depth += 1) {
    candidates.push(cursor);
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  const roots = [...new Set(candidates)];
  for (const root of roots) {
    for (const hint of config.childHints || []) candidates.push(path.join(root, hint));
  }
  for (const candidate of [...new Set(candidates)]) {
    if (validateTargetShape(candidate, config.shape)) return candidate;
  }
  throw new Error(config.notFoundMessage || "Could not find a compatible target. Re-run with --target <path>.");
}

module.exports = { pathExists, validateTargetShape, resolveTargetDir };
