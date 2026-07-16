"use strict";

const fs = require("node:fs");
const path = require("node:path");

function backupTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function uniqueBackupPath(filePath, date = new Date()) {
  const base = `${filePath}.bak-${backupTimestamp(date)}`;
  let candidate = base;
  let suffix = 0;
  while (fs.existsSync(candidate)) {
    suffix += 1;
    candidate = `${base}-${suffix}`;
  }
  return candidate;
}

function backupExisting(filePath, options = {}) {
  if (!fs.existsSync(filePath)) return null;
  let backupPath = options.backupPath || uniqueBackupPath(filePath, options.date);
  if (options.backupPath && fs.existsSync(backupPath)) {
    let suffix = 1;
    while (fs.existsSync(`${options.backupPath}-${suffix}`)) suffix += 1;
    backupPath = `${options.backupPath}-${suffix}`;
  }
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

function backupIntoTree(filePath, targetRoot, backupRoot) {
  if (!fs.existsSync(filePath)) return null;
  const relativePath = path.relative(targetRoot, filePath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`Refusing to back up path outside target: ${filePath}`);
  }
  const backupPath = path.join(backupRoot, relativePath);
  return backupExisting(filePath, { backupPath });
}

module.exports = { backupTimestamp, uniqueBackupPath, backupExisting, backupIntoTree };
