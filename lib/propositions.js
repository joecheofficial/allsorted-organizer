"use strict";
const fs = require("node:fs");
const path = require("node:path");
const brain = require("./brain");
const MAX_NOTES = 500;
const MAX_EVIDENCE_BYTES = 4 * 1024 * 1024;
function keyFor(value, type) {
  if (typeof value !== "string" || value.split("/").length !== 2) return null;
  const [folder, slug] = value.split("/");
  if (!slug || brain.slugify(slug) !== slug) return null;
  return (!type || brain.TYPE_DIRS[type] === folder) && Object.values(brain.TYPE_DIRS).includes(folder) ? value : null;
}
function sourceFile(root, key) {
  const dir = path.join(root, "brain");
  const file = path.join(dir, key + ".md");
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_EVIDENCE_BYTES) return null;
    const real = fs.realpathSync(file);
    if (!real.startsWith(fs.realpathSync(dir) + path.sep)) return null;
    return file;
  } catch { return null; }
}
function validate(options = {}) {
  const root = path.resolve(options.root || brain.defaultRoot());
  const proposal = options.proposal;
  const errors = [];
  const fail = (at, reason) => errors.push({ at, reason });
  if (!proposal || proposal.schemaVersion !== 1 || proposal.reviewed !== true || !Array.isArray(proposal.notes) || proposal.notes.length > MAX_NOTES) return { ok: false, errors: [{ at: "proposal", reason: "A version 1, explicitly reviewed proposal with at most 500 notes is required." }], items: [] };
  const declared = new Set();
  const read = new Map();
  const citations = (evidence, at) => {
    if (!Array.isArray(evidence) || !evidence.length || evidence.length > 20) { fail(at, "One to twenty quoted source citations are required."); return []; }
    const kept = [];
    for (const [index, entry] of evidence.entries()) {
      const key = keyFor(entry?.note);
      const quote = typeof entry?.quote === "string" ? entry.quote.trim() : "";
      if (!key || quote.length < 12 || quote.length > 2000 || brain.isSecretLine(quote)) { fail(`${at}.${index}`, "An exact source note key and a safe quote of 12 to 2000 characters are required."); continue; }
      if (!read.has(key)) { const file = sourceFile(root, key); read.set(key, file ? fs.readFileSync(file, "utf8") : null); }
      const text = read.get(key);
      if (text === null || !text.includes(quote)) { fail(`${at}.${index}`, "The source does not exist, is unsafe, or does not contain the exact quote."); continue; }
      kept.push({ note: key, quote });
    }
    return kept;
  };
  for (const [index, note] of proposal.notes.entries()) {
    const key = keyFor(note?.id, note?.type);
    if (!key || !brain.TYPE_DIRS[note?.type]) fail(`notes.${index}.id`, "ID must be an exact path in its type folder; names and inferred identity are not accepted.");
    else if (declared.has(key)) fail(`notes.${index}.id`, "Duplicate entity ID is ambiguous.");
    else declared.add(key);
  }
  const items = [];
  for (const [index, note] of proposal.notes.entries()) {
    const at = `notes.${index}`;
    if (!note || typeof note.title !== "string" || !note.title.trim() || note.title.length > 120 || brain.isSecretLine(note.title)) { fail(at, "A safe title of at most 120 characters is required."); continue; }
    const evidence = citations(note.evidence, `${at}.evidence`);
    const relations = [];
    if (note.relations !== undefined && (!Array.isArray(note.relations) || note.relations.length > 100)) { fail(`${at}.relations`, "Relations must be an array of at most 100 entries."); continue; }
    for (const [position, relation] of (note.relations || []).entries()) {
      const target = keyFor(relation?.target);
      if (!brain.RELATION_TYPES.has(relation?.type) || !target || target === note.id || (!declared.has(target) && !sourceFile(root, target))) { fail(`${at}.relations.${position}`, "Use a supported relation type and an existing exact target ID; unresolved or ambiguous targets are withheld."); continue; }
      const cited = citations(relation.evidence, `${at}.relations.${position}.evidence`);
      relations.push({ type: relation.type, target });
      evidence.push(...cited);
    }
    const body = typeof note.body === "string" ? note.body : "";
    const summary = typeof note.summary === "string" ? note.summary : "";
    if (body.length > 20000 || summary.length > 400) fail(at, "Proposal text exceeds the note limits.");
    const unique = [...new Map(evidence.map(entry => [`${entry.note}:${entry.quote}`, entry])).values()];
    items.push({ note: note.id, type: note.type, title: note.title, summary, body: `${body}\n\n## Reviewed evidence\n\n${unique.map(entry => `- [[${entry.note}]]: ${entry.quote.replace(/\r?\n/g, " ")}`).join("\n")}`, source: unique.map(entry => `${entry.note}.md: ${entry.quote.replace(/\r?\n/g, " ")}`), tags: ["reviewed-evidence"], ...(note.relations !== undefined ? { relations } : {}) });
  }
  return { ok: errors.length === 0, errors, items: errors.length ? [] : items };
}
async function importProposal(options = {}) {
  const checked = validate(options);
  if (!checked.ok) return { ok: false, command: "import", plan: options.plan === true, errors: checked.errors, notes: 0, network: false };
  if (options.plan === true) return { ok: true, command: "import", plan: true, notes: checked.items.length, relations: checked.items.reduce((sum, item) => sum + (item.relations || []).length, 0), errors: [], network: false };
  const result = await brain.add({ ...options, items: checked.items });
  return { ...result, command: "import", ok: result.rejected.length === 0 && result.unresolved.length === 0, evidenceValidated: true, reviewed: true, network: false };
}
function propose(options = {}) {
  const root = path.resolve(options.root || brain.defaultRoot());
  const state = brain.readRunRecord(root, "brain-extraction.json");
  return { ok: true, command: "propose", schemaVersion: 1, network: false, instructions: "Read selected source notes locally with any assistant. Propose people, projects, decisions and ideas using distinct exact IDs. Cite exact text for every entity and relationship. Withhold uncertain identity and unsupported links. Review before marking reviewed:true, then run brain import --plan and brain import. Citation presence is validated; factual entailment is your review responsibility.", proposal: { schemaVersion: 1, reviewed: false, notes: [] }, noteTypes: brain.TYPE_DIRS, relationTypes: [...brain.RELATION_TYPES], extractionComplete: state?.complete ?? null, citation: { note: "sources/exact-note-key", quote: "Exact source text, at least twelve characters." }, note: { id: "decisions/exact-slug", type: "decision", title: "Decision title", summary: "Supported claim", evidence: [], relations: [{ type: "supports", target: "projects/exact-project-id", evidence: [] }] } };
}
module.exports = { validate, importProposal, propose, keyFor };
