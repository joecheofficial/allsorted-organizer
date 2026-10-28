"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const hash = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

function limit(value, fallback, maximum, name) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(number) || number < 1 || number > maximum) throw new Error(`${name} must be between 1 and ${maximum}`);
  return number;
}

function checkpointPath(root, source) {
  if (!["mail", "calendar", "drive"].includes(source)) throw new Error("History paging supports mail, calendar and drive only");
  const directory = path.join(root, "state", "brain-history");
  for (const file of [path.join(root, "state"), directory, path.join(directory, `${source}.json`)]) {
    if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error("Linked history state is refused");
  }
  return path.join(directory, `${source}.json`);
}

function save(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, `${JSON.stringify(state)}\n`, { flag: "wx", mode: 0o600 }); fs.renameSync(temporary, file); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

async function pullHistory(options) {
  const file = checkpointPath(options.root, options.source);
  const fingerprint = hash(options.binding);
  const maxPages = limit(options.maxPages, 10, 100, "--max-pages");
  const maxItems = limit(options.maxItems, 1000, 10000, "--max-items");
  let state = { schemaVersion: 1, taskClass: "default_automation", fingerprint, pages: 0, read: 0, nextPageToken: null, seen: [], complete: false };
  if (fs.existsSync(file)) {
    const previous = JSON.parse(fs.readFileSync(file, "utf8"));
    if (options.resume) {
      if (previous.schemaVersion !== 1 || previous.fingerprint !== fingerprint) throw new Error("History resume query/account/detail differs. Repeat the original fixed window or start a new history read without --resume.");
      state = previous;
    } else if (!previous.complete && !options.restart) throw new Error("An unfinished history read exists. Use --resume with its original query, or --restart-history explicitly.");
    if (options.restart) state = { schemaVersion: 1, taskClass: "default_automation", fingerprint, pages: 0, read: 0, nextPageToken: null, seen: [], complete: false };
  } else if (options.resume) throw new Error("No history checkpoint exists to resume");
  const result = { state: options.plan ? "planned" : state.complete ? "complete" : "capped", complete: state.complete, pages: 0, read: 0, totalPages: state.pages, totalRead: state.read, notes: 0, written: 0, updated: 0, unchanged: 0, protected: 0, removed: 0, queryFingerprint: fingerprint, resumeAvailable: !state.complete };
  if (options.plan || state.complete) return result;
  const priorBytes = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  const release = options.acquire();
  try {
    if ((fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null) !== priorBytes) throw new Error("History checkpoint changed while acquiring its lease; retry");
    // Persist the exact binding even if the first page fails. No content is stored here.
    save(file, state);
    while (result.pages < maxPages && state.read < maxItems) {
      try {
        const page = await options.readPage(state.nextPageToken, Math.min(options.pageSize, maxItems - state.read));
        if (!Number.isInteger(page.read) || page.read < 0 || page.read > Math.min(options.pageSize, maxItems - state.read)) throw new Error("Provider page exceeds requested cap");
        const token = page.nextPageToken || null;
        if (token !== null && (typeof token !== "string" || token.length > 8192)) throw new Error("Invalid history page token");
        const tokenHash = token && hash(token);
        if (tokenHash && state.seen.includes(tokenHash)) throw new Error("Provider repeated a history page token; cursor preserved");
        const written = await options.writePage(page.items, hash([fingerprint, state.nextPageToken || "first"]).slice(0, 16));
        if (written.rejected?.length) throw new Error("Page contains rejected notes; cursor preserved for review");
        // Write notes first. A crash before this atomic checkpoint repeats safely.
        state = { ...state, pages: state.pages + 1, read: state.read + page.read, nextPageToken: token, seen: tokenHash ? [...state.seen, tokenHash] : state.seen, complete: page.complete === true && token === null };
        save(file, state);
        result.pages += 1; result.read += page.read;
        for (const key of ["notes", "written", "updated", "unchanged", "protected"]) result[key] += written[key] || 0;
        Object.assign(result, { totalPages: state.pages, totalRead: state.read, complete: state.complete, resumeAvailable: !state.complete });
        if (state.complete) { result.state = "complete"; break; }
        if (!token) { result.state = "capped"; result.resumeAvailable = false; break; }
      } catch (error) {
        result.state = error.retryDeferred ? "deferred" : "failed";
        result.complete = false;
        result.code = error.code || "HISTORY_PAGE_FAILED";
        result.reason = String(error.message).slice(0, 300);
        if (error.nextAttemptAt) result.nextAttemptAt = error.nextAttemptAt;
        break;
      }
    }
    result.warning = result.complete ? "Complete for this fixed query/window. History reads preserve earlier notes and do not delete them." : "History is incomplete. Earlier notes are preserved. Resume the same fixed query/window.";
    return result;
  } finally { release(); }
}

module.exports = { pullHistory };
