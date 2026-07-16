"use strict";

const fs = require("node:fs");
const path = require("node:path");

function atomicWrite(filePath, content, options = {}) {
  const encoding = options.encoding || "utf8";
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tempPath, content, encoding);
  try {
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try { fs.unlinkSync(tempPath); } catch { /* best effort */ }
    throw error;
  }
}

function atomicWriteJson(filePath, value) {
  atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

module.exports = { atomicWrite, atomicWriteJson };

