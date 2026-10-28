"use strict";

// The second brain: a plain folder of markdown notes at <root>/brain.
//
// It is a git repository and nothing else. Copy or move that one folder and the
// whole brain moves with it, because every note carries the text of the
// document it came from, not just a pointer to it. Every note also carries:
//
//   1. `kg` front matter (id, audience, relations), which is what the Atelier
//      knowledge graph reads to draw edges.
//   2. A "Related" section of wikilinks, which is what people and the Obsidian
//      graph view read.
//
// Nothing here calls an AI service. Notes come from deterministic reading of
// documents the customer points at (headings, links between files, folder
// structure, front matter already present), and from `add`, where the
// assistant running the build passes in what it understood.
//
// A note a person edited is never overwritten: every written note is tracked
// with a content hash in <root>/brain/.brain-state.json, and when the hash on
// disk no longer matches, the new version lands beside it as *.proposed.md.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const STATE_FILE = ".brain-state.json";
// The pause between note writes, so an open graph view shows notes arriving.
// Small brains get a slow, watchable build. The pauses of one build never add
// up to more than about ninety seconds, however many notes there are.
const MAX_PACE_MS = 400;
const PACE_BUDGET_MS = 90 * 1000;
const STATE_SAVE_EVERY = 25;
const OBSIDIAN_RELEASES = "https://api.github.com/repos/obsidianmd/obsidian-releases/releases?per_page=15";
const OBSIDIAN_DOWNLOAD_PREFIX = "https://github.com/obsidianmd/obsidian-releases/releases/download/";
// Where a release download may end up after redirects. Anything else is refused.
const OBSIDIAN_DOWNLOAD_HOSTS = new Set(["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"]);
// The Obsidian desktop app as its publisher signs it. An app that does not
// carry exactly this identity is never copied into Applications.
const OBSIDIAN_IDENTIFIER = "md.obsidian";
const OBSIDIAN_TEAM = "6JSW4SJWN9";
const DEFAULT_MAX_FILES = 2000;
const DEFAULT_MAX_NOTE_BYTES = 200 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
const extraction = require("./extraction");
const TYPE_DIRS = { decision: "decisions", idea: "ideas", project: "projects", person: "people", company: "companies", topic: "topics", source: "sources" };
const TYPE_ORDER = ["decision", "idea", "topic", "project", "company", "person", "source"];
const TYPE_ALIASES = { decisions: "decision", ideas: "idea", projects: "project", people: "person", persons: "person", companies: "company", organisation: "company", organization: "company", topics: "topic", sources: "source", document: "source", note: "source" };
const KG_TYPES = { decision: "document", idea: "document", project: "document", person: "document", company: "document", topic: "document", source: "source" };
const RELATION_TYPES = new Set(["related", "supports", "supersedes", "implements", "depends_on", "evidences", "contradicts", "belongs_to"]);
const READABLE_EXTENSIONS = new Set([".md", ".markdown", ".txt", ...extraction.BINARY]);
const SKIP_DIRECTORIES = new Set(["node_modules", "dist", "build", "out", "target", "vendor", "__pycache__", "atelier-output"]);
const PROJECT_FOLDERS = new Set(["projects"]);
const PERSON_FOLDERS = new Set(["people", "contacts", "team", "staff"]);
const COMPANY_FOLDERS = new Set(["companies", "clients", "customers", "vendors", "organizations", "organisations", "partners"]);
const FRONT_PAGES = ["context", "readme", "index"];
const PERSON_KEYS = new Set(["author", "authors", "owner", "owners", "people", "attendees", "with", "contact", "contacts", "lead", "assignee"]);
const COMPANY_KEYS = new Set(["company", "companies", "client", "clients", "customer", "customers", "organization", "organisation", "vendor", "vendors", "partner", "partners"]);
// Words for tools and roles. A name made only of these is never a person.
const NOT_PEOPLE = new Set(["assistant", "agent", "bot", "codex", "claude", "chatgpt", "gpt", "gemini", "copilot", "system", "admin", "user", "team", "support"]);
// Names that mark a file as holding keys or logins. These are never opened.
const SECRET_FILE = /^(?:\.env(?:\..*)?|.*\.env|\.npmrc|\.netrc|\.pypirc|\.htpasswd|id_(?:rsa|dsa|ecdsa|ed25519).*|.*\.(?:pem|key|p12|pfx|keystore|jks|kdbx|asc|gpg|crt|cer)|.*(?:secret|credential|password|passwd|passphrase|token|apikey|api[-_ ]key|private[-_ ]?key|recovery[-_ ]?code|backup[-_ ]?code|seed[-_ ]?phrase|mnemonic|2fa|wallet).*)$/i;
// Lines that hold a key, token or password. Three shapes: a value with a known
// key prefix, a name that says secret assigned a value (env, YAML, JSON, code),
// and a secret carried in a link. A line that matches is never kept.
const SECRET_LINE = new RegExp([
  String.raw`\bsk-ant-[A-Za-z0-9_-]{16,}`,
  String.raw`\bsk-(?:proj-|svcacct-|admin-|live-|test-)?[A-Za-z0-9_-]{20,}`,
  String.raw`\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}`,
  String.raw`\bwhsec_[A-Za-z0-9]{16,}`,
  String.raw`\bgithub_pat_[A-Za-z0-9_]{20,}`,
  String.raw`\bgh[pousr]_[A-Za-z0-9]{20,}`,
  String.raw`\bglpat-[A-Za-z0-9_-]{16,}`,
  String.raw`\bxox[abeprs]-[A-Za-z0-9-]{10,}`,
  String.raw`\bAIza[0-9A-Za-z_-]{30,}`,
  String.raw`\b(?:AKIA|ASIA)[0-9A-Z]{16}\b`,
  String.raw`\bya29\.[0-9A-Za-z_-]{20,}`,
  String.raw`\bEAA[A-Za-z0-9]{40,}`,
  String.raw`\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}`,
  String.raw`\bnpm_[A-Za-z0-9]{30,}`,
  String.raw`\bhf_[A-Za-z0-9]{30,}`,
  String.raw`\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}`,
  String.raw`\bbearer\s+[A-Za-z0-9._~+/=-]{16,}`,
  String.raw`\b\d{8,10}:AA[A-Za-z0-9_-]{30,}`,
  // A field named for a secret (DB_PASSWORD, "api_key", client_secret,
  // OPENAI_KEY) given a value that looks like one: no spaces, and at least
  // eight characters with a digit, or twelve or more with mixed case or a symbol.
  // A bare "key" is not a secret name (key=user-42, sport keys:). "Secretary:
  // Margaret Smith", "max_tokens: 4096" and a value that only names where the
  // key lives ($SUPABASE_KEY, EVOLUTION_API_KEY, process.env.X, <your key>)
  // are ordinary text and stay.
  String.raw`\|\s*(?:password|passwd|passphrase|secret|token|api[_ -]?key|pin)\s*\|\s*[^|\s]{6,}\s*\|`,
  String.raw`\bmachine\s+\S+\s+login\s+\S+\s+password\s+\S+`,
  String.raw`authorization:\s*basic\s+[A-Za-z0-9+/=]{12,}`,
  String.raw`[?&#](?:access_token|refresh_token|id_token|token|key|api_key|apikey|secret|client_secret|password|sig|signature|auth)=[^&\s"'<>]{8,}`,
  String.raw`[a-z][a-z0-9+.-]*://[^/\s:@]+:[^/\s@]{4,}@`,
].join("|"), "i");
const FIELD_NAMES = String.raw`wi-?fi(?:[_ -]?password)?|password|passwd|passphrase|passcode|pass|pwd|pw|pin|secret[_ -]?key|secret|token|api[_ -]?key|apikey|access[_ -]?key|private[_ -]?key|license[_ -]?key|client[_ -]?secret|auth[_ -]?key|credential|session[_ -]?key|signing[_ -]?key|key`;
const SECRET_FIELD = new RegExp(String.raw`(?<![A-Za-z])((?:[A-Za-z0-9]{1,24}[_.-]){0,4}(?:${FIELD_NAMES})s?)["']?\s*[:=]\s*["']?(?!\{\{|process\.env|os\.environ|env\.|ENV\[)([^\s"',;}()\[\]]+)`, "gi");
// The same in prose, with any separator: "Password Hunter2xyz99", "pass is
// Hunter2xyz99", "PW - Hunter2xyz99", "Gate code 4829", "PIN 4829".
const SECRET_PROSE = /\b(password|passwd|passcode|pass|pwd|pw|pin|api[ _-]?key|(?:gate|door|alarm|entry|access|lock|safe|garage)\s+code|wi-?fi(?:\s+password)?)\b\s*(?:is\s+|was\s+|[:=\-–—]\s*)?([^\s"',;|]{4,})/gi;
// A login written as "Login: sam / Hunter2xyz99".
const SECRET_LOGIN = /\b(?:login|log in|username|user)\s*:\s*\S+\s+\/\s*([^\s"',;]{6,})/gi;
// "Gmail: an address / Hunter2xyz99", "Wi-Fi: Villa Guest / Bali2026guest", or
// an address alone before " / password".
const SECRET_ACCOUNT = /^\s*(?:[-*+]\s+)?[^:\n]{1,40}:\s*[^/\n]{2,60}?\s+\/\s+([^\s"',;]{8,})\s*$|(?:^|\s)[^\s@/]+@[^\s@/]+\s+\/\s+([^\s"',;]{8,})/;
// An environment variable name is where a key lives, not the key itself.
const ENV_NAME = /^[A-Z][A-Z0-9]*_[A-Z0-9_]*$/;

// Whether a field's value looks like a secret, given the field's name.
const NOT_A_VALUE = /^(?:none|null|nil|true|false|yes|no|required|optional|hidden|redacted|unset|n\/a|tbd|todo)$/i;
function looksSecret(name, value) {
  // Where a key lives is not the key: $SUPABASE_KEY, ${API_TOKEN}, <YOUR_KEY>.
  if (/^\$\{?[A-Z_][A-Z0-9_]*\}?$/.test(value) || /^<[^>]*>?$/.test(value) || ENV_NAME.test(value) || NOT_A_VALUE.test(value)) return false;
  const field = String(name).toLowerCase().replace(/s$/, "");
  // A bare "key" is usually an id (key=user-42); only a long random-looking value counts.
  if (field === "key") return value.length >= 16 && /\d/.test(value) && /[A-Z]/.test(value) && /[a-z]/.test(value);
  // Passwords and PINs are often short or plain words.
  if (/(?:^|[_. -])pin$/.test(field) && /^\d{4,8}$/.test(value)) return true;
  if (/^wi-?fi/.test(field)) return /\d/.test(value) && value.length >= 6;
  if (/(?:^|[_. -])(?:password|passwd|passphrase|passcode|pass|pwd|pw|pin)$/.test(field)) return /\d/.test(value) ? value.length >= 6 : value.length >= 8;
  if (/\d/.test(value)) return value.length >= 8;
  return value.length >= 12 && ((/[A-Z]/.test(value) && /[a-z]/.test(value)) || /[-_!@#$%^&*+=~/.]/.test(value));
}

// A very long line with no spaces is encoded data (an embedded image, a key
// file pasted in). It is never worth keeping and never safe to scan slowly.
function isEncodedBlob(line) {
  return line.length > 2000 && !/\s\S{0,199}\s/.test(line.slice(0, 4000));
}

// Prose needs a digit, because "the wifi password is on the fridge" is not a secret.
function proseSecret(name, value) {
  const field = name.toLowerCase();
  if (!/\d/.test(value)) return false;
  if (/(?:^|\s)pin$|code$/.test(field)) return /^\d{4,8}$/.test(value) || looksSecret("password", value);
  if (/api/.test(field)) return value.length >= 16;
  return looksSecret("password", value);
}

function isSecretLine(raw) {
  if (isEncodedBlob(raw)) return true;
  if (raw.length > 20000) return SECRET_LINE.test(raw);
  // Markdown emphasis and code marks are looked through: **Password:** x.
  for (const line of new Set([raw, raw.replace(/\*\*|__|[*`]/g, "")])) {
    if (SECRET_LINE.test(line)) return true;
    for (const match of line.matchAll(SECRET_FIELD)) if (looksSecret(match[1], match[2])) return true;
    for (const match of line.matchAll(SECRET_PROSE)) if (proseSecret(match[1], match[2])) return true;
    for (const match of line.matchAll(SECRET_LOGIN)) if (/\d/.test(match[1]) && looksSecret("password", match[1])) return true;
    const account = line.match(SECRET_ACCOUNT);
    const accountValue = account && (account[1] || account[2]);
    if (accountValue && /\d/.test(accountValue) && /[A-Za-z]/.test(accountValue)) return true;
  }
  return false;
}

// Key blocks run from BEGIN to END: SSH, TLS and PGP private keys alike.
const SECRET_BLOCK_START = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|^PuTTY-User-Key-File-\d/;
const SECRET_BLOCK_END = /-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|^Private-MAC:/;
// Folder names that say they hold logins or keys. Nothing inside them is read.
const SECRET_FOLDER = /^(?:\.?ssh|\.?gnupg|keychains?|keystores?|secrets?|credentials?|passwords?|passwd|passphrases?|private[-_ ]?keys?|api[-_ ]?keys?|recovery[-_ ]?codes?|backup[-_ ]?codes?|seed[-_ ]?phrases?|mnemonics?|wallets?|2fa(?:[-_ ]?codes?)?)$/i;
const REMOVED_LINE = "[removed: looked like a key]";

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function sha256File(file) {
  const hash = crypto.createHash("sha256");
  const handle = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    for (let read = fs.readSync(handle, buffer, 0, buffer.length, null); read > 0; read = fs.readSync(handle, buffer, 0, buffer.length, null)) hash.update(buffer.subarray(0, read));
  } finally { fs.closeSync(handle); }
  return hash.digest("hex");
}

// File-name form of a title. Letters and digits of every script are kept, so
// two people with names in Chinese, Arabic or Cyrillic get two files. The same
// title always gives the same slug, which keeps note ids stable across rebuilds.
function slugify(value) {
  const text = String(value ?? "").normalize("NFKC").toLowerCase();
  const base = text.replace(/[^\p{L}\p{M}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
  if (!base) return `note-${sha256(text).slice(0, 8)}`;
  const characters = [...base];
  if (characters.length <= 80) return base;
  return `${characters.slice(0, 71).join("").replace(/-+$/, "")}-${sha256(base).slice(0, 8)}`;
}

function prettify(value) {
  const text = String(value ?? "").replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "Note";
}

function normalizeType(value) {
  const key = String(value ?? "").trim().toLowerCase();
  if (Object.hasOwn(TYPE_DIRS, key)) return key;
  return Object.hasOwn(TYPE_ALIASES, key) ? TYPE_ALIASES[key] : null;
}

function defaultRoot() {
  return path.resolve(process.env.MYOS_DISPATCH_HOME || path.join(os.homedir(), ".myos-dispatch"));
}

function brainDir(root) {
  return path.join(path.resolve(root), "brain");
}

function noteKey(type, slug) {
  return `${TYPE_DIRS[type]}/${slug}`;
}

function noteId(key) {
  return `brain:${key.replace("/", "-")}`;
}

function lstat(file) {
  try { return fs.lstatSync(file); } catch { return null; }
}

function realpath(file) {
  try { return fs.realpathSync(file); } catch { return null; }
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function writeAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const existing = lstat(file);
  const mode = existing?.isFile() ? existing.mode & 0o777 : 0o600;
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(temporary, content, { flag: "wx", mode });
  fs.renameSync(temporary, file);
}

function readState(dir) {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(dir, STATE_FILE), "utf8"));
    if (state && typeof state === "object" && state.notes && typeof state.notes === "object") return state;
  } catch { /* A missing or damaged state file starts fresh; notes on disk stay protected. */ }
  return { version: 1, notes: {} };
}

function writeState(dir, state) {
  // Only what is needed to protect edited notes lives here, and it is written
  // in a stable order, so a rebuild that changes nothing changes no file.
  const ordered = { version: 1, notes: Object.fromEntries(Object.keys(state.notes).sort().map((key) => [key, state.notes[key]])) };
  writeAtomic(path.join(dir, STATE_FILE), `${JSON.stringify(ordered, null, 2)}\n`);
}

// Run records (when the last build and graph ran) live in <root>/state, outside
// the brain folder, so the brain itself only changes when a note changes.
function writeRunRecord(root, name, value) {
  const file = path.join(root, "state", name);
  writeAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

function readRunRecord(root, name) {
  try { return JSON.parse(fs.readFileSync(path.join(root, "state", name), "utf8")); } catch { return null; }
}

function sleep(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

// ---------------------------------------------------------------------------
// Tools: git, Atelier, the viewer

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 10 * 60 * 1000, ...options });
  return { status: result.error ? 1 : result.status, stdout: result.stdout || "", stderr: result.stderr || (result.error ? result.error.message : "") };
}

function firstLine(result) {
  return `${result.stderr}\n${result.stdout}`.trim().split("\n")[0] || `exit ${result.status}`;
}

function git(dir, args) {
  return run("git", ["-C", dir, "-c", "user.name=All Sorted", "-c", "user.email=brain@localhost", "-c", "commit.gpgsign=false", ...args]);
}

function onPath(binary) {
  for (const directory of String(process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, binary);
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch { /* keep looking */ }
  }
  return null;
}

// Atelier is an optional pinned external at <root>/.external/atelier, and that
// is the only place it is looked for. A program that merely happens to be
// called atelier somewhere on PATH is never run against the brain.
function findAtelier(root) {
  const candidate = path.join(path.resolve(root), ".external", "atelier", "node_modules", ".bin", "atelier");
  try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch { return null; }
}

// The version comes from the lock the installer recorded in the install root,
// so the hint always names the release this install was tested with.
function atelierInstallHint(root) {
  let version = "0.2.0-alpha.12";
  try {
    const pinned = JSON.parse(fs.readFileSync(path.join(path.resolve(root), "allsorted-dist.lock.json"), "utf8")).modules.atelier.version;
    if (/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(pinned)) version = pinned;
  } catch { /* no lock here: use the version this module was built against */ }
  return `npm install --prefix "${path.join(path.resolve(root), ".external", "atelier")}" @mnstry/atelier@${version}`;
}

function runAtelier(binary, args, cwd) {
  // Atelier runs on the same Node that runs this file, whatever PATH says.
  const env = { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ""}` };
  return run(binary, args, { cwd, env });
}

// Where Obsidian is, or where an install would put it. BRAIN_OBSIDIAN_APP
// overrides the lookup (tests point it at a folder they control; empty means
// "treat the viewer as not installed").
function viewerCandidates() {
  if (process.env.BRAIN_OBSIDIAN_APP !== undefined) return process.env.BRAIN_OBSIDIAN_APP ? [process.env.BRAIN_OBSIDIAN_APP] : [];
  if (process.platform !== "darwin") return [];
  return ["/Applications/Obsidian.app", path.join(os.homedir(), "Applications", "Obsidian.app")];
}

function findViewer() {
  return viewerCandidates().find((candidate) => fs.existsSync(candidate)) || null;
}

function defaultPace(count) {
  if (!count) return 0;
  return Math.max(0, Math.min(MAX_PACE_MS, Math.floor(PACE_BUDGET_MS / count)));
}

// ---------------------------------------------------------------------------
// Text helpers: front matter, secrets, links

function yamlString(value) {
  return JSON.stringify(String(value ?? "").replace(/\s+/g, " ").trim());
}

function splitFrontMatter(raw) {
  const text = String(raw).replace(/\r\n?/g, "\n");
  if (!text.startsWith("---\n")) return { yaml: "", body: text };
  const end = text.indexOf("\n---", 3);
  if (end < 0) return { yaml: "", body: text };
  const after = text.indexOf("\n", end + 4);
  return { yaml: text.slice(4, end), body: after < 0 ? "" : text.slice(after + 1) };
}

// Small front matter reader: top-level `key: value`, inline lists and block
// lists. Enough to pick up titles, tags and named people or companies.
function parseFrontMatter(yaml) {
  const out = {};
  let listKey = null;
  for (const raw of String(yaml).split("\n")) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const item = raw.match(/^\s+-\s+(.*)$/);
    if (item && listKey) { out[listKey].push(unquote(item[1])); continue; }
    const pair = raw.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!pair) { if (!/^\s/.test(raw)) listKey = null; continue; }
    const key = pair[1].toLowerCase();
    const value = pair[2].trim();
    if (!value) { out[key] = []; listKey = key; continue; }
    listKey = null;
    if (value.startsWith("[") && value.endsWith("]")) out[key] = value.slice(1, -1).split(",").map(unquote).filter(Boolean);
    else out[key] = unquote(value);
  }
  return out;
}

function unquote(value) {
  const text = String(value ?? "").trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) return text.slice(1, -1).trim();
  return text;
}

function asList(value) {
  if (Array.isArray(value)) return value.map((entry) => String(entry).trim()).filter(Boolean);
  if (typeof value === "string" && value.trim()) return value.split(/,|;| and /).map((entry) => entry.trim()).filter(Boolean);
  return [];
}

// Lines that look like keys are dropped (for summaries) or replaced with a
// marker (for copied content). A private key block goes from BEGIN to END.
function scrubSecrets(text, replacement) {
  const out = [];
  let inBlock = false;
  for (const line of String(text ?? "").split("\n")) {
    if (inBlock) {
      if (SECRET_BLOCK_END.test(line)) inBlock = false;
      continue;
    }
    if (SECRET_BLOCK_START.test(line)) {
      if (!SECRET_BLOCK_END.test(line)) inBlock = true;
      if (replacement !== null) out.push(replacement);
      continue;
    }
    if (isSecretLine(line)) { if (replacement !== null) out.push(replacement); continue; }
    out.push(line);
  }
  return out.join("\n");
}

function redact(text) {
  return scrubSecrets(text, null);
}

// Runs `change` over the parts of markdown that are prose, leaving fenced code
// blocks and inline code spans exactly as they are. Shell code such as
// `[[ -f file ]]` is code, not a link.
function mapOutsideCode(text, change) {
  let fence = null;
  return String(text).split("\n").map((line) => {
    const marker = line.match(/^\s*(```+|~~~+)/);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      return line;
    }
    if (marker) { fence = marker[1]; return line; }
    return line.split(/(`+[^`\n]*`+)/).map((part, index) => index % 2 === 1 ? part : change(part)).join("");
  }).join("\n");
}

const WIKILINK = /(!?)\[\[([^\[\]\n]*)\]\]/g;

function linkLabel(text) {
  return String(text ?? "").replace(/[\[\]|\n]/g, " ").replace(/\s+/g, " ").trim();
}

// Rewrites every wikilink and embed. `resolve` turns a link target into the key
// of a brain note, or null. A link to a note that exists stays a link; anything
// else becomes plain text, so the brain never holds a link that goes nowhere.
function rewriteLinks(text, resolve) {
  return mapOutsideCode(text, (prose) => prose.replace(WIKILINK, (whole, embed, inner) => {
    const [targetPart, ...aliasParts] = inner.split("|");
    const target = targetPart.split("#")[0].split("^")[0].trim();
    const alias = linkLabel(aliasParts.join("|"));
    const key = target ? resolve(target) : null;
    const label = alias || linkLabel(target.replace(/\.md$/i, "")) || linkLabel(targetPart);
    if (!key) return label;
    return `[[${key}|${label || prettify(key.split("/")[1])}]]`;
  }));
}

function plainLinks(text) {
  return rewriteLinks(text, () => null);
}

function wikilinkTargets(text) {
  const targets = [];
  mapOutsideCode(text, (prose) => {
    for (const match of prose.matchAll(WIKILINK)) targets.push(match[2].split("|")[0].split("#")[0].split("^")[0].trim());
    return prose;
  });
  return targets;
}

// Plain markdown links to other notes, [Zed](people/zed-quill.md), resolved
// against the folder of the note they sit in, as brain-relative paths.
const MARKDOWN_LINK = /\]\(<?([^)\s>]+?\.md)(?:#[^)\s>]*)?>?(?:\s+"[^"]*")?\)/gi;
function markdownLinkTargets(text, fromRelative) {
  const targets = [];
  mapOutsideCode(text, (prose) => {
    for (const match of prose.matchAll(MARKDOWN_LINK)) {
      let target = match[1];
      try { target = decodeURIComponent(target); } catch { /* keep as written */ }
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(fromRelative), target));
      if (!resolved.startsWith("../")) targets.push(resolved);
    }
    return prose;
  });
  return targets;
}

// The text of a document, made safe to keep inside a note: no front matter, no
// lines that look like keys, no links that go nowhere, and no more than the cap.
function copyContent(raw, resolve, maxBytes, where) {
  let body = splitFrontMatter(raw).body.replace(/\u0000/g, "");
  body = scrubSecrets(body, REMOVED_LINE);
  body = rewriteLinks(body, resolve).trim();
  if (Buffer.byteLength(body) <= maxBytes) return body;
  let kept = Buffer.from(body).subarray(0, maxBytes).toString("utf8").replace(/\uFFFD+$/, "");
  const lineEnd = kept.lastIndexOf("\n");
  if (lineEnd > maxBytes / 2) kept = kept.slice(0, lineEnd);
  // Close a code block the cut left open, with the same fence that opened it.
  let fence = null;
  for (const line of kept.split("\n")) {
    const marker = line.match(/^\s*(```+|~~~+)/);
    if (!marker) continue;
    if (!fence) fence = marker[1];
    else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
  }
  const size = maxBytes >= 1024 ? `${Math.round(maxBytes / 1024)} KB` : `${maxBytes} bytes`;
  return `${kept.trimEnd()}\n${fence ? `${fence}\n` : ""}\n[Cut here: this note holds the first ${size} of the document. The full original is at ${where}.]`;
}

// ---------------------------------------------------------------------------
// Rendering

const CONTENT_HEADING = "## Content";

function renderNote(note, titles) {
  const grouped = new Map();
  for (const relation of note.relations) {
    if (!grouped.has(relation.type)) grouped.set(relation.type, []);
    if (!grouped.get(relation.type).includes(relation.target)) grouped.get(relation.type).push(relation.target);
  }
  const front = [
    "---",
    `title: ${yamlString(note.title)}`,
    `summary: ${yamlString(note.summary)}`,
  ];
  if (note.tags.length) front.push("tags:", ...note.tags.map((tag) => `  - ${yamlString(tag)}`));
  else front.push("tags: []");
  front.push(
    "kg:",
    `  id: ${yamlString(noteId(note.key))}`,
    `  type: ${yamlString(KG_TYPES[note.type])}`,
    '  status: "active"',
    '  audience: "private"',
    "  relations:",
  );
  if (!grouped.size) front.push("    related: []");
  for (const type of [...grouped.keys()].sort()) {
    front.push(`    ${type}:`, ...grouped.get(type).sort().map((target) => `      - ${yamlString(noteId(target))}`));
  }
  front.push("---", "");
  const lines = [`# ${note.title}`, ""];
  if (note.summary) lines.push(note.summary, "");
  if (note.body) lines.push(note.body.trim(), "");
  if (note.relations.length) {
    lines.push("## Related", "");
    const seen = new Set();
    for (const relation of [...note.relations].sort((a, b) => a.target.localeCompare(b.target) || a.type.localeCompare(b.type))) {
      const line = `- [[${relation.target}|${linkLabel(titles.get(relation.target)) || prettify(relation.target.split("/")[1])}]] (${relation.type.replace(/_/g, " ")})`;
      if (!seen.has(line)) { seen.add(line); lines.push(line); }
    }
    lines.push("");
  }
  if (note.sources.length) {
    lines.push("## Where this came from", "", ...[...new Set(note.sources)].sort().map((source) => `- \`${source}\``), "");
  }
  if (note.content) lines.push(CONTENT_HEADING, "", note.content, "");
  return `${front.join("\n")}${lines.join("\n")}`;
}

// The copied document text of a note already on disk, so `add` can carry it
// forward when it updates a note the file pass wrote.
function existingContent(text) {
  const from = Math.max(text.indexOf("\n## Where this came from\n"), 0);
  const at = text.indexOf(`\n${CONTENT_HEADING}\n\n`, from);
  return at < 0 ? "" : text.slice(at + CONTENT_HEADING.length + 3).replace(/\n+$/, "");
}

// ---------------------------------------------------------------------------
// Writing with edit protection

function sameRelation(a, b) {
  return Boolean(a && b) && a.type === b.type && a.target === b.target;
}

// The relations `add` owns on a note: the ones the assistant gave it. The rest
// (links the file pass found) belong to the build. A receipt from before
// addedRelations was recorded cannot tell them apart: for a note `add` wrote,
// every relation is treated as add-owned, and the next build restores any
// file-pass link from the documents.
function addOwnedRelations(tracked) {
  if (!tracked) return [];
  if (Array.isArray(tracked.addedRelations)) return tracked.addedRelations;
  return tracked.origin === "add" ? (tracked.relations || []) : [];
}

// Returns one of: written, updated, unchanged, protected, kept.
function writeNote(dir, state, note, titles, origin) {
  const relative = `${note.key}.md`;
  const file = path.join(dir, relative);
  const content = renderNote(note, titles);
  const hash = sha256(content);
  const tracked = state.notes[relative];
  const info = lstat(file);
  // hash: the content this tool last wrote. generated: the content it last
  // produced, written or not. They differ only for a note a person edited.
  // The copied document text is not repeated here; it lives in the note.
  const record = { hash, generated: hash, id: noteId(note.key), type: note.type, title: note.title, origin, relations: note.relations, sources: note.sources, tags: note.tags, summary: note.summary, ...(Array.isArray(note.roots) && note.roots.length ? { roots: [...note.roots].sort() } : {}), ...(origin === "add" ? { body: note.body, addedRelations: (note.addedRelations || []).filter((owned) => note.relations.some((relation) => sameRelation(relation, owned))) } : {}), ...(origin === "pull" && note.pull ? { pull: note.pull } : {}) };
  if (!info) {
    if (origin === "pull") { state.notes[relative] = record; writeState(dir, state); }
    writeAtomic(file, content);
    state.notes[relative] = record;
    return "written";
  }
  const current = info.isFile() ? fs.readFileSync(file, "utf8") : null;
  if (current === content) {
    // Exactly what this tool would write: it is ours, with or without a state
    // entry. This is what lets a build that was killed half way carry on.
    state.notes[relative] = { ...record, origin: tracked?.origin === "add" ? "add" : origin, ...(tracked?.origin === "add" ? { body: tracked.body } : {}), ...(origin !== "add" && Array.isArray(tracked?.addedRelations) ? { addedRelations: tracked.addedRelations } : {}) };
    return "unchanged";
  }
  const untouched = current !== null && tracked && sha256(current) === tracked.hash;
  if (!untouched) {
    // Someone edited this note, or it was here before the brain was built.
    // It is left exactly as it is. A proposed version is written beside it
    // only when there is something new to propose.
    if (tracked?.generated !== hash) {
      const proposed = path.join(dir, `${note.key}.proposed.md`);
      const existing = lstat(proposed)?.isFile() ? fs.readFileSync(proposed, "utf8") : null;
      if (existing !== content) writeAtomic(proposed, content);
      state.notes[relative] = { ...(tracked || { hash: null, id: noteId(note.key), type: note.type, title: note.title, origin }), generated: hash };
    }
    return "protected";
  }
  // A plain rebuild never replaces what the assistant added through `add`: it
  // keeps the assistant's summary, words and links, and refreshes only what the
  // file pass owns (the copied document text, sources, tags and file links).
  if (origin === "build" && tracked.origin === "add") {
    const keep = (relation) => titles.has(relation.target) && RELATION_TYPES.has(relation.type);
    const relations = [];
    const seen = new Set();
    for (const relation of [...(tracked.relations || []).filter(keep), ...note.relations]) {
      const id = `${relation.type} ${relation.target}`;
      if (!seen.has(id)) { seen.add(id); relations.push(relation); }
    }
    const merged = { ...note, title: tracked.title || note.title, summary: typeof tracked.summary === "string" ? tracked.summary : note.summary, body: tracked.body || "", relations, tags: [...new Set([...(tracked.tags || []), ...note.tags])], sources: [...new Set([...(tracked.sources || []), ...note.sources])] };
    const mergedContent = renderNote(merged, titles);
    if (mergedContent === current) return "kept";
    writeAtomic(file, mergedContent);
    const mergedHash = sha256(mergedContent);
    state.notes[relative] = { ...tracked, hash: mergedHash, generated: mergedHash, relations: merged.relations, sources: merged.sources, tags: merged.tags };
    return "updated";
  }
  writeAtomic(file, content);
  state.notes[relative] = record;
  return "updated";
}

function existingNoteKeys(dir) {
  const keys = new Map();
  for (const type of TYPE_ORDER) {
    const folder = path.join(dir, TYPE_DIRS[type]);
    if (!lstat(folder)?.isDirectory()) continue;
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name.endsWith(".proposed.md")) continue;
      const key = `${TYPE_DIRS[type]}/${entry.name.slice(0, -3).normalize("NFC")}`;
      let title = prettify(entry.name);
      try {
        const handle = fs.openSync(path.join(folder, entry.name), "r");
        const buffer = Buffer.alloc(4096);
        const read = fs.readSync(handle, buffer, 0, buffer.length, 0);
        fs.closeSync(handle);
        const found = parseFrontMatter(splitFrontMatter(buffer.subarray(0, read).toString("utf8")).yaml).title;
        if (typeof found === "string" && found) title = found;
      } catch { /* keep the file name */ }
      keys.set(key, String(title));
    }
  }
  return keys;
}

// ---------------------------------------------------------------------------
// init

const README = `---
title: "Your second brain"
summary: "How this folder works and how to move it."
tags: []
kg:
  id: "brain:readme"
  type: "index"
  status: "active"
  audience: "private"
  relations:
    related: []
---
# Your second brain

This folder is your second brain. It is plain markdown files and nothing else.

- \`projects/\`, \`people/\`, \`companies/\`, \`topics/\` and \`sources/\` each hold one note per thing.
- A source note holds the text of the document it came from, so the knowledge is here, not somewhere else.
- Every note links to its related notes, so any markdown app can follow them.
- It is a git repository with no remote, so every change has history and nothing in it is sent anywhere.

## Moving it

Copy or move this one folder and the whole brain goes with it. No database, no account, no app is needed to read it.

## Editing it

Edit any note. A note you changed is never overwritten: when a rebuild has something new for it, the new version is saved beside it as \`name.proposed.md\` for you to compare.

## Looking at it

Open this folder as a vault in Obsidian and use the graph view to see how everything connects. Obsidian is only a viewer. Nothing here depends on it.
`;

const GITIGNORE_LINES = ["*.proposed.md", ".brain.lock", ".DS_Store", ".trash/", ".obsidian/workspace.json", ".obsidian/workspace-mobile.json", ".obsidian/cache"];

function ensureGitignore(dir) {
  const file = path.join(dir, ".gitignore");
  const current = lstat(file)?.isFile() ? fs.readFileSync(file, "utf8") : "";
  const have = new Set(current.split("\n").map((line) => line.trim()));
  const missing = GITIGNORE_LINES.filter((line) => !have.has(line));
  if (!missing.length) return false;
  writeAtomic(file, `${current}${current && !current.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`);
  return true;
}

// Minimal Obsidian settings for the brain folder: core plugins only,
// community plugins off, and a first window that is the graph view. Each file
// is written only when it does not exist. After the first launch the app owns
// workspace.json and graph.json, so they are never replaced.
const GRAPH_COLOURS = [["projects", 0x4f8ff7], ["people", 0xf2994a], ["companies", 0x27ae60], ["topics", 0xbb6bd9], ["sources", 0x8a94a6]];

function viewerFiles() {
  const leaf = (id, type, state = {}) => ({ id, type: "leaf", state: { type, state } });
  return {
    "app.json": { alwaysUpdateLinks: true, userIgnoreFilters: ["atelier-output/", ".atelier-local/"] },
    "core-plugins.json": { "file-explorer": true, "global-search": true, graph: true, backlink: true },
    "community-plugins.json": [],
    "graph.json": {
      "collapse-filter": true,
      search: "",
      showTags: false,
      showAttachments: false,
      hideUnresolved: false,
      showOrphans: true,
      "collapse-color-groups": true,
      colorGroups: GRAPH_COLOURS.map(([folder, rgb]) => ({ query: `path:${folder}`, color: { a: 1, rgb } })),
      "collapse-display": true,
      showArrow: true,
      textFadeMultiplier: 0,
      nodeSizeMultiplier: 1.2,
      lineSizeMultiplier: 1,
      "collapse-forces": true,
      centerStrength: 0.5,
      repelStrength: 10,
      linkStrength: 1,
      linkDistance: 250,
      scale: 1,
      close: true,
    },
    "workspace.json": {
      main: { id: "b1a0000000000001", type: "split", direction: "vertical", children: [{ id: "b1a0000000000002", type: "tabs", children: [leaf("b1a0000000000003", "graph")] }] },
      left: { id: "b1a0000000000004", type: "split", direction: "horizontal", width: 260, children: [{ id: "b1a0000000000005", type: "tabs", children: [leaf("b1a0000000000006", "file-explorer", { sortOrder: "alphabetical" }), leaf("b1a0000000000007", "search")] }] },
      right: { id: "b1a0000000000008", type: "split", direction: "horizontal", width: 300, collapsed: true, children: [{ id: "b1a0000000000009", type: "tabs", children: [leaf("b1a000000000000a", "backlink")] }] },
      active: "b1a0000000000003",
      lastOpenFiles: [],
    },
  };
}

function writeViewerConfig(dir) {
  const folder = path.join(dir, ".obsidian");
  const written = [];
  for (const [name, value] of Object.entries(viewerFiles())) {
    const file = path.join(folder, name);
    if (lstat(file)) continue; // Never replace settings that already exist.
    writeAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
    written.push(name);
  }
  return written;
}

// Obsidian opens a folder as a vault only when the folder is in its own vault
// list. The brain is added there and marked to open. Every other vault and
// every other setting in that file is left exactly as it is, the file is
// backed up beside itself first, and it is never rewritten while the app runs
// (the app would write its own copy back over it on exit).
function viewerVaultList() {
  if (process.env.BRAIN_OBSIDIAN_CONFIG !== undefined) return process.env.BRAIN_OBSIDIAN_CONFIG || null;
  return process.platform === "darwin" ? path.join(os.homedir(), "Library", "Application Support", "obsidian", "obsidian.json") : null;
}

function viewerRunning(options = {}) {
  const command = options.tools?.pgrep || process.env.BRAIN_PGREP_CMD || "pgrep";
  return run(command, ["-x", "Obsidian"]).status === 0;
}

function backupVaultList(file) {
  const stamp = new Date().toISOString().replace(/[-:.]/g, "");
  const prefix = `${path.basename(file)}.brain-backup-`;
  fs.copyFileSync(file, path.join(path.dirname(file), `${prefix}${stamp}`));
  const backups = fs.readdirSync(path.dirname(file)).filter((name) => name.startsWith(prefix)).sort();
  for (const old of backups.slice(0, Math.max(0, backups.length - 3))) fs.rmSync(path.join(path.dirname(file), old), { force: true });
}

function registerVault(dir, options = {}) {
  const file = viewerVaultList();
  if (!file) return "skipped";
  let config = { vaults: {} };
  const exists = Boolean(lstat(file));
  if (exists) {
    try { config = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return "left alone: the vault list could not be read"; }
    if (!config || typeof config !== "object" || Array.isArray(config)) return "left alone: the vault list has an unknown shape";
    if (config.vaults !== undefined && (!config.vaults || typeof config.vaults !== "object" || Array.isArray(config.vaults))) return "left alone: the vault list has an unknown shape";
    config.vaults ||= {};
  }
  const mine = Object.values(config.vaults).find((vault) => vault && typeof vault === "object" && vault.path === dir);
  if (mine && mine.open === true) return "already listed";
  if (viewerRunning(options)) return "skipped: app running";
  if (mine) mine.open = true;
  else config.vaults[sha256(dir).slice(0, 16)] = { path: dir, ts: Date.now(), open: true };
  try {
    if (exists) backupVaultList(file);
    writeAtomic(file, JSON.stringify(config));
  } catch (error) {
    return `left alone: the vault list could not be written (${error.code || error.message})`;
  }
  return mine ? "already listed" : "added";
}

// ---------------------------------------------------------------------------
// The viewer: proving an app is Obsidian, and installing it

// Reads who signed an app. Identifier and team must be Obsidian's own.
function appIdentity(app, tools = {}) {
  const described = run(tools.codesign || "codesign", ["-dv", app]);
  const text = `${described.stdout}\n${described.stderr}`;
  const identifier = text.match(/^Identifier=(.+)$/m)?.[1]?.trim() || null;
  const team = text.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim() || null;
  return { identifier, team, matches: described.status === 0 && identifier === OBSIDIAN_IDENTIFIER && team === OBSIDIAN_TEAM };
}

// Every check must pass before a downloaded app is copied anywhere: the
// signature is intact, it is Obsidian's own identifier and team, and Apple
// notarized it. Returns the reason for the first check that fails.
function verifyViewerApp(app, tools = {}) {
  const sealed = run(tools.codesign || "codesign", ["--verify", "--deep", "--strict", app]);
  if (sealed.status !== 0) return { ok: false, reason: "its code signature is missing or broken" };
  const identity = appIdentity(app, tools);
  if (identity.identifier !== OBSIDIAN_IDENTIFIER) return { ok: false, reason: `it is signed as "${identity.identifier || "nothing"}", not as ${OBSIDIAN_IDENTIFIER}` };
  if (identity.team !== OBSIDIAN_TEAM) return { ok: false, reason: `it is signed by team "${identity.team || "none"}", not by Obsidian's publisher (${OBSIDIAN_TEAM})` };
  const assessed = run(tools.spctl || "spctl", ["-a", "-vv", app]);
  const verdict = `${assessed.stdout}\n${assessed.stderr}`;
  if (assessed.status !== 0 || !/: accepted\b/.test(verdict)) return { ok: false, reason: "macOS Gatekeeper did not accept it" };
  if (!/^source=.*Notarized Developer ID/m.test(verdict)) return { ok: false, reason: "it is not notarized by Apple" };
  return { ok: true, identity };
}

function viewerDestinations() {
  if (process.env.BRAIN_OBSIDIAN_APP) return [process.env.BRAIN_OBSIDIAN_APP];
  return ["/Applications/Obsidian.app", path.join(os.homedir(), "Applications", "Obsidian.app")];
}

// https only, TLS 1.2 or newer, and redirects only to https. The address the
// download finally came from is printed so it can be checked.
function download(tools, url, extra = []) {
  return run(tools.curl, ["--proto", "=https", "--proto-redir", "=https", "--tlsv1.2", "--fail", "--location", "--silent", "--show-error", ...extra, url]);
}

function installViewerFromDiskImage(options = {}) {
  const tools = { curl: "curl", hdiutil: "hdiutil", ditto: "ditto", codesign: "codesign", spctl: "spctl", xattr: "xattr", ...(options.tools || {}) };
  const warnings = [];
  const fail = (detail) => ({ ok: false, method: "disk image", detail, warnings });
  const listing = download(tools, OBSIDIAN_RELEASES, ["--max-time", "30"]);
  if (listing.status !== 0) return fail(`the release list could not be read: ${firstLine(listing)}`);
  let releases;
  try { releases = JSON.parse(listing.stdout); } catch { return fail("the release list was not readable"); }
  let asset = null;
  for (const release of Array.isArray(releases) ? releases : []) {
    if (!release || release.draft || release.prerelease) continue;
    asset = (release.assets || []).find((entry) => /^Obsidian-\d+\.\d+\.\d+\.dmg$/.test(entry?.name || "") && String(entry.browser_download_url || "").startsWith(OBSIDIAN_DOWNLOAD_PREFIX));
    if (asset) break;
  }
  if (!asset) return fail("no desktop disk image was found in the official releases");
  let work;
  try { work = fs.mkdtempSync(path.join(os.tmpdir(), "brain-viewer-")); } catch (error) { return fail(`no temporary folder could be made: ${error.message}`); }
  const image = path.join(work, asset.name);
  const mount = path.join(work, "mount");
  let attached = false;
  try {
    const downloaded = download(tools, asset.browser_download_url, ["--max-time", "900", "--output", image, "--write-out", "%{url_effective}"]);
    if (downloaded.status !== 0 || !lstat(image)) return fail(`the download failed: ${firstLine(downloaded)}`);
    let finalHost = "";
    try { const final = new URL(downloaded.stdout.trim()); finalHost = final.protocol === "https:" ? final.hostname : ""; } catch { /* refused below */ }
    if (!OBSIDIAN_DOWNLOAD_HOSTS.has(finalHost)) return fail(`the download was redirected to "${finalHost || "an unknown address"}", which is not GitHub, so it was thrown away`);
    const expected = /^sha256:([0-9a-f]{64})$/.exec(String(asset.digest || ""))?.[1];
    if (expected && sha256File(image) !== expected) return fail("the download did not match the checksum published with the release, so it was thrown away");
    const checksum = expected ? "published checksum matched" : "no published checksum";
    fs.mkdirSync(mount);
    const mounted = run(tools.hdiutil, ["attach", "-nobrowse", "-readonly", "-noautoopen", "-mountpoint", mount, image]);
    if (mounted.status !== 0) return fail(`the disk image did not mount: ${firstLine(mounted)}`);
    attached = true;
    const app = path.join(mount, "Obsidian.app");
    if (!lstat(app)?.isDirectory()) return fail("the disk image does not contain Obsidian.app");
    const verified = verifyViewerApp(app, tools);
    if (!verified.ok) return fail(`the app in the disk image was not copied: ${verified.reason}`);
    for (const destination of options.destinations || viewerDestinations()) {
      if (lstat(destination)) return { ok: true, method: "disk image", detail: `already present at ${destination}`, app: destination, warnings };
      try { fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.accessSync(path.dirname(destination), fs.constants.W_OK); } catch { continue; }
      const copied = run(tools.ditto, [app, destination]);
      if (copied.status !== 0 || !lstat(destination)) continue;
      // Gatekeeper assesses a downloaded app on first launch only when it is
      // marked as downloaded. curl leaves no mark, so one is set here; a mark
      // that is already there is kept as it is.
      if (run(tools.xattr, ["-p", "com.apple.quarantine", destination]).status !== 0) {
        const marked = run(tools.xattr, ["-w", "com.apple.quarantine", `0081;${Math.floor(Date.now() / 1000).toString(16)};All Sorted;`, destination]);
        if (marked.status !== 0) warnings.push("the downloaded mark could not be set on the app, so macOS may not ask before its first launch");
      }
      return { ok: true, method: "disk image", detail: `Obsidian ${asset.name.replace(/^Obsidian-|\.dmg$/g, "")} copied to ${destination}: ${checksum}, signed by Obsidian's publisher (${OBSIDIAN_TEAM}), notarized by Apple`, app: destination, checksum, warnings };
    }
    return fail("no Applications folder could be written to");
  } catch (error) {
    return fail(`the install stopped: ${error.message}`);
  } finally {
    let detached = true;
    if (attached) {
      detached = run(tools.hdiutil, ["detach", mount, "-quiet"]).status === 0 || run(tools.hdiutil, ["detach", mount, "-force", "-quiet"]).status === 0;
      if (!detached) warnings.push(`the disk image could not be ejected. It is still mounted at ${mount}; eject it in Finder or restart.`);
    }
    // A folder with a disk image still mounted inside it is left alone.
    if (detached) { try { fs.rmSync(work, { recursive: true, force: true }); } catch { warnings.push(`temporary files were left at ${work}`); } }
  }
}

function installViewer(options = {}) {
  // BRAIN_INSTALL_CMD replaces the real installers. Tests use it so nothing is
  // ever downloaded or installed while they run.
  const override = options.installCommand ?? process.env.BRAIN_INSTALL_CMD;
  if (override) {
    const result = run(override, []);
    return { ok: result.status === 0 && Boolean(findViewer()), method: "custom command", detail: result.status === 0 ? "the install command finished" : `the install command failed: ${firstLine(result)}` };
  }
  if (process.platform !== "darwin") return { ok: false, method: "none", detail: "automatic install is for macOS only. Download Obsidian from https://obsidian.md/download" };
  const brew = onPath("brew");
  if (brew) {
    const result = run(brew, ["install", "--cask", "obsidian"]);
    if (result.status === 0 && findViewer()) return { ok: true, method: "homebrew", detail: "installed with brew install --cask obsidian" };
    const viaImage = installViewerFromDiskImage(options);
    return viaImage.ok ? viaImage : { ...viaImage, method: "homebrew", detail: `brew could not install it (${`${result.stderr}\n${result.stdout}`.trim().split("\n").slice(-1)[0] || `exit ${result.status}`}), and ${viaImage.detail}` };
  }
  return installViewerFromDiskImage(options);
}

function init(options = {}) {
  const root = path.resolve(options.root || defaultRoot());
  const dir = brainDir(root);
  const result = { ok: true, command: "init", root, brain: dir, created: [], git: "present", atelier: "missing", viewerConfig: [], warnings: [] };
  const info = lstat(dir);
  if (info && (info.isSymbolicLink() || !info.isDirectory())) throw new Error(`${dir} exists and is not a plain folder. Move it aside, then run init again.`);
  if (!info) { fs.mkdirSync(dir, { recursive: true }); result.created.push("brain/"); }
  for (const type of TYPE_ORDER) {
    const folder = path.join(dir, TYPE_DIRS[type]);
    if (!lstat(folder)) { fs.mkdirSync(folder, { recursive: true }); result.created.push(`${TYPE_DIRS[type]}/`); }
  }
  if (!lstat(path.join(dir, "README.md"))) { writeAtomic(path.join(dir, "README.md"), README); result.created.push("README.md"); }
  if (ensureGitignore(dir)) result.created.push(".gitignore");
  if (!lstat(path.join(dir, STATE_FILE))) { writeState(dir, readState(dir)); result.created.push(STATE_FILE); }
  if (!lstat(path.join(dir, ".git"))) {
    const made = run("git", ["init", "--quiet", dir]);
    if (made.status === 0) result.git = "created";
    else { result.git = "unavailable"; result.warnings.push(`git init did not run (${firstLine(made)}). The brain still works as plain files; history starts once git is installed.`); }
  }
  const atelier = findAtelier(root);
  if (!atelier) {
    result.warnings.push(`Atelier is not installed, so only the Atelier graph file is skipped. To add it: ${atelierInstallHint(root)}`);
  } else if (lstat(path.join(dir, "atelier.project.json"))) {
    result.atelier = "adopted";
  } else if (result.git === "unavailable") {
    result.atelier = "skipped";
    result.warnings.push("Atelier setup needs git, so it was skipped.");
  } else {
    const adopted = runAtelier(atelier, ["adopt", "--profile", "single-repo", "--yes"], dir);
    if (adopted.status === 0) { result.atelier = "adopted"; ensureGitignore(dir); }
    else { result.atelier = "failed"; result.warnings.push(`Atelier setup failed and was skipped: ${(adopted.stderr || adopted.stdout).trim().split("\n").slice(-2).join(" ")}`); }
  }
  if (options.viewer) result.viewerConfig = writeViewerConfig(dir);
  return result;
}

// ---------------------------------------------------------------------------
// build: read documents, write notes

function readDocument(file) {
  const info = lstat(file);
  if (!info || !info.isFile() || info.size > MAX_FILE_BYTES) return null;
  const buffer = fs.readFileSync(file);
  if (buffer.subarray(0, 8192).includes(0)) return null;
  return buffer.toString("utf8");
}

// Lists the readable documents under one folder the customer named. Only names
// and sizes are gathered here; no file is opened. Symbolic links are never
// followed and every file must resolve inside the folder that was given.
function listDocuments(realRoot, exclude, skipped) {
  const files = [];
  const blockedFolders = new Set(exclude.map((entry) => path.resolve(entry)));
  const excluded = (file) => {
    let folder = path.resolve(file);
    while (true) {
      if (blockedFolders.has(folder)) return true;
      const parent = path.dirname(folder);
      if (parent === folder) return false;
      folder = parent;
    }
  };
  const visit = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { skipped.unreadable += 1; return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (excluded(full)) { skipped.folders += 1; continue; }
      const info = lstat(full);
      if (!info) continue;
      if (info.isSymbolicLink()) { skipped.symlinks += 1; continue; }
      if (info.isDirectory()) {
        if (entry.name.startsWith(".") || SKIP_DIRECTORIES.has(entry.name)) { skipped.folders += 1; continue; }
        if (SECRET_FOLDER.test(entry.name)) { skipped.secrets += 1; continue; }
        visit(full);
        continue;
      }
      if (!info.isFile()) continue;
      if (SECRET_FILE.test(entry.name)) { skipped.secrets += 1; continue; }
      if (entry.name.startsWith(".") || !READABLE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) { skipped.otherFiles += 1; continue; }
      const real = realpath(full);
      if (!real) { skipped.unreadable += 1; continue; }
      const inside = path.relative(realRoot, real);
      if (!inside || inside.startsWith("..") || path.isAbsolute(inside)) { skipped.symlinks += 1; continue; }
      files.push({ file: full, relative: inside.split(path.sep).join("/") });
    }
  };
  if (!excluded(realRoot)) visit(realRoot);
  return files;
}

// Shares the file limit across the named folders, so the first folder cannot
// use all of it. A folder that needs less than its share passes the rest on.
function shareLimit(counts, max) {
  const quota = counts.map(() => 0);
  let left = max;
  let open = counts.map((_, index) => index).filter((index) => counts[index] > 0);
  while (left > 0 && open.length) {
    const share = Math.max(1, Math.floor(left / open.length));
    for (const index of open) {
      const take = Math.min(share, counts[index] - quota[index], left);
      quota[index] += take;
      left -= take;
      if (left <= 0) break;
    }
    open = open.filter((index) => quota[index] < counts[index]);
  }
  return quota;
}

function nameWords(text) {
  return String(text).trim().split(/\s+/).filter(Boolean);
}

function looksLikeName(value, kind = "company") {
  const text = plainLinks(String(value ?? "")).trim();
  if (!text || text.length > 60 || /[@/\\:<>{}()=\d]/.test(text)) return null;
  const words = nameWords(text);
  if (words.length < 1 || words.length > 5) return null;
  // A capital letter to start, or a script that has no capitals.
  if (!words.every((word) => /^(?:\p{Lu}|\p{Lo})[\p{L}\p{M}'.&-]*$/u.test(word) || /^(?:and|of|the|de|van|von|der|da|di|la|le)$/.test(word))) return null;
  if (kind === "person" && words.every((word) => NOT_PEOPLE.has(word.toLowerCase().replace(/[.'&-]/g, "")))) return null;
  return text;
}

// Reads what a document says about itself. Nothing from the text is kept
// except the few short fields returned here.
function describeDocument(text, relative) {
  const { yaml, body } = splitFrontMatter(text);
  const meta = parseFrontMatter(yaml);
  const safeBody = redact(body);
  const heading = safeBody.match(/^#\s+(.+?)\s*#*\s*$/m)?.[1]?.trim();
  const title = plainLinks((typeof meta.title === "string" && meta.title) || heading || prettify(path.basename(relative)));
  const paragraph = safeBody.split(/\n\s*\n/).map((block) => block.trim())
    .find((block) => block && !block.startsWith("#") && !block.startsWith("```") && !block.startsWith("<!--") && !block.startsWith("|") && !/^[A-Za-z ]{2,20}:\s/.test(block));
  const summary = plainLinks((typeof meta.summary === "string" && meta.summary) || (typeof meta.description === "string" && meta.description) || (paragraph ? paragraph.replace(/\s+/g, " ").slice(0, 280) : ""));
  const people = new Set();
  const companies = new Set();
  const collect = (key, value) => {
    if (PERSON_KEYS.has(key)) for (const name of asList(value)) { const clean = looksLikeName(name, "person"); if (clean) people.add(clean); }
    if (COMPANY_KEYS.has(key)) for (const name of asList(value)) { const clean = looksLikeName(name, "company"); if (clean) companies.add(clean); }
  };
  for (const [key, value] of Object.entries(meta)) collect(key, value);
  // Header lines such as "Owner: Dana Lee" near the top of a document.
  for (const line of safeBody.split("\n").slice(0, 40)) {
    const pair = line.match(/^(?:[-*]\s*)?\**([A-Za-z]{3,14})\**:\**\s+(.+?)\s*$/);
    if (pair) collect(pair[1].toLowerCase(), pair[2]);
  }
  const tags = asList(meta.tags).map((tag) => tag.replace(/^#/, "")).filter((tag) => /^[\p{L}\p{N}][\p{L}\p{N} _/-]{0,40}$/u.test(tag)).slice(0, 12);
  const links = wikilinkTargets(body).filter(Boolean).map((target) => ({ kind: "wiki", target }));
  for (const match of body.matchAll(/\[[^\]]*\]\(([^)\s]+?)(?:#[^)]*)?\)/g)) {
    if (!/^[a-z][a-z0-9+.-]*:/i.test(match[1])) links.push({ kind: "path", target: decodeURIComponentSafe(match[1]) });
  }
  return { title: String(title).replace(/\s+/g, " ").trim().slice(0, 120) || prettify(path.basename(relative)), summary: redact(summary).replace(/\s+/g, " ").trim(), people: [...people], companies: [...companies], tags, links };
}

function decodeURIComponentSafe(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

function defaultSources(root) {
  const projects = path.join(root, "projects");
  return lstat(projects)?.isDirectory() ? [projects] : [];
}

// Where a document sits decides what it is. A folder under a `projects`
// folder is a project, a folder or file under `clients` (and the like) is a
// company, under `people` a person. A front page (CONTEXT, README or index)
// directly inside such a folder IS that project or company, not a source.
function placeDocument(rootName, segments) {
  const folders = segments.slice(0, -1);
  const chain = [rootName, ...folders];
  const base = segments[segments.length - 1].replace(/\.[^.]+$/, "").toLowerCase();
  for (let index = 0; index < chain.length; index += 1) {
    const name = chain[index].toLowerCase();
    const kind = PROJECT_FOLDERS.has(name) ? "project" : COMPANY_FOLDERS.has(name) ? "company" : PERSON_FOLDERS.has(name) ? "person" : null;
    if (!kind) continue;
    if (index + 1 < chain.length) {
      return { kind, name: chain[index + 1], folder: chain.slice(0, index + 2).join("/"), front: index + 2 === chain.length && FRONT_PAGES.includes(base) ? FRONT_PAGES.indexOf(base) : -1 };
    }
    return kind === "project" ? { kind: null } : { kind, perFile: true };
  }
  // Anywhere else, a top-level folder is treated as a project and its files as sources.
  if (folders.length) return { kind: "project", name: folders[0], folder: `${rootName}/${folders[0]}`, front: -1, loose: true };
  return { kind: null };
}

function refuseSource(root, source) {
  const real = realpath(source) || path.resolve(source);
  for (const [folder, why] of [[brainDir(root), "the brain folder itself"], [path.join(root, "state"), "the install's own state folder"]]) {
    const blocked = realpath(folder) || folder;
    if (isInside(blocked, real)) throw new Error(`--from "${source}" is inside ${why} (${folder}). Name the folders that hold your documents instead.`);
  }
}

function planBuild(root, options, skipped) {
  const dir = brainDir(root);
  for (const source of options.from || []) refuseSource(root, path.resolve(source));
  const sources = [...new Set([...(options.includeDefault === false ? [] : defaultSources(root)), ...(options.from || []).map((entry) => path.resolve(entry))])];
  const exclude = [...new Set([dir, realpath(dir), path.join(root, "state"), realpath(path.join(root, "state")), ...(options.exclude || []).map((entry) => realpath(path.resolve(entry)) || path.resolve(entry))].filter(Boolean))];
  const maxFiles = Number.isInteger(options.maxFiles) && options.maxFiles > 0 ? options.maxFiles : DEFAULT_MAX_FILES;
  const maxNoteBytes = Number.isInteger(options.maxNoteBytes) && options.maxNoteBytes > 0 ? options.maxNoteBytes : DEFAULT_MAX_NOTE_BYTES;
  const notes = new Map();
  const roots = [];
  const labels = new Set();
  const warnings = [];
  // One note per identity. Two different things that would share a file name
  // are kept apart by a short hash of the second one's identity.
  // The folder being read right now. Every note a folder creates or touches
  // remembers it, so a later rebuild only tidies a note away when every folder
  // that produced it was read again in full.
  let currentRoot = null;
  const ensure = (type, name, title, identity = slugify(name)) => {
    let key = noteKey(type, slugify(name));
    if (notes.has(key) && notes.get(key).identity !== identity) key = noteKey(type, `${slugify(name)}-${sha256(identity).slice(0, 6)}`);
    if (!notes.has(key)) notes.set(key, { key, type, title, identity, summary: "", body: "", content: "", tags: [], relations: [], sources: [], roots: [] });
    const note = notes.get(key);
    if (currentRoot && !note.roots.includes(currentRoot)) note.roots.push(currentRoot);
    return note;
  };
  const relate = (from, type, to) => {
    if (from.key === to.key) return;
    if (!from.relations.some((relation) => relation.type === type && relation.target === to.key)) from.relations.push({ type, target: to.key });
  };

  // First the lists, so the limit can be shared fairly before anything is read.
  const listed = [];
  const truncated = new Set();
  const represented = new Set();
  for (const source of sources) {
    const real = realpath(source);
    if (!real || !fs.statSync(real).isDirectory()) { skipped.missingFolders.push(source); continue; }
    let label = slugify(path.basename(real));
    while (labels.has(label)) label = `${label}-${sha256(real).slice(0, 4)}`;
    labels.add(label);
    const unreadableBefore = skipped.unreadable;
    const largeBefore = skipped.tooLargeOrBinary;
    const files = listDocuments(real, exclude, skipped);
    listed.push({ label, realRoot: real, files, complete: skipped.unreadable === unreadableBefore && skipped.tooLargeOrBinary === largeBefore });
  }
  const eligibleDocuments = listed.reduce((sum, entry) => sum + entry.files.length, 0);
  options.extractionSession.start(eligibleDocuments);
  const quota = shareLimit(listed.map((entry) => entry.files.length), maxFiles);
  listed.forEach((entry, index) => {
    const left = entry.files.length - quota[index];
    if (left > 0) {
      skipped.overLimit += left;
      skipped.cutFolders.push({ folder: entry.realRoot, read: quota[index], left });
      entry.files = entry.files.slice(0, quota[index]);
      entry.complete = false;
    }
  });
  if (skipped.overLimit) {
    warnings.push(`LIMIT REACHED: ${skipped.overLimit} documents were NOT read because of the ${maxFiles} file limit (${skipped.cutFolders.map((cut) => `${path.basename(cut.folder)}: read ${cut.read}, left out ${cut.left}`).join("; ")}). Run again with --max-files <a larger number> to include them.`);
  }

  for (const entry of listed) {
    const { label, realRoot, files } = entry;
    currentRoot = realRoot;
    const rootName = path.basename(realRoot);
    // The organizer's own project index, when this folder has one.
    let projectIndex = {};
    try { projectIndex = JSON.parse(fs.readFileSync(path.join(realRoot, "_index.json"), "utf8")).projects || {}; } catch { /* no index here */ }
    const indexed = new Map(Object.values(projectIndex).filter((entry) => entry && typeof entry.path === "string").map((entry) => [entry.path.split("/")[0], entry]));

    // Each file is read once here for its few describing fields, then let go.
    const described = [];
    for (const item of files) {
      const description = options.extractionSession.describe(item.file, text => describeDocument(text, item.relative), item.relative);
      if (description === null) { skipped.tooLargeOrBinary += 1; entry.complete = false; continue; }
      described.push({ ...item, ...description, segments: item.relative.split("/") });
    }
    roots.push({ label, path: realRoot, documents: described.length, complete: entry.complete });
    if (!described.length) continue;

    const hub = ensure("topic", label, prettify(rootName), `folder:${realRoot}`);
    hub.summary ||= `Everything read from the ${rootName} folder.`;
    hub.sources.push(`${label}/`);

    const byRelative = new Map(described.map((document) => [document.relative.toLowerCase(), document]));
    const byBase = new Map();
    for (const document of described) {
      for (const base of new Set([slugify(path.basename(document.relative).replace(/\.[^.]+$/, "")), slugify(document.title)])) {
        byBase.set(base, byBase.has(base) && byBase.get(base) !== document ? null : document); // null marks an ambiguous name
      }
    }

    // Which project, company or person folder each document sits in.
    const groups = new Map();
    for (const document of described) {
      document.place = placeDocument(rootName, document.segments);
      const place = document.place;
      if (!place.kind || place.perFile) continue;
      if (!groups.has(place.folder)) {
        const entry = place.kind === "project" ? indexed.get(place.name) : null;
        const note = ensure(place.kind, place.name, (entry && typeof entry.name === "string" && entry.name) || prettify(place.name), `folder:${realRoot}/${place.folder}`);
        note.sources.push(`${label}/${place.folder.split("/").slice(1).join("/")}/`);
        relate(note, "belongs_to", hub);
        relate(hub, "related", note);
        groups.set(place.folder, { note, front: null, loose: place.loose === true });
      }
      const group = groups.get(place.folder);
      if (place.front >= 0 && (!group.front || place.front < group.front.place.front)) group.front = document;
    }

    const noteOfDocument = new Map();
    const loader = (document) => {
      const load = () => {
        const text = options.extractionSession.text(document.file);
        if (text === null) return "";
        represented.add(document.file);
        const content = copyContent(text, (target) => resolveLink(document, { kind: "wiki", target })?.key || null, maxNoteBytes, `${label}/${document.relative}`);
        if (content.includes("[Cut here: this note holds the first ")) truncated.add(document.file);
        return content;
      };
      load.documentFiles = [document.file];
      return load;
    };
    for (const document of described) {
      const place = document.place;
      const group = place.kind && !place.perFile ? groups.get(place.folder) : null;
      let note;
      if (group && group.front === document) {
        // The front page of a project or company folder is that note.
        note = group.note;
      } else if (place.perFile) {
        note = ensure(place.kind, document.title, document.title);
      } else {
        note = ensure("source", `${label}/${document.relative.replace(/\.[^.]+$/, "")}`, document.title, `file:${realRoot}/${document.relative}`);
      }
      if (!note.summary) note.summary = document.summary;
      note.load = combineLoads(note.load, loader(document));
      note.sources.push(`${label}/${document.relative}`);
      for (const tag of document.tags) if (!note.tags.includes(tag)) note.tags.push(tag);
      noteOfDocument.set(document.relative, note);
      const anchor = group ? group.note : null;
      if (anchor && note !== anchor) {
        relate(note, anchor.type === "project" && note.type === "source" ? "supports" : "related", anchor);
        relate(anchor, "related", note);
      } else if (!anchor) { relate(note, "belongs_to", hub); relate(hub, "related", note); }
      for (const name of document.people) {
        const person = ensure("person", name, name);
        relate(note, "related", person); relate(person, "related", note);
        if (anchor) { relate(anchor, "related", person); relate(person, "related", anchor); }
      }
      for (const name of document.companies) {
        const company = ensure("company", name, name);
        relate(note, "related", company); relate(company, "related", note);
        if (anchor) { relate(anchor, "related", company); relate(company, "related", anchor); }
      }
      for (const tag of document.tags) {
        const topic = ensure("topic", tag, prettify(tag));
        topic.summary ||= `Notes tagged ${tag}.`;
        relate(note, "related", topic); relate(topic, "related", note);
      }
    }
    // A loose top-level folder takes its summary from its own front page.
    for (const [folder, group] of groups) {
      if (group.note.summary || !group.loose) continue;
      const inner = folder.split("/").slice(1).join("/").toLowerCase();
      const front = ["context.md", "readme.md", "index.md", "overview.md"].map((name) => byRelative.get(`${inner}/${name}`)).find(Boolean);
      if (front) group.note.summary = front.summary;
    }
    // A link names a file: beside this one first, then by path, then by name.
    function resolveLink(document, link) {
      let target = null;
      if (link.kind === "path") {
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(document.relative), link.target)).toLowerCase();
        target = byRelative.get(resolved) || byRelative.get(`${resolved}.md`);
      } else {
        const wanted = link.target.replace(/\.md$/i, "").toLowerCase();
        const beside = path.posix.normalize(path.posix.join(path.posix.dirname(document.relative), wanted)).toLowerCase();
        target = byRelative.get(`${beside}.md`) || byRelative.get(`${wanted}.md`) || byBase.get(slugify(path.posix.basename(wanted))) || null;
      }
      return (target && noteOfDocument.get(target.relative)) || null;
    }
    // Links one document already makes to another become relations.
    for (const document of described) {
      const from = noteOfDocument.get(document.relative);
      for (const link of document.links) {
        const to = resolveLink(document, link);
        if (to) relate(from, "related", to);
      }
    }
  }

  mergeGivenNames(notes, existingNoteKeys(dir));
  for (const note of notes.values()) {
    if (!note.summary) note.summary = note.type === "person" ? "A person named in your documents." : note.type === "company" ? "A company named in your documents." : note.type === "project" ? "A project folder in your documents." : "";
    note.sources = [...new Set(note.sources)].sort();
    note.tags.sort();
  }
  return { notes, roots, warnings, sources, maxFiles, maxNoteBytes, eligibleDocuments, truncated, represented };
}

// "Dana" and "Dana Lee" are one person when Dana Lee is the only full name
// that starts with Dana. With two candidates the single name stays on its own.
function mergeGivenNames(notes, existing) {
  const fullNames = new Map();
  const remember = (key, title) => {
    const words = nameWords(title);
    if (words.length < 2) return;
    const first = words[0].toLowerCase();
    if (!fullNames.has(first)) fullNames.set(first, new Set());
    fullNames.get(first).add(key);
  };
  for (const note of notes.values()) if (note.type === "person") remember(note.key, note.title);
  for (const [key, title] of existing) if (key.startsWith(`${TYPE_DIRS.person}/`)) remember(key, title);
  for (const single of [...notes.values()]) {
    if (single.type !== "person" || nameWords(single.title).length !== 1) continue;
    const candidates = fullNames.get(single.title.toLowerCase());
    if (!candidates || candidates.size !== 1) continue;
    const targetKey = [...candidates][0];
    const full = notes.get(targetKey);
    // A note for the single name that came from its own file is only folded
    // into a full-name note that is part of this same build.
    if (!full && single.sources.length) continue;
    for (const note of notes.values()) {
      if (note === single) continue;
      note.relations = note.relations.map((relation) => relation.target === single.key ? { ...relation, target: targetKey } : relation)
        .filter((relation, index, all) => relation.target !== note.key && all.findIndex((other) => other.type === relation.type && other.target === relation.target) === index);
    }
    if (full) {
      for (const relation of single.relations) if (relation.target !== full.key && !full.relations.some((other) => other.type === relation.type && other.target === relation.target)) full.relations.push(relation);
      full.sources.push(...single.sources);
      for (const tag of single.tags) if (!full.tags.includes(tag)) full.tags.push(tag);
      full.summary ||= single.summary;
      full.load = combineLoads(full.load, single.load);
    }
    notes.delete(single.key);
  }
}

function combineLoads(...loads) {
  const documents = loads.filter((load) => typeof load === "function").flatMap((load) => load.documentLoads || [load]);
  if (!documents.length) return undefined;
  const combined = () => documents.map((load) => load()).filter(Boolean).join("\n\n---\n\n");
  combined.documentLoads = documents;
  return combined;
}

function newSkipped() {
  return { symlinks: 0, secrets: 0, folders: 0, otherFiles: 0, tooLargeOrBinary: 0, unreadable: 0, overLimit: 0, cutFolders: [], missingFolders: [] };
}

async function writeNotes(dir, state, notes, origin, options, result) {
  const known = existingNoteKeys(dir);
  for (const note of notes.values()) known.set(note.key, note.title);
  const byTitle = new Map();
  for (const [key, title] of known) if (!byTitle.has(String(title).toLowerCase())) byTitle.set(String(title).toLowerCase(), key);
  // A link survives only when it names a note that is in the brain.
  const resolve = (target) => {
    const direct = target.replace(/\.md$/i, "").normalize("NFC");
    return known.has(direct) ? direct : byTitle.get(target.toLowerCase()) || null;
  };
  const ordered = [...notes.values()].sort((a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type) || a.key.localeCompare(b.key));
  const pace = Number.isFinite(options.paceMs) && options.paceMs >= 0 ? options.paceMs : defaultPace(ordered.length);
  result.paceMs = pace;
  // The state is saved as the build goes and when the build is stopped, so a
  // build that is interrupted never forgets which notes are its own.
  const save = () => { try { writeState(dir, state); } catch { /* the next save tries again */ } };
  const stop = (signal) => { save(); process.exit(signal === "SIGINT" ? 130 : 143); };
  const onInt = () => stop("SIGINT");
  const onTerm = () => stop("SIGTERM");
  if (options.handleSignals !== false) { process.once("SIGINT", onInt); process.once("SIGTERM", onTerm); }
  let sinceSave = 0;
  try {
    for (const note of ordered) {
      const before = note.relations.length;
      note.relations = note.relations.filter((relation) => known.has(relation.target) && RELATION_TYPES.has(relation.type));
      result.droppedRelations += before - note.relations.length;
      note.title = plainLinks(note.title);
      note.summary = plainLinks(note.summary);
      note.body = note.body ? rewriteLinks(note.body, resolve) : "";
      if (typeof note.load === "function") { try { note.content = note.load(); } catch { note.content = ""; } }
      note.content = note.content ? rewriteLinks(note.content, resolve) : "";
      const outcome = writeNote(dir, state, note, known, origin);
      note.content = ""; // the text is in the file now; it is not held in memory
      if (origin === "pull") writeState(dir, state);
      result[outcome] += 1;
      if (outcome === "protected") result.protectedNotes.push(`${note.key}.md`);
      if (outcome !== "unchanged" && outcome !== "kept") {
        sinceSave += 1;
        if (sinceSave >= STATE_SAVE_EVERY) { save(); sinceSave = 0; }
      }
      if (outcome === "written" || outcome === "updated") {
        if (typeof options.onNote === "function") options.onNote({ outcome, note: `${note.key}.md`, title: note.title });
        await sleep(pace);
      }
    }
  } finally {
    process.removeListener("SIGINT", onInt);
    process.removeListener("SIGTERM", onTerm);
  }
}

// A rebuild tidies away notes this tool made earlier that no document produces
// any more (a file was renamed, moved or deleted), so the brain does not fill up
// with orphans. A note goes only when all of these hold:
//   - the build wrote it, nobody edited it, and `add` never touched it;
//   - it records the folders that produced it, and every one of them was read
//     again in this build, completely: listed without an error, under the file
//     limit, every file readable. A missing drive, a folder macOS will not let
//     us list, or a folder left off this time never costs a note;
//   - no note that this build will not rewrite (an edited note, an `add` note)
//     links to it, so removing it never leaves a link that goes nowhere.
// Notes from older versions record no folders and are never removed. Removed
// notes are still in the brain's own git history.
function tidyOrphans(dir, state, planned, roots, skipped, result) {
  result.removed = 0;
  result.removedNotes = [];
  result.orphansKept = [];
  if (skipped.overLimit) {
    result.tidy = "Old notes were not tidied away because the file limit was reached.";
    return;
  }
  const complete = new Set(roots.filter((entry) => entry.complete).map((entry) => entry.path));
  const partial = roots.filter((entry) => !entry.complete).map((entry) => entry.path);
  if (partial.length) result.tidy = `Notes from ${partial.length === 1 ? "this folder were" : "these folders were"} not tidied away because ${partial.length === 1 ? "it" : "they"} could not be read in full (a file too large, unreadable or blocked): ${partial.join(", ")}.`;
  const candidates = new Map();
  for (const [relative, tracked] of Object.entries(state.notes)) {
    if (!tracked || tracked.origin !== "build" || !Array.isArray(tracked.roots) || !tracked.roots.length) continue;
    const key = relative.replace(/\.md$/, "");
    if (planned.has(key) || !tracked.roots.every((folder) => complete.has(folder))) continue;
    const file = path.join(dir, relative);
    if (!isInside(dir, file)) continue;
    const info = lstat(file);
    if (!info) { delete state.notes[relative]; continue; }
    if (!info.isFile()) continue;
    if (sha256(fs.readFileSync(file, "utf8")) !== tracked.hash) { result.orphansKept.push(relative); continue; }
    candidates.set(key, file);
  }
  if (!candidates.size) return;
  const rewritten = (key, text) => planned.has(key) && state.notes[`${key}.md`]?.origin === "build" && sha256(text) === state.notes[`${key}.md`].hash;
  removeUnlinked(dir, state, candidates, rewritten, result);
}

// Removes the candidate notes that nothing else still links to. Any note in the
// brain, in any folder, that this run will not rewrite keeps the notes it links
// to. Links are matched the way Obsidian resolves them: full path, file name
// alone or title, ignoring case. A note that is kept this way keeps the notes it
// links to in turn. `rewritten(key, text)` says whether this run rewrites a note.
function removeUnlinked(dir, state, candidates, rewritten, result, dryRun = false) {
  const forms = new Map();
  const addForm = (form, key) => {
    const text = String(form || "").toLowerCase().normalize("NFC");
    if (!text) return;
    if (!forms.has(text)) forms.set(text, new Set());
    forms.get(text).add(key);
  };
  for (const key of candidates.keys()) {
    addForm(key, key);
    addForm(key.split("/").pop(), key);
    addForm(state.notes[`${key}.md`]?.title, key);
  }
  const linksOf = new Map();
  const holders = [];
  let unreadableNote = null;
  const walkBrain = (folder) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "atelier-output") continue;
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) { walkBrain(full); continue; }
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const relative = path.relative(dir, full).split(path.sep).join("/");
      let text;
      try { text = fs.readFileSync(full, "utf8"); } catch { unreadableNote = relative; continue; }
      linksOf.set(relative, [...wikilinkTargets(text), ...markdownLinkTargets(text, relative)]);
      const key = relative.replace(/\.md$/, "").replace(/\.proposed$/, "");
      if (candidates.has(key) && !relative.endsWith(".proposed.md")) continue;
      if (relative.endsWith(".proposed.md") || !rewritten(key, text)) holders.push(relative);
    }
  };
  walkBrain(dir);
  // A note that cannot be read might link to anything: tidy nothing this time.
  if (unreadableNote) {
    result.orphansKept.push(...[...candidates.keys()].map((key) => `${key}.md`));
    result.tidy = `Old notes were not tidied away because ${unreadableNote} could not be read.`;
    return;
  }
  const queue = [...holders];
  while (queue.length) {
    for (const target of linksOf.get(queue.pop()) || []) {
      for (const key of forms.get(target.replace(/\.md$/i, "").toLowerCase().normalize("NFC")) || []) {
        if (!candidates.has(key)) continue;
        candidates.delete(key);
        result.orphansKept.push(`${key}.md`);
        queue.push(`${key}.md`);
      }
    }
  }
  for (const [key, file] of candidates) {
    if (!dryRun) {
      fs.unlinkSync(file);
      const proposed = path.join(dir, `${key}.proposed.md`);
      if (lstat(proposed)?.isFile()) fs.unlinkSync(proposed);
      delete state.notes[`${key}.md`];
    }
    result.removed += 1;
    result.removedNotes.push(`${key}.md`);
  }
  result.removedNotes.sort();
}

// One build or add at a time per brain. A lock left by a process that is gone
// is taken over; a live one is refused with its process id.
const LOCK_FILE = ".brain.lock";

function takeLock(dir) {
  const file = path.join(dir, LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = fs.openSync(file, "wx");
      fs.writeSync(handle, String(process.pid));
      fs.closeSync(handle);
      return () => { try { if (fs.readFileSync(file, "utf8").trim() === String(process.pid)) fs.unlinkSync(file); } catch { /* already gone */ } };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let raw = "";
      try { raw = fs.readFileSync(file, "utf8"); } catch { /* vanished: try again */ }
      const owner = /^\d+$/.test(raw.trim()) ? Number.parseInt(raw, 10) : NaN;
      let alive = false;
      if (owner === process.pid) alive = true;
      else if (Number.isInteger(owner) && owner > 0) { try { process.kill(owner, 0); alive = true; } catch (probe) { alive = probe.code === "EPERM"; } }
      if (alive) throw new Error(`Another brain build is running (process ${owner}). Wait for it to finish, then run this again.`);
      // Take over only the lock that was read, never one another process just made.
      try { if (fs.readFileSync(file, "utf8") === raw) fs.unlinkSync(file); } catch { /* raced with its owner */ }
    }
  }
  throw new Error("The brain is busy. Run this again in a moment.");
}

async function buildUnlocked(options = {}) {
  const root = path.resolve(options.root || defaultRoot());
  const dir = brainDir(root);
  if (!lstat(dir)?.isDirectory()) init({ root });
  const configIO = require("./connector-pull");
  const config = configIO.readConfig(root);
  if (!(options.from || []).length && (config.from || []).length) {
    options = { ...config.build, ...options, from: config.from, includeDefault: false, maxFiles: options.maxFiles ?? config.build?.maxFiles, maxNoteBytes: options.maxNoteBytes ?? config.build?.maxNoteBytes, exclude: options.exclude ?? config.build?.exclude, extract: options.extract ?? config.build?.extract, ocr: options.ocr ?? config.build?.ocr };
  }
  const extractionSession = extraction.createSession(root, options);
  options = { ...options, extractionSession };
  const skipped = newSkipped();
  const { notes, roots, warnings, sources, maxFiles, maxNoteBytes, eligibleDocuments, truncated, represented } = planBuild(root, options, skipped);
  const state = readState(dir);
  const result = { ok: true, command: "build", root, brain: dir, folders: roots, notes: notes.size, written: 0, updated: 0, unchanged: 0, protected: 0, kept: 0, droppedRelations: 0, protectedNotes: [], skipped, warnings };
  // Before any note is written, so no new note links to one about to go.
  tidyOrphans(dir, state, notes, roots, skipped, result);
  const incremental = require("./build-cache").prepare(root, notes, state, extractionSession, represented, truncated, maxNoteBytes);
  result.unchanged += incremental.skipped;
  result.outputsReused = incremental.skipped;
  await writeNotes(dir, state, incremental.active, "build", options, result);
  incremental.finish();
  writeState(dir, state);
  result.extraction = extractionSession.finish(eligibleDocuments);
  for (const error of result.extraction.errors) warnings.push(`${error.code}: ${path.basename(error.path)}: ${error.message}`);
  result.coverage = { extractionComplete: result.extraction.complete, sources, excludedFolders: (options.exclude || []).map((entry) => path.resolve(entry)), maxFiles, maxNoteBytes, eligibleDocuments, documentsRead: roots.reduce((sum, entry) => sum + entry.documents, 0), documentsRepresented: represented.size, truncatedDocuments: truncated.size, complete: result.extraction.complete && sources.length > 0 && roots.length === sources.length && roots.every((entry) => entry.complete) && represented.size === roots.reduce((sum, entry) => sum + entry.documents, 0) && truncated.size === 0 && result.protected === 0 };
  if (!result.coverage.complete) warnings.push("COVERAGE INCOMPLETE: inspect coverage, skipped files and protected notes before claiming the selected second brain is fully represented.");
  result.degraded = !result.coverage.complete;
  if (options.remember === true) configIO.writeConfig(root, { ...config, from: sources, build: { maxFiles, maxNoteBytes, exclude: result.coverage.excludedFolders, ...(options.extract === true ? { extract: true } : {}), ...(options.ocr === true ? { ocr: true } : {}) } });
  writeRunRecord(root, "brain-build.json", { at: new Date().toISOString(), notes: notes.size, written: result.written, updated: result.updated, unchanged: result.unchanged, protected: result.protected, folders: roots.map((entry) => entry.label), coverage: result.coverage, skipped, warnings });
  if (!roots.length) result.message = "No folders to read yet. Name one with --from <folder>.";
  return result;
}


// build and add hold the brain's lock for their whole run.
async function locked(options, work) {
  const root = path.resolve(options.root || defaultRoot());
  const dir = brainDir(root);
  if (!lstat(dir)?.isDirectory()) init({ root });
  const release = takeLock(dir);
  try { return await work(options); } finally { release(); }
}

// A plan gathers only filesystem names and sizes. It never initializes the brain,
// takes a write lock, opens source documents, or starts an extraction session.
function inventoryBuild(options) {
  const root = path.resolve(options.root || defaultRoot());
  const config = require("./connector-pull").readConfig(root);
  if (!(options.from || []).length && (config.from || []).length) {
    options = { ...config.build, ...options, from: config.from, includeDefault: false, maxFiles: options.maxFiles ?? config.build?.maxFiles, exclude: options.exclude ?? config.build?.exclude };
  }
  validateFileLimit(options.maxFiles);
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const sources = [...new Set([...(options.includeDefault === false ? [] : defaultSources(root)), ...(options.from || []).map(entry => path.resolve(entry))])];
  for (const source of sources) refuseSource(root, source);
  const excludedFolders = (options.exclude || []).map(entry => path.resolve(entry));
  const exclusions = [brainDir(root), path.join(root, "state"), ...excludedFolders].flatMap(entry => [entry, realpath(entry)]).filter(Boolean);
  const skipped = newSkipped();
  const listed = [];
  for (const source of sources) {
    const real = realpath(source);
    if (!real || !fs.statSync(real).isDirectory()) { skipped.missingFolders.push(source); continue; }
    const unreadableBefore = skipped.unreadable;
    const files = listDocuments(real, exclusions, skipped);
    listed.push({ source, path: real, files, inventoryComplete: unreadableBefore === skipped.unreadable });
  }
  const quota = shareLimit(listed.map(entry => entry.files.length), maxFiles);
  const eligibleDocuments = listed.reduce((sum, entry) => sum + entry.files.length, 0);
  const files = [];
  const folders = listed.map((entry, index) => {
    const left = entry.files.length - quota[index];
    if (left) { skipped.overLimit += left; skipped.cutFolders.push({ folder: entry.path, planned: quota[index], left }); }
    const plannedBefore = files.length;
    for (const item of entry.files.slice(0, quota[index])) {
      const info = lstat(item.file);
      if (!info || !info.isFile()) { skipped.unreadable += 1; entry.inventoryComplete = false; continue; }
      files.push({ source: entry.path, path: item.file, relative: item.relative, bytes: info.size, extractionRequired: extraction.BINARY.has(path.extname(item.file).toLowerCase()) });
    }
    return { source: entry.source, path: entry.path, eligibleDocuments: entry.files.length, documentsPlanned: files.length - plannedBefore, inventoryComplete: entry.inventoryComplete };
  });
  const inventoryComplete = sources.length > 0 && folders.length === sources.length && folders.every(entry => entry.inventoryComplete);
  const capReached = skipped.overLimit > 0;
  return {
    ok: true, command: "build", plan: true, root, brain: brainDir(root), folders, files, skipped,
    coverage: { sources, excludedFolders, maxFiles, eligibleDocuments, documentsPlanned: files.length, documentsRead: 0, documentsRepresented: 0, inventoryComplete, capReached, fileSelectionComplete: inventoryComplete && !capReached, complete: false },
    warnings: [...(capReached ? [`LIMIT REACHED: ${skipped.overLimit} documents fall outside the ${maxFiles} file limit. Choose --max-files explicitly to change the cap.`] : []), "Inventory only: no document content was read or extracted, and no brain coverage has been verified."],
  };
}

function validateFileLimit(value) {
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) throw new Error("--max-files must be a positive safe whole number.");
}

function build(options = {}) {
  validateFileLimit(options.maxFiles);
  if (options.plan === true || options.dryRun === true) return Promise.resolve(inventoryBuild(options));
  return locked(options, buildUnlocked);
}
function add(options = {}) { return locked(options, addUnlocked); }

// ---------------------------------------------------------------------------
// add: notes the assistant understood from the customer's documents

function resolveTarget(target, index) {
  const text = String(target ?? "").trim();
  if (!text) return null;
  const direct = text.replace(/^\[\[|\]\]$/g, "").replace(/\.md$/i, "").normalize("NFC");
  if (index.keys.has(direct)) return direct;
  if (text.startsWith("brain:")) {
    const rest = text.slice(6);
    for (const type of TYPE_ORDER) {
      const prefix = `${TYPE_DIRS[type]}-`;
      if (rest.startsWith(prefix) && index.keys.has(`${TYPE_DIRS[type]}/${rest.slice(prefix.length)}`)) return `${TYPE_DIRS[type]}/${rest.slice(prefix.length)}`;
    }
    return null;
  }
  const wanted = text.toLowerCase();
  if (index.titles.has(wanted)) return index.titles.get(wanted);
  const slug = slugify(text);
  for (const type of TYPE_ORDER) if (index.keys.has(noteKey(type, slug))) return noteKey(type, slug);
  return null;
}

// A source line is shown inside backticks on one line, so it is kept to that.
function sourceLine(value) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/`/g, "").replace(/\s+/g, " ").trim().slice(0, 300);
}

async function addUnlocked(options = {}) {
  const root = path.resolve(options.root || defaultRoot());
  const dir = brainDir(root);
  if (!lstat(dir)?.isDirectory()) init({ root });
  const items = options.items;
  if (!Array.isArray(items)) throw new Error("add needs a JSON array of notes.");
  const state = readState(dir);
  const result = { ok: true, command: "add", root, brain: dir, notes: 0, written: 0, updated: 0, unchanged: 0, protected: 0, kept: 0, droppedRelations: 0, protectedNotes: [], rejected: [], unresolved: [], warnings: [] };
  const notes = new Map();
  for (const [position, item] of items.entries()) {
    const type = normalizeType(item?.type);
    const title = typeof item?.title === "string" ? plainLinks(item.title.replace(/[\u0000-\u001f\u007f]+/g, " ")).replace(/\s+/g, " ").trim().slice(0, 120) : "";
    if (!type || !title) { result.rejected.push({ position, reason: !type ? "type must be project, person, company, topic or source" : "title is required" }); continue; }
    // `note` names an existing note exactly, for example "projects/acme-launch".
    // Anything that is not exactly <folder>/<slug> is ignored, so a note can
    // only ever be written inside the brain's own five folders.
    const named = typeof item.note === "string" ? item.note.trim().replace(/\.md$/i, "").normalize("NFC") : "";
    const key = named && named === `${TYPE_DIRS[type]}/${slugify(named.split("/")[1] || "")}` ? named : noteKey(type, slugify(title));
    const tracked = state.notes[`${key}.md`];
    const note = notes.get(key) || { key, type, title, summary: "", body: "", content: "", tags: [], relations: [], sources: [], pending: [] };
    note.summary = redact(typeof item.summary === "string" ? item.summary : "").replace(/\s+/g, " ").trim().slice(0, 400) || note.summary || tracked?.summary || "";
    const body = redact(splitFrontMatter(typeof item.body === "string" ? item.body : "").body).replace(/\u0000/g, "").trim()
    const safeBody = body.replace(/^## (Related|Where this came from|Content)\s*$/gm, "### $1");
    note.body = safeBody || note.body || tracked?.body || "";
    for (const tag of asList(item.tags).map(sourceLine).filter(Boolean)) if (!note.tags.includes(tag)) note.tags.push(tag);
    for (const tag of tracked?.tags || []) if (!note.tags.includes(tag)) note.tags.push(tag);
    for (const source of [...(Array.isArray(item.source) ? item.source : item.source ? [item.source] : []).map(sourceLine).filter(Boolean), ...(tracked?.sources || [])]) if (!note.sources.includes(source)) note.sources.push(source);
    // An item that lists relations REPLACES the relations add gave this note
    // before (a renamed target must not leave the old link behind; customer
    // report 2026-10-20, F-33). Links the file pass found stay. An item with
    // no relations field leaves the note's relations as they are. Several
    // items for one note in the same call add up.
    if (Array.isArray(item.relations)) { note.replaceRelations = true; for (const relation of item.relations) note.pending.push(relation); }
    // The document text the file pass copied into this note stays in it.
    if (!note.content) { try { note.content = existingContent(fs.readFileSync(path.join(dir, `${key}.md`), "utf8")); } catch { /* a new note */ } }
    notes.set(key, note);
  }
  const index = { keys: existingNoteKeys(dir), titles: new Map() };
  for (const note of notes.values()) index.keys.set(note.key, note.title);
  for (const [key, title] of index.keys) if (!index.titles.has(String(title).toLowerCase())) index.titles.set(String(title).toLowerCase(), key);
  for (const note of notes.values()) {
    const tracked = state.notes[`${note.key}.md`];
    const owned = addOwnedRelations(tracked);
    const known = tracked?.relations || [];
    note.relations = note.replaceRelations ? known.filter((relation) => !owned.some((entry) => sameRelation(entry, relation))) : [...known];
    note.addedRelations = note.replaceRelations ? [] : owned.filter((entry) => known.some((relation) => sameRelation(relation, entry)));
    delete note.replaceRelations;
    for (const relation of note.pending) {
      let type = String(relation?.type ?? "related").trim().toLowerCase().replace(/[\s-]+/g, "_");
      if (!RELATION_TYPES.has(type)) { result.warnings.push(`${note.key}: relation type "${relation?.type}" is not known, stored as related`); type = "related"; }
      const target = resolveTarget(relation?.target, index);
      if (!target) { result.unresolved.push({ note: `${note.key}.md`, target: String(relation?.target ?? "") }); continue; }
      if (target !== note.key && !note.relations.some((entry) => entry.type === type && entry.target === target)) { note.relations.push({ type, target }); note.addedRelations.push({ type, target }); }
    }
    delete note.pending;
    note.tags.sort();
    note.sources.sort();
  }
  result.notes = notes.size;
  await writeNotes(dir, state, notes, "add", options, result);
  writeState(dir, state);
  return result;
}

// ---------------------------------------------------------------------------
// pull: digests of the customer's connected accounts
//
// `lib/connector-pull.js` reads each connected source (read-only) and turns
// what it finds into note items. This writes them. Every pulled note records
// its source as provenance (`origin: "pull"`, `pull: "<source>"`), so a later
// pull of the same source tidies away what that source no longer produces and
// `forget` removes the whole source again. A pulled note never takes over a
// note that `build`, `add`, another source or a person wrote: it is written as
// a source note beside it instead, linked to it.

const PULL_SOURCE = /^[a-z][a-z0-9-]{0,39}$/;

function pullSourceName(value) {
  const name = String(value ?? "").trim().toLowerCase();
  if (!PULL_SOURCE.test(name)) throw new Error(`A pull source name is lower-case letters, digits and dashes: "${value}" is not one.`);
  return name;
}

function pullItemText(value, max) {
  return redact(String(value ?? "").replace(/\u0000/g, "")).trim().slice(0, max);
}

async function pullUnlocked(options = {}) {
  const root = path.resolve(options.root || defaultRoot());
  const dir = brainDir(root);
  const source = pullSourceName(options.source);
  const plan = options.plan === true;
  const forget = options.forget === true;
  const items = forget ? [] : options.items;
  if (!Array.isArray(items)) throw new Error("pull needs a list of note items.");
  // An incomplete read (the cap cut in, the source failed part way) never tidies.
  const complete = forget || options.complete !== false;
  const exists = Boolean(lstat(dir)?.isDirectory());
  const state = exists ? readState(dir) : { version: 1, notes: {} };
  const onDisk = exists ? existingNoteKeys(dir) : new Map();
  const result = { ok: true, command: "pull", source, root, brain: dir, plan, forget, notes: 0, written: 0, updated: 0, unchanged: 0, protected: 0, kept: 0, droppedRelations: 0, protectedNotes: [], redirected: [], rejected: [], removed: 0, removedNotes: [], orphansKept: [], planned: [] };
  const owns = (key) => { const tracked = state.notes[`${key}.md`]; return tracked?.origin === "pull" && tracked.pull === source; };
  const taken = (key) => !owns(key) && (Boolean(state.notes[`${key}.md`]) || onDisk.has(key));
  const notes = new Map();
  for (const [position, item] of items.entries()) {
    const type = normalizeType(item?.type);
    const title = typeof item?.title === "string" ? plainLinks(item.title.replace(/[\u0000-\u001f\u007f]+/g, " ")).replace(/\s+/g, " ").trim().slice(0, 120) : "";
    if (!type || !title || isSecretLine(title)) { result.rejected.push({ position, reason: !type ? "type must be project, person, company, topic or source" : "title is missing or looks like a key" }); continue; }
    const named = typeof item.note === "string" ? item.note.trim().replace(/\.md$/i, "").normalize("NFC") : "";
    let key = named && named === `${TYPE_DIRS[type]}/${slugify(named.split("/")[1] || "")}` ? named : noteKey(type, slugify(title));
    const relations = [];
    if (taken(key)) {
      // Someone else's note has this name: write beside it and link to it.
      const beside = noteKey("source", slugify(`${source} ${key.split("/")[1]}`));
      if (taken(beside)) { result.rejected.push({ position, reason: `${key}.md and ${beside}.md already belong to something else` }); continue; }
      relations.push({ type: "related", target: key });
      result.redirected.push({ from: `${key}.md`, to: `${beside}.md` });
      key = beside;
    }
    if (notes.has(key)) { result.rejected.push({ position, reason: `another item in this pull already writes ${key}.md` }); continue; }
    const body = pullItemText(splitFrontMatter(typeof item.body === "string" ? item.body : "").body, 20000).replace(/^## (Related|Where this came from|Content)\s*$/gm, "### $1");
    const note = {
      key, type: key.startsWith(`${TYPE_DIRS.source}/`) ? "source" : type, title, pull: source,
      summary: pullItemText(item.summary, 400).replace(/\s+/g, " "), body, content: "",
      tags: [...new Set([`pulled/${source}`, ...asList(item.tags).map(sourceLine).filter(Boolean)])].sort(),
      sources: [...new Set((Array.isArray(item.source) ? item.source : item.source ? [item.source] : [`${source} (pulled)`]).map(sourceLine).filter(Boolean))].sort(),
      relations, pending: Array.isArray(item.relations) ? item.relations : [],
    };
    notes.set(key, note);
  }
  const index = { keys: new Map(onDisk), titles: new Map() };
  for (const note of notes.values()) index.keys.set(note.key, note.title);
  for (const [key, title] of index.keys) if (!index.titles.has(String(title).toLowerCase())) index.titles.set(String(title).toLowerCase(), key);
  for (const note of notes.values()) {
    for (const relation of note.pending) {
      let type = String(relation?.type ?? "related").trim().toLowerCase().replace(/[\s-]+/g, "_");
      if (!RELATION_TYPES.has(type)) type = "related";
      const target = resolveTarget(relation?.target, index);
      if (!target) { result.droppedRelations += 1; continue; }
      if (target !== note.key && !note.relations.some((entry) => entry.type === type && entry.target === target)) note.relations.push({ type, target });
    }
    if (options.mergeHistory && owns(note.key)) {
      for (const relation of state.notes[`${note.key}.md`]?.relations || []) {
        if (index.keys.has(relation.target) && RELATION_TYPES.has(relation.type) && !note.relations.some(entry => entry.type === relation.type && entry.target === relation.target)) note.relations.push(relation);
      }
    }
    delete note.pending;
  }
  result.notes = notes.size;
  result.planned = [...notes.keys()].sort().map((key) => `${key}.md`);
  // Tidy first, so no new note links to one about to go.
  if (exists && complete) {
    const candidates = new Map();
    for (const [relative, tracked] of Object.entries(state.notes)) {
      if (!tracked || tracked.origin !== "pull" || tracked.pull !== source) continue;
      const key = relative.replace(/\.md$/, "");
      if (notes.has(key)) continue;
      const file = path.join(dir, relative);
      if (!isInside(dir, file)) continue;
      const info = lstat(file);
      if (!info) { if (!plan) delete state.notes[relative]; continue; }
      if (!info.isFile()) continue;
      if (sha256(fs.readFileSync(file, "utf8")) !== tracked.hash) { result.orphansKept.push(relative); continue; }
      candidates.set(key, file);
    }
    if (candidates.size) removeUnlinked(dir, state, candidates, (key, text) => notes.has(key) && owns(key) && sha256(text) === state.notes[`${key}.md`].hash, result, plan);
  } else if (!complete) {
    result.tidy = `Old ${source} notes were not tidied away because this read was not complete (the cap was reached or the source failed part way).`;
  }
  if (plan) return result;
  await writeNotes(dir, state, notes, "pull", options, result);
  writeState(dir, state);
  writeRunRecord(root, `brain-pull-${source}.json`, { at: new Date().toISOString(), source, forget, complete, notes: notes.size, written: result.written, updated: result.updated, unchanged: result.unchanged, protected: result.protected, removed: result.removed });
  return result;
}

// --plan reads the brain and writes nothing, so it takes no lock and makes no folder.
function pull(options = {}) {
  if (options.plan === true) return pullUnlocked(options);
  return locked(options, pullUnlocked);
}

// ---------------------------------------------------------------------------
// graph, open, status

// Counts the notes in the five note folders and the links between them. The
// brain's own README is a guide, not a note, and is not counted.
function countBrain(dir, cachedCounts) {
  const counts = cachedCounts || require("./graph-metadata").scan(dir, TYPE_DIRS).counts;
  const entities = counts.byType.projects + counts.byType.people + counts.byType.companies + (counts.byType.decisions || 0) + (counts.byType.ideas || 0);
  if (counts.notes > 0 && entities < counts.notes * 0.05) counts.hint = "Almost every note is a source document. Projects, people, decisions and ideas come from the assistant's `brain add` pass, or a reviewed brain import proposal with cited evidence.";
  return counts;
}

function graph(options = {}) {
  const root = path.resolve(options.root || defaultRoot());
  const dir = brainDir(root);
  if (!lstat(dir)?.isDirectory()) throw new Error(`There is no brain at ${dir} yet. Run init, then build.`);
  const metadata = require("./graph-metadata").scan(dir, TYPE_DIRS, true);
  const result = { ok: true, command: "graph", root, brain: dir, metadataBodiesRead: metadata.bodiesRead, degraded: false, ...countBrain(dir, metadata.counts), commit: "none", atelier: { present: false, nodes: null, edges: null, diagnostics: null, file: null }, warnings: [] };
  if (lstat(path.join(dir, ".git"))) {
    const staged = git(dir, ["add", "-A"]);
    const pending = staged.status === 0 ? git(dir, ["status", "--porcelain"]) : staged;
    if (pending.status !== 0) result.warnings.push(`The brain could not be saved to its local history: ${firstLine(pending)}`);
    else if (pending.stdout.trim()) {
      // Local history only. This never pushes anywhere.
      const committed = git(dir, ["commit", "--quiet", "-m", `Brain update: ${result.notes} notes`]);
      if (committed.status === 0) result.commit = git(dir, ["rev-parse", "--short", "HEAD"]).stdout.trim() || "saved";
      else result.warnings.push(`The brain could not be saved to its local history: ${firstLine(committed)}`);
    } else result.commit = "nothing new";
  } else result.warnings.push("The brain folder is not a git repository yet, so no history was saved. Run init.");

  const atelier = findAtelier(root);
  if (!atelier) {
    result.degraded = true;
    result.warnings.push(`Atelier is not installed in this install, so the Atelier graph file was not built. Your notes and their links are complete. To add it: ${atelierInstallHint(root)}`);
  } else {
    result.atelier.present = true;
    const projection = require("./graph-metadata").project(root, metadata.files);
    if (!lstat(path.join(projection, "atelier.project.json"))) runAtelier(atelier, ["adopt", "--profile", "single-repo", "--yes"], projection);
    const projectedOutput = path.join(projection, "atelier-output", "knowledge.graph.json");
    if (lstat(projectedOutput)?.isFile()) fs.renameSync(projectedOutput, `${projectedOutput}.previous`);
    const built = runAtelier(atelier, ["graph"], projection);
    const file = path.join(dir, "atelier-output", "knowledge.graph.json");
    const line = `${built.stdout}\n${built.stderr}`.match(/knowledge graph:\s*(\d+)\s*nodes\D+(\d+)\s*edges(?:\D+(\d+)\s*diagnostics)?/i);
    if (line) Object.assign(result.atelier, { nodes: Number(line[1]), edges: Number(line[2]), diagnostics: line[3] === undefined ? null : Number(line[3]) });
    try {
      if (built.status !== 0) throw new Error("Atelier failed; previous graph must not count as current.");
      const inputFile = path.join(projection, "atelier-output", "knowledge.graph.json");
      const data = JSON.parse(fs.readFileSync(inputFile, "utf8"));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.copyFileSync(inputFile, file);
      result.atelier.file = file;
      if (Array.isArray(data.nodes)) result.atelier.nodes = data.nodes.length;
      if (Array.isArray(data.edges)) result.atelier.edges = data.edges.length;
      if (Array.isArray(data.diagnostics)) result.atelier.diagnostics = data.diagnostics.length;
    } catch { /* counts from the printed line stand */ }
    if (built.status !== 0 || result.atelier.file === null || result.atelier.nodes === null) {
      result.degraded = true;
      result.warnings.push(`Atelier did not finish the graph: ${(built.stderr || built.stdout).trim().split("\n").slice(-3).join(" ") || `exit ${built.status}`}`);
    }
  }
  result.stateFile = writeRunRecord(root, "brain-graph.json", { at: new Date().toISOString(), ...result });
  return result;
}

// Opens the brain in Obsidian, straight into the graph view. With `install`
// the viewer is installed first when it is missing. Nothing here can fail the
// brain: every outcome is reported and the command still exits cleanly.
function open(options = {}) {
  const root = path.resolve(options.root || defaultRoot());
  const dir = brainDir(root);
  if (!lstat(dir)?.isDirectory()) throw new Error(`There is no brain at ${dir} yet. Run init first.`);
  const result = { ok: true, command: "open", root, brain: dir, viewer: "missing", install: { attempted: false }, opened: false, openedWith: null, viewerConfig: [], vaultList: "skipped", warnings: [] };
  let viewer = findViewer();
  if (!viewer && options.install) {
    let outcome;
    try { outcome = installViewer(options); } catch (error) { outcome = { ok: false, method: "none", detail: `the install stopped: ${error.message}` }; }
    const { warnings = [], ...rest } = outcome;
    result.install = { attempted: true, ...rest };
    result.warnings.push(...warnings);
    viewer = findViewer();
  }
  if (!viewer) {
    const remedy = process.platform === "darwin"
      ? "To install it: brew install --cask obsidian (or download it from https://obsidian.md/download)."
      : "Download it from https://obsidian.md/download.";
    result.message = result.install.attempted
      ? `Obsidian could not be installed: ${result.install.detail}. Your brain does not need it: it is plain files in ${dir}. ${remedy}`
      : `Obsidian is not installed. It is optional: it only shows the notes in ${dir}. ${remedy} Or run this again with --install.`;
    return result;
  }
  result.viewer = "present";
  result.app = viewer;
  // Who signed the app that is about to be opened. Reported, never a blocker:
  // an app the customer installed themselves is theirs to trust.
  try {
    const identity = appIdentity(viewer, options.tools);
    result.appCheck = { identifier: identity.identifier, team: identity.team, matches: identity.matches };
    if (!identity.matches) result.warnings.push(`The app at ${viewer} is not signed as Obsidian by its publisher (found identifier "${identity.identifier || "none"}", team "${identity.team || "none"}"). It was opened anyway because it was already installed; check where it came from.`);
  } catch { result.appCheck = { identifier: null, team: null, matches: false }; }
  try { result.viewerConfig = writeViewerConfig(dir); } catch (error) { result.warnings.push(`Viewer settings could not be written: ${error.message}`); }
  try { result.vaultList = registerVault(dir, options); } catch (error) { result.vaultList = `left alone: ${error.message}`; }
  if (options.launch === false) { result.message = `Viewer settings are ready. Open ${dir} as a vault in Obsidian.`; return result; }
  const opener = options.openCommand || process.env.BRAIN_OPEN_CMD || "open";
  const uri = `obsidian://open?path=${encodeURIComponent(dir)}`;
  let launched = run(opener, [uri]);
  if (launched.status === 0) result.openedWith = uri;
  else {
    launched = run(opener, ["-a", viewer, dir]);
    if (launched.status === 0) result.openedWith = `open -a ${viewer}`;
  }
  result.opened = launched.status === 0;
  result.message = result.opened
    ? `Obsidian is opening ${dir} on the graph view. If it asks whether to trust the folder or to open it as a vault, say yes: it is your own brain folder. If it shows its vault list instead, choose "Open folder as vault" and pick that folder.`
    : `Obsidian did not open (${firstLine(launched)}). Open it yourself, choose "Open folder as vault" and pick ${dir}.`;
  return result;
}

function lastPulls(root) {
  const out = {};
  let names = [];
  try { names = fs.readdirSync(path.join(root, "state")); } catch { return out; }
  for (const name of names.sort()) {
    const match = name.match(/^brain-pull-([a-z][a-z0-9-]{0,39})\.json$/);
    if (!match) continue;
    const record = readRunRecord(root, name);
    if (record) out[match[1]] = { at: record.at, notes: record.notes, complete: record.complete, forget: record.forget };
  }
  return out;
}

function status(options = {}) {
  const root = path.resolve(options.root || defaultRoot());
  const dir = brainDir(root);
  const exists = Boolean(lstat(dir)?.isDirectory());
  const lastGraph = readRunRecord(root, "brain-graph.json");
  return {
    ok: true, command: "status", root, brain: dir, exists,
    ...(exists ? countBrain(dir) : { notes: 0, wikilinks: 0, brokenWikilinks: 0, proposed: 0, byType: {} }),
    git: exists && Boolean(lstat(path.join(dir, ".git"))),
    lastBuild: readRunRecord(root, "brain-build.json"),
    lastExtraction: readRunRecord(root, "brain-extraction.json"),
    lastRefresh: readRunRecord(root, "brain-refresh.json"),
    lastPulls: lastPulls(root),
    lastGraph: lastGraph && { at: lastGraph.at, notes: lastGraph.notes, wikilinks: lastGraph.wikilinks, nodes: lastGraph.atelier?.nodes ?? null, edges: lastGraph.atelier?.edges ?? null, degraded: lastGraph.degraded },
    atelier: findAtelier(root) ? "present" : "missing",
    atelierAdopted: exists && Boolean(lstat(path.join(dir, "atelier.project.json"))),
    viewer: findViewer() ? "present" : "missing",
    viewerConfigured: exists && Boolean(lstat(path.join(dir, ".obsidian"))),
  };
}

module.exports = {
  STATE_FILE, MAX_PACE_MS, PACE_BUDGET_MS, DEFAULT_MAX_NOTE_BYTES, TYPE_DIRS, RELATION_TYPES, OBSIDIAN_IDENTIFIER, OBSIDIAN_TEAM, REMOVED_LINE,
  defaultPace, installViewer, installViewerFromDiskImage, verifyViewerApp, appIdentity, registerVault, writeViewerConfig, viewerFiles,
  init, build, add, pull, graph, open, status,
  isSecretLine, redact, pullSourceName, writeRunRecord, readRunRecord,
  defaultRoot, brainDir, findAtelier, findViewer, slugify, renderNote, splitFrontMatter, parseFrontMatter, countBrain,
  rewriteLinks, copyContent, shareLimit, looksLikeName, placeDocument,
};
