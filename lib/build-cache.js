"use strict";
const path = require("node:path");
const crypto = require("node:crypto");
const { readJson, writeJson, fileHash } = require("./extraction");
const { stamp } = require("./graph-metadata");
function prepare(root, notes, state, session, represented, truncated, maxNoteBytes) {
  const cacheFile = path.join(root, "state", "brain-build-cache.json");
  const prior = readJson(cacheFile, { version: 1, notes: {} });
  const planned = {};
  const active = new Map();
  const titles = [...notes.values()].map(note => [note.key, note.title]).sort();
  const titleHash = crypto.createHash("sha256").update(JSON.stringify(titles)).digest("hex");
  for (const [key, note] of notes) {
    const files = (note.load?.documentLoads || (note.load ? [note.load] : [])).flatMap(load => load.documentFiles || []);
    const input = files.map(file => { const row = session.load(file).row; return [file, row.sha256, row.truncated]; });
    const signature = crypto.createHash("sha256").update(JSON.stringify({ version: 1, note, input, maxNoteBytes, titleHash })).digest("hex");
    const file = path.join(root, "brain", key + ".md");
    let currentStamp = null;
    try { currentStamp = stamp(file); } catch { /* new */ }
    const record = state.notes[key + ".md"];
    const old = prior.notes[key];
    const reusable = prior.version === 1 && old?.signature === signature && old.stamp === currentStamp && old.hash === record?.hash && record?.origin === "build";
    planned[key] = { signature, file, reusable, sourceFiles: files };
    if (reusable) for (const [source, , cut] of input) { represented.add(source); if (cut || old.truncatedFiles?.includes(source)) truncated.add(source); }
    else active.set(key, note);
  }
  return { active, skipped: notes.size - active.size, finish() {
    const next = {};
    for (const [key, entry] of Object.entries(planned)) {
      const record = state.notes[key + ".md"];
      if (record?.origin !== "build") continue;
      try {
        // A protected manual edit must never become a reusable generated output.
        if (!entry.reusable && fileHash(entry.file) !== record.hash) continue;
        next[key] = { signature: entry.signature, stamp: stamp(entry.file), hash: record.hash, truncatedFiles: entry.sourceFiles.filter(file => truncated.has(file)) };
      } catch { /* missing note */ }
    }
    writeJson(cacheFile, { version: 1, notes: next });
  } };
}
module.exports = { prepare };
