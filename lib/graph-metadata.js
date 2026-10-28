"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { readJson, writeJson } = require("./extraction");
function stamp(file) { const stat = fs.statSync(file, { bigint: true }); return `${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.ino}`; }
function scan(dir, types, persist = false) {
  const cacheFile = path.join(path.dirname(dir), "state", "brain-graph-metadata.json");
  const prior = readJson(cacheFile, { version: 1, files: {} });
  const files = {};
  const counts = { notes: 0, wikilinks: 0, brokenWikilinks: 0, proposed: 0, byType: {} };
  const resolvable = new Set();
  let bodiesRead = 0;
  for (const folder of Object.values(types)) {
    counts.byType[folder] = 0;
    const directory = path.join(dir, folder);
    if (!fs.existsSync(directory)) continue;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      if (entry.name.endsWith(".proposed.md")) { counts.proposed += 1; continue; }
      const key = `${folder}/${entry.name.slice(0, -3)}`;
      const file = path.join(directory, entry.name);
      const signature = stamp(file);
      let record = prior.version === 1 && prior.files[key]?.stamp === signature ? prior.files[key] : null;
      if (!record) {
        const text = fs.readFileSync(file, "utf8");
        bodiesRead += 1;
        const frontMatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] || "";
        // Ignore fenced blocks and inline code, like the brain's link counter.
        const prose = text.replace(/(^|\n)(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\2[^\n]*(?=\n|$)/g, "").replace(/`[^`\n]*`/g, "");
        const targets = [...prose.matchAll(/(?<!!)\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)].map(match => match[1].trim());
        record = { stamp: signature, frontMatter, targets };
      }
      files[key] = record;
      resolvable.add(key.toLowerCase().normalize("NFC"));
      resolvable.add(entry.name.slice(0, -3).toLowerCase().normalize("NFC"));
      counts.notes += 1;
      counts.byType[folder] += 1;
    }
  }
  for (const record of Object.values(files)) for (const target of record.targets) {
    counts.wikilinks += 1;
    if (!resolvable.has(target.replace(/\.md$/i, "").toLowerCase().normalize("NFC"))) counts.brokenWikilinks += 1;
  }
  for (const folder of ["decisions", "ideas"]) if (!counts.byType[folder]) delete counts.byType[folder];
  if (persist) writeJson(cacheFile, { version: 1, files });
  return { counts, files, bodiesRead };
}
function safeProjectionKey(key) {
  const parts = String(key).split("/");
  return parts.length === 2 && /^[a-z]+$/.test(parts[0]) && parts[1] && ![".", ".."].includes(parts[1]) && !/[\\\u0000]/.test(parts[1]);
}
function project(root, records) {
  const directory = path.join(root, "state", "brain-graph-input");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const manifestFile = path.join(directory, ".projection.json");
  const prior = readJson(manifestFile, { keys: [] });
  const keys = Object.keys(records);
  const present = new Set(keys);
  for (const key of prior.keys) {
    if (!present.has(key) && safeProjectionKey(key)) fs.rmSync(path.join(directory, key + ".md"), { force: true });
  }
  for (const [key, record] of Object.entries(records)) {
    if (!safeProjectionKey(key)) continue;
    const file = path.join(directory, key + ".md");
    const text = `---\n${record.frontMatter}\n---\n`;
    let current = null;
    try { current = fs.readFileSync(file, "utf8"); } catch { /* first projection */ }
    if (current !== text) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text, { mode: 0o600 }); }
  }
  fs.writeFileSync(path.join(directory, "README.md"), '---\ntitle: "Brain index"\nkg:\n  id: "brain:readme"\n  type: "index"\n  status: "active"\n  audience: "private"\n---\n', { mode: 0o600 });
  writeJson(manifestFile, { keys });
  return directory;
}
module.exports = { scan, project, stamp };
