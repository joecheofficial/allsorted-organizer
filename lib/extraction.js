"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const BINARY = new Set([".pdf", ".docx", ".pptx", ".xlsx"]);
const MAX_BINARY_BYTES = 64 * 1024 * 1024;
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
function fileHash(file) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  const chunk = Buffer.alloc(64 * 1024);
  try { let count; while ((count = fs.readSync(fd, chunk, 0, chunk.length, null))) hash.update(chunk.subarray(0, count)); }
  finally { fs.closeSync(fd); }
  return hash.digest("hex");
}
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } }
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function pythonFor(root) {
  const local = path.join(root, "state", "document-helpers", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  return fs.existsSync(local) ? local : "python3";
}
function helpers(options = {}) {
  const root = path.resolve(options.root || process.env.MYOS_DISPATCH_HOME || path.join(os.homedir(), ".myos-dispatch"));
  const run = options.run || spawnSync;
  const python = options.python || pythonFor(root);
  if (options.install === true) {
    const environment = path.join(root, "state", "document-helpers");
    fs.mkdirSync(path.dirname(environment), { recursive: true });
    const created = run("python3", ["-m", "venv", environment], { encoding: "utf8", timeout: 60000 });
    if (created.status !== 0) throw new Error("Python virtual environment setup failed. Install Python 3 with venv support.");
    const installed = run(pythonFor(root), ["-m", "pip", "install", "pypdf>=5,<7", "python-docx>=1,<2", "openpyxl>=3,<4", "python-pptx>=1,<2"], { encoding: "utf8", timeout: 120000 });
    if (installed.status !== 0) throw new Error("Local document readers could not be installed. Check pip access and retry helpers --install.");
  }
  const selected = options.install ? pythonFor(root) : python;
  const probe = run(selected, ["-c", "import json,importlib.util,shutil;print(json.dumps({'readers':{n:importlib.util.find_spec(n) is not None for n in ['pypdf','docx','openpyxl','pptx']},'ocr':{n:shutil.which(n) is not None for n in ['pdftoppm','tesseract']}}))"], { encoding: "utf8", timeout: 10000 });
  let dependencies = { readers: {}, ocr: {} };
  try { dependencies = JSON.parse(probe.stdout); } catch { /* Python unavailable */ }
  return { ok: probe.status === 0, command: "helpers", python: selected, installed: options.install === true, network: options.install === true, ...dependencies, hint: "Use brain helpers --install to opt in to install-local Python readers. For OCR install Poppler and Tesseract (macOS: brew install poppler tesseract). Reading documents never uses the network." };
}
function createSession(root, options = {}) {
  const folder = path.join(root, "state", "brain-extraction-cache");
  const helper = path.join(__dirname, "..", "helpers", "extract-document.py");
  const maxChars = Math.min(2000000, Math.max(1, options.maxExtractChars || options.maxNoteBytes || 200 * 1024));
  const maxUnits = Math.min(10000, Math.max(1, options.maxExtractUnits || 1000));
  const signature = digest(JSON.stringify([fileHash(helper), maxChars, maxUnits, options.ocr === true]));
  const previous = readJson(path.join(folder, "files.json"), { files: {} });
  const seen = new Map();
  const rows = [];
  const receipt = { schemaVersion: 1, taskClass: "default_automation", intent: "brain_extraction", at: new Date().toISOString(), status: "running", progress: { processed: 0, total: 0 }, enabled: options.extract === true, ocr: options.ocr === true, files: rows, counts: {}, complete: false, errors: [] };
  const publish = () => writeJson(path.join(root, "state", "brain-extraction.json"), receipt);
  publish();
  function load(file) {
    if (seen.has(file)) return seen.get(file);
    const format = path.extname(file).toLowerCase().slice(1);
    const binary = BINARY.has(`.${format}`);
    const row = { path: file, sha256: null, format, status: "failed", characters: 0, units: 0, ocrUnits: 0, truncated: false, cacheHit: false, error: null };
    rows.push(row);
    let text = null;
    let cache;
    try {
      const info = fs.lstatSync(file);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("Source must remain a regular file.");
      if (info.size > (binary ? MAX_BINARY_BYTES : 1024 * 1024)) row.status = "too_large";
      else if (binary && options.extract !== true) row.status = "disabled";
      else {
        row.sha256 = fileHash(file);
        const id = digest(`${row.sha256}:${binary ? signature : "text-v1"}:${format}`);
        cache = path.join(folder, id + ".json");
        let output = readJson(cache, null);
        if (output?.status === "extracted" && typeof output.text === "string" && (binary || !output.truncated)) { row.cacheHit = true; }
        else if (binary) {
          const run = options.extractRunner || spawnSync;
          const call = run(options.python || pythonFor(root), [helper, file, String(maxChars), String(maxUnits), String(options.ocr === true)], { encoding: "utf8", timeout: options.extractTimeoutMs || 120000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, OMP_THREAD_LIMIT: "1" } });
          if (call.status !== 0) output = { status: call.error?.code === "ENOENT" ? "missing_dependency" : "failed", error: call.error?.code === "ENOENT" ? "Python 3 is unavailable. Use brain helpers to inspect setup." : "Local document helper failed or timed out.", text: "" };
          else { try { output = JSON.parse(call.stdout); } catch { output = { status: "failed", error: "Document helper returned invalid JSON.", text: "" }; } }
        } else {
          const bytes = fs.readFileSync(file);
          output = bytes.subarray(0, 8192).includes(0) ? { status: "corrupt", text: "", error: "Binary content in a text file." } : { status: "extracted", text: bytes.toString("utf8"), units: 1, truncated: false };
        }
        if (!output || !["extracted", "missing_dependency", "encrypted", "corrupt", "empty", "failed", "too_large"].includes(output.status) || typeof output.text !== "string") output = { status: "failed", text: "", error: "Invalid helper result." };
        if (binary && output.text.length > maxChars) output = { ...output, text: output.text.slice(0, maxChars), truncated: true };
        if (output.status === "extracted" && !output.text.trim()) output = { ...output, status: "empty", error: "No document text was recovered." };
        Object.assign(row, { status: row.cacheHit ? "cached" : output.status, outcome: output.status, characters: output.text.length, units: output.units || 0, ocrUnits: output.ocrUnits || 0, truncated: output.truncated === true, error: output.error || null });
        if (output.status === "extracted") { if (!row.cacheHit) writeJson(cache, output); text = output.text; }
      }
    } catch { row.status = "failed"; row.error = "Document could not be read."; }
    if (row.status === "disabled") row.error = "Binary extraction is off. Enable --extract to include this document.";
    if (row.status === "too_large") row.error = "Document exceeds the local input size limit.";
    const value = { row, cache, text };
    seen.set(file, value);
    receipt.progress.processed = rows.length;
    if (rows.length % 25 === 0) publish();
    return value;
  }
  return {
    load,
    start(total) { receipt.progress.total = total; publish(); },
    describe(file, describe, relative = "") {
      const loaded = load(file);
      if (loaded.text === null) return null;
      const descriptionFile = loaded.cache + "." + digest(relative).slice(0, 16) + ".description.json";
      const prior = readJson(descriptionFile, null);
      const description = prior?.version === 1 ? prior.value : describe(loaded.text === undefined ? readJson(loaded.cache, {}).text || "" : loaded.text);
      if (!prior || prior.version !== 1) writeJson(descriptionFile, { version: 1, value: description });
      // Release body strings between files; the cache is the only body store.
      loaded.text = undefined;
      return description;
    },
    text(file) {
      const loaded = load(file);
      if (loaded.text === null) return null;
      return readJson(loaded.cache, {}).text ?? loaded.text ?? null;
    },
    finish(total = rows.length) {
      receipt.progress = { processed: rows.length, total };
      receipt.files = rows;
      receipt.errors = rows.filter(row => !["extracted", "cached"].includes(row.status)).map(row => ({ path: row.path, code: row.status, message: row.error }));
      receipt.counts = { selected: total, extracted: rows.filter(row => row.status === "extracted").length, cached: rows.filter(row => row.status === "cached").length, failed: receipt.errors.length, truncated: rows.filter(row => row.truncated).length };
      receipt.complete = rows.length === total && receipt.errors.length === 0 && receipt.counts.truncated === 0;
      receipt.status = receipt.complete ? "done" : "degraded";
      receipt.changes = { added: rows.filter(row => !previous.files[row.path]).length, changed: rows.filter(row => previous.files[row.path] && previous.files[row.path].sha256 !== row.sha256).length, unchanged: rows.filter(row => previous.files[row.path]?.sha256 && previous.files[row.path].sha256 === row.sha256).length, deleted: Object.keys(previous.files).filter(file => !seen.has(file) && !fs.existsSync(file)) };
      writeJson(path.join(folder, "files.json"), { files: Object.fromEntries(rows.map(row => [row.path, row])) });
      publish();
      return receipt;
    },
  };
}
module.exports = { BINARY, MAX_BINARY_BYTES, createSession, helpers, fileHash, readJson, writeJson };
