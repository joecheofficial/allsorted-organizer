"use strict";

// Connector pull: turns what the customer's connected accounts hold into notes
// in their second brain. One note per contact or customer with recent
// interactions, one per mail thread or chat, one per month of payments, one
// per month of calendar events, one per recently changed Drive file and one per
// month of email sent through Resend.
//
// What it holds to, every time:
//   - Read only. It reuses the adapters the installed modules already ship
//     (Google through its command-line tool, Stripe through the Stripe module, WhatsApp through
//     its local message database, Resend through the key lookup of the Resend
//     module) and allows only their search, list and GET calls. It has no
//     sign-in of its own: each module uses the sign-in the customer already set
//     up for it.
//   - Opt in, per source. Nothing is read unless the source is named on the
//     command line or listed in <root>/state/brain-refresh-settings.json.
//   - Bounded. A date window (30 days unless told otherwise, a year at most) and
//     a cap per source (100 unless told otherwise, 500 at most).
//   - Privacy filtered. A message that looks like it carries a password, a key,
//     a sign-in code or a reset link is left out whole, not trimmed. Event
//     descriptions, card details, addresses and full phone numbers are never
//     read into a note. A Drive file whose name or opening text looks like it
//     holds credentials is left out whole; only Google Docs get a short
//     excerpt. Sent-email notes count recipients and never name them. Every
//     line also goes through the brain's key filter.
//   - Every pulled note carries its source, so the next pull of that source
//     tidies away what it no longer produces and `--forget` removes it all.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const brain = require("./brain");

const SOURCES = ["mail", "calendar", "messages", "payments", "drive", "sent"];
const SOURCE_ALIASES = { email: "mail", gmail: "mail", whatsapp: "messages", stripe: "payments", events: "calendar", "google-drive": "drive", gdrive: "drive", docs: "drive", resend: "sent", "sent-email": "sent", "sent-mail": "sent" };
const DEFAULT_DAYS = 30;
const MAX_DAYS = 366;
const DEFAULT_MAX = 100;
const MAX_MAX = 500;
const SNIPPET = 160;
const RECENT_PER_NOTE = 8;
const CONFIG_FILE = "brain-refresh-settings.json";
// Drive: at most this many Google Docs are opened per pull, this much of each
// is read, and this much of what was read can appear in a note.
const DOC_EXCERPT_FILES = 25;
const DOC_READ_BYTES = 4000;
const DOC_EXCERPT = 280;
const RESEND_PAGE = 100;
const SUBJECTS_PER_MONTH = 15;

// Allowed adapter calls. Anything else is refused before it runs.
const GOG_READS = new Set(["gmail search", "calendar events", "drive search", "docs cat"]);
const STRIPE_READS = new Set(["/v1/charges"]);
const RESEND_READS = new Set(["/emails"]);

// A message is left out whole when it looks like it carries a way in.
const SENSITIVE_MESSAGE = /\b(?:verification|security|confirmation|login|log-in|sign[- ]?in|one[- ]time|auth(?:entication|orization)?|access|otp|2fa|mfa|recovery|backup)\s*(?:code|pin|number|link)\b|\b(?:otp|passcode|password|passwd|pwd|pin code|api[ _-]?key|secret key|private key|seed phrase|recovery phrase)\b|\breset (?:your |my )?password\b|\b(?:magic|sign[- ]?in|login) link\b/i;
// A 4 to 8 digit group (dashes or spaces allowed) near a word that says code,
// log in or verify, in either order; and anything shaped like a card number.
const DIGIT_GROUP = String.raw`\d(?:[ -]?\d){3,7}(?![\d])`;
const CODE_WORD = String.raw`\b(?:codes?|pins?|log[ -]?in|login|sign[ -]?in|verify|verification|passcode|otp)\b`;
const CODE_NEAR_DIGITS = new RegExp(`${CODE_WORD}[^\\n]{0,40}?(?<![\\d])${DIGIT_GROUP}`, "i");
const DIGITS_NEAR_CODE = new RegExp(`(?<![\\d])${DIGIT_GROUP}[^\\n]{0,40}?${CODE_WORD}`, "i");
const CARD_NUMBER = /(?<!\d)\d(?:[ -]?\d){12,18}(?!\d)/;
// A Drive file named like a password list, a key file or a recovery sheet is
// never read and gets no note.
const CREDENTIAL_FILE = /\b(?:passwords?|passwds?|pwds?|credentials?|creds|secrets?|api[ _-]?keys?|access[ _-]?keys?|tokens?|private[ _-]?keys?|recovery[ _-]?(?:codes?|keys?|phrases?)|backup[ _-]?codes?|seed[ _-]?phrases?|2fa|mfa|otp|logins? (?:list|details|info)|wallets?|keystore|keychain|vault)\b|(?:^|[\\/])\.env(?:\.|$)|\.(?:env|pem|key|p12|pfx|kdbx|keychain|ovpn|asc|gpg|ppk)$|\bid_(?:rsa|dsa|ecdsa|ed25519)\b/i;
const GOOGLE_DOC = "application/vnd.google-apps.document";
const DRIVE_KINDS = {
  "application/vnd.google-apps.document": "Google Doc",
  "application/vnd.google-apps.spreadsheet": "Google Sheet",
  "application/vnd.google-apps.presentation": "Google Slides",
  "application/vnd.google-apps.form": "Google Form",
  "application/vnd.google-apps.drawing": "Google Drawing",
  "application/pdf": "PDF",
};
const DRIVE_SKIPPED_KINDS = new Set(["application/vnd.google-apps.folder", "application/vnd.google-apps.shortcut"]);
// Text that is left out whole in every detail mode: phone numbers, lines that
// read like a postal address, and anything about doses, injections or side
// effects (a customer's health question is never copied into a note).
const PHONE_NUMBER = /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?)?(?<![\d-])\d{2,4}[\s.-]\d{3,4}[\s.-]\d{3,4}(?![\d-])|\+\d[\d\s().-]{7,}\d/;
const POSTAL_ADDRESS = /\b\d{1,6}[A-Za-z]?\s+(?:[A-Za-z0-9.'-]+\s+){1,4}(?:street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr|court|ct|way|place|pl|terrace|parkway|pkwy|highway|hwy|circle|cir|square|sq)\b\.?|\b(?:jalan|jl)\.?\s+[A-Za-z]|\bp\.?\s?o\.?\s?box\b|\b(?:ship(?:ping)?|deliver(?:y)?|send it|mail it) to\b|\b(?:billing|shipping|postal|home|street|mailing) address\b|\b(?:zip ?code|post ?code)\b/i;
const STATE_ZIP = /\b[A-Z]{2}\s\d{5}(?:-\d{4})?\b/;
const HEALTH_TERMS = /\b(?:dos(?:e|es|ed|ing|age|ages)|inject(?:s|ed|ing|ion|ions|able|ables)?|vials?|cycles?|cycling|side[- ]?effects?|sub-?q|subcutaneous(?:ly)?|intramuscular|reconstitut\w*|titrat\w*|bacteriostatic)\b|(?:\b|\d)(?:mg|mcg|\u00b5g|ug|iu)\b/i;
function privateText(text) {
  const value = String(text ?? "");
  return PHONE_NUMBER.test(value) || POSTAL_ADDRESS.test(value) || STATE_ZIP.test(value) || HEALTH_TERMS.test(value);
}
const DETAILS = ["metadata", "full"];
const NO_REPLY = /(?:^|[._+-])(?:no-?reply|do-?not-?reply|donotreply|notifications?|mailer-daemon|bounce|alerts?)(?:[._+-]|@)/i;

function sha(text, length = 8) {
  return crypto.createHash("sha256").update(String(text)).digest("hex").slice(0, length);
}

function canonicalSource(value) {
  const name = String(value ?? "").trim().toLowerCase();
  return SOURCE_ALIASES[name] || name;
}

function wholeNumber(value, fallback, max, label) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error(`${label} must be a whole number of at least 1.`);
  return Math.min(number, max);
}

// The window: --since YYYY-MM-DD, or --days N back from now.
function windowFor(options = {}, now = new Date()) {
  const end = new Date(now);
  let start, clamped = null;
  if (options.since) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(options.since))) throw new Error("--since must be a date like 2026-09-01.");
    start = new Date(`${options.since}T00:00:00Z`);
    if (Number.isNaN(start.getTime())) throw new Error("--since is not a real date.");
    const earliest = new Date(end.getTime() - MAX_DAYS * 86400000);
    if (start < earliest) { clamped = { requested: String(options.since), applied: day(earliest), maxDays: MAX_DAYS }; start = earliest; }
    if (start > end) throw new Error("--since is in the future.");
  } else {
    const days = wholeNumber(options.days, DEFAULT_DAYS, MAX_DAYS, "--days");
    if (Number(options.days) > MAX_DAYS) clamped = { requested: `${Number(options.days)} days`, applied: `${MAX_DAYS} days`, maxDays: MAX_DAYS };
    start = new Date(end.getTime() - days * 86400000);
  }
  return { start, end, days: Math.max(1, Math.round((end - start) / 86400000)), ...(clamped ? { clamped } : {}) };
}

function day(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

function month(value) {
  return day(value).slice(0, 7);
}

// The Google tool's --wrap-untrusted output wraps every fetched text field in
// markers with a random id that changes on every call. They are taken off
// before any text is used, so titles and note names stay stable.
// The opening marker is followed by a short header ("Source: ..." and "---")
// that is taken off with it.
const UNTRUSTED_OPEN = /<<<\s*EXTERNAL[_ ]UNTRUSTED[_ ]CONTENT\b[^>]*>>>[ \t]*\r?\n?(?:[ \t]*Source:[^\n]*\r?\n)?(?:[ \t]*---[ \t]*\r?\n)?/gi;
const UNTRUSTED_CLOSE = /\r?\n?[ \t]*<<<\s*END[_ ]EXTERNAL[_ ]UNTRUSTED[_ ]CONTENT\b[^>]*>>>/gi;
function unwrap(value) {
  return String(value ?? "").replace(UNTRUSTED_OPEN, " ").replace(UNTRUSTED_CLOSE, " ").trim();
}

function clean(value, max = SNIPPET) {
  const text = unwrap(value).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

// The text of one message as it may appear in a note, or null when it must not.
function safeSnippet(value) {
  const raw = unwrap(value);
  if (!raw.trim()) return null;
  if (SENSITIVE_MESSAGE.test(raw)) return null;
  if (raw.split(/\r?\n/).some((line) => brain.isSecretLine(line))) return null;
  // A long run of digits on its own reads like a code or an account number.
  if (/\b\d{6,}\b/.test(raw)) return null;
  if (CODE_NEAR_DIGITS.test(raw) || DIGITS_NEAR_CODE.test(raw)) return null;
  if (CARD_NUMBER.test(raw)) return null;
  if (privateText(raw)) return null;
  const text = clean(raw);
  return brain.isSecretLine(text) ? null : text;
}

function safeTitle(value, fallback) {
  const text = clean(value, 100);
  if (!text || SENSITIVE_MESSAGE.test(text) || brain.isSecretLine(text) || privateText(text)) return fallback;
  return text;
}

// "Name <address>" -> { name, email }
function parseAddress(value) {
  const text = clean(value, 300);
  const match = text.match(/^\s*"?([^"<]*?)"?\s*<([^>\s]+@[^>\s]+)>\s*$/);
  if (match) return { name: clean(match[1], 80), email: match[2].toLowerCase() };
  const bare = text.match(/[^\s<>,;]+@[^\s<>,;]+/);
  return { name: bare ? "" : clean(text, 80), email: bare ? bare[0].toLowerCase() : "" };
}

function personTitle(name, email) {
  if (name && !/@/.test(name)) return name;
  return email || name || "";
}

// ---------------------------------------------------------------------------
// Adapters. Each default adapter loads a module the customer already installed
// under <root> and wraps it so only read calls get through.

function requireInstalled(root, relative, what) {
  const file = path.join(root, relative);
  if (!fs.existsSync(file)) {
    const error = new Error(`${what} is not installed at ${relative}. Install and connect it first, or leave this source out.`);
    error.code = "NOT_INSTALLED";
    throw error;
  }
  return require(file);
}

function readOnlyGog(runGog, account) {
  return (command) => {
    const verb = command.slice(0, 2).join(" ");
    if (!GOG_READS.has(verb)) throw new Error(`Refused: "${verb}" is not a read call.`);
    const result = runGog({ account }, command);
    if (!result || result.status !== "ok") {
      const error = new Error(result?.reply || "the Google module did not answer");
      error.code = result?.status === "unavailable" ? "NOT_CONNECTED" : "SOURCE_FAILED";
      error.retryDeferred = result?.metadata?.retryDeferred === true;
      error.nextAttemptAt = result?.metadata?.nextAttemptAt;
      throw error;
    }
    return result.data;
  };
}

function readOnlyStripe(stripeRequest) {
  return (endpoint, params) => {
    if (!STRIPE_READS.has(endpoint)) throw new Error(`Refused: ${endpoint} is not an allowed read.`);
    return stripeRequest("GET", endpoint, params);
  };
}

function readOnlyResend(resendRequest) {
  return (endpoint, params) => {
    if (!RESEND_READS.has(endpoint)) throw new Error(`Refused: ${endpoint} is not an allowed read.`);
    return resendRequest("GET", endpoint, params);
  };
}

// A GET against the Resend API with the key the Resend module looks up. The
// key is passed straight into the request header and never kept or printed.
function resendHttp(baseUrl, apiKey, fetchImpl = globalThis.fetch) {
  return async (method, endpoint, params = {}) => {
    if (method !== "GET") throw new Error(`Refused: ${method} is not a read.`);
    const url = new URL(`${String(baseUrl).replace(/\/+$/, "")}${endpoint}`);
    for (const [name, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== "") url.searchParams.set(name, String(value));
    const response = await fetchImpl(url, { method: "GET", headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(`Resend answered ${response.status}${data?.message ? `: ${clean(data.message, 200)}` : ""}`);
      error.code = response.status === 401 || response.status === 403 ? "NOT_CONNECTED" : "SOURCE_FAILED";
      throw error;
    }
    return data;
  };
}

// Drive file ids are letters, digits, dashes and underscores. Anything else
// (a flag, a path) never reaches the command line, and an id never starts
// with a dash, so it cannot be read as an option.
const DRIVE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{9,199}$/;

function listFrom(data, keys) {
  if (Array.isArray(data)) return data;
  for (const key of keys) if (Array.isArray(data?.[key])) return data[key];
  return [];
}

function pageFrom(data, keys) {
  return { items: listFrom(data, keys), nextPageToken: data?.nextPageToken || null, complete: !data?.nextPageToken };
}
function unpackPage(data, max) {
  if (Array.isArray(data)) return { rows: data, complete: data.length < max, nextPageToken: null };
  if (!data || !Array.isArray(data.items)) throw new Error("Provider returned no page items");
  return { rows: data.items, complete: data.items.length <= max && data.complete === true && !data.nextPageToken, nextPageToken: data.nextPageToken || null };
}

function defaultAdapters(root, options = {}) {
  const account = options.account || "";
  const google = () => {
    if (!account) { const error = new Error("Name the Google account to read with --account (or pull.account in the refresh settings)."); error.code = "NEEDS_ACCOUNT"; throw error; }
    return readOnlyGog(requireInstalled(root, path.join("google", "recipes", "runtime.js"), "The Google module").runGog, account);
  };
  return {
    mail: {
      // Thread headers only: sender, subject, date and the short preview.
      async searchThreads({ after, to, max, pageToken }) {
        const gog = google();
        const query = `after:${after.replace(/-/g, "/")} ${to ? `before:${to.replace(/-/g, "/")} ` : ""}-in:chats -in:spam -in:trash`;
        return pageFrom(gog(["gmail", "search", query, "--max", String(max), ...(pageToken ? ["--page", pageToken] : [])]), ["threads", "messages", "results"]);
      },
    },
    calendar: {
      async listEvents({ from, to, max, pageToken }) {
        const gog = google();
        return pageFrom(gog(["calendar", "events", "--from", from, "--to", to, "--max", String(max), ...(pageToken ? ["--page", pageToken] : [])]), ["events", "items"]);
      },
    },
    messages: {
      // The WhatsApp module's own message database, opened read-only.
      async listMessages({ sinceSeconds, max }) {
        const file = path.resolve(options.whatsappDb || path.join(root, "whatsapp", "server", "messages.db"));
        if (!fs.existsSync(file)) { const error = new Error("No WhatsApp message database was found. Link WhatsApp in its module first, or pass --whatsapp-db."); error.code = "NOT_CONNECTED"; throw error; }
        const since = Math.floor(Number(sinceSeconds));
        const limit = Math.floor(Number(max)) * 40;
        const sql = `SELECT m.jid AS jid, m.from_me AS fromMe, m.text AS text, m.timestamp AS timestamp, c.name AS name, c.push_name AS pushName
FROM messages m LEFT JOIN conversations c ON c.jid = m.jid
WHERE (CASE WHEN m.timestamp > 100000000000 THEN m.timestamp / 1000 ELSE m.timestamp END) >= ${since}
AND m.jid NOT LIKE '%@broadcast' AND m.jid NOT LIKE '%@newsletter'
ORDER BY m.timestamp DESC LIMIT ${limit};`;
        const output = execFileSync("sqlite3", ["-readonly", "-json", file, sql], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
        return output.trim() ? JSON.parse(output) : [];
      },
    },
    drive: {
      // File metadata only: name, kind and when it last changed. Folders,
      // shortcuts and trashed files are not listed.
      async searchFiles({ after, to, max, pageToken }) {
        const gog = google();
        const query = `modifiedTime > '${after}T00:00:00' ${to ? `and modifiedTime < '${to}T00:00:00' ` : ''}and trashed = false and mimeType != 'application/vnd.google-apps.folder'`;
        return pageFrom(gog(["drive", "search", query, "--raw-query", "--max", String(max), ...(pageToken ? ["--page", pageToken] : [])]), ["files", "items", "results"]);
      },
      // The opening text of one Google Doc, at most DOC_READ_BYTES of it.
      async docText({ id }) {
        if (!DRIVE_ID.test(String(id))) throw new Error("Refused: not a Drive file id.");
        const gog = google();
        const data = gog(["docs", "cat", String(id), "--max-bytes", String(DOC_READ_BYTES)]);
        if (typeof data === "string") return data;
        for (const key of ["text", "content", "body"]) if (typeof data?.[key] === "string") return data[key];
        return "";
      },
    },
    sent: {
      // Resend's list of sent emails, newest first: subject, recipients, the
      // last delivery event and when it was sent. Never the body.
      async listEmails({ sinceSeconds, max }) {
        const runtime = requireInstalled(root, path.join("resend", "src", "runtime.js"), "The Resend module");
        let apiKey;
        try { apiKey = runtime.getApiKey(); } catch { const error = new Error("The Resend module is installed but not connected."); error.code = "NOT_CONNECTED"; throw error; }
        const get = readOnlyResend(options.resendRequest || resendHttp(runtime.BASE_URL || "https://api.resend.com", apiKey));
        const rows = [];
        let after;
        for (;;) {
          const page = await get("/emails", { limit: RESEND_PAGE, ...(after ? { after } : {}) });
          const data = Array.isArray(page?.data) ? page.data : [];
          let older = false;
          for (const email of data) {
            const sent = resendDate(email.created_at);
            if (sent && sent.getTime() / 1000 < sinceSeconds) { older = true; break; }
            rows.push(email);
            if (rows.length >= max) break;
          }
          if (older || rows.length >= max || !page?.has_more || !data.length) break;
          after = data[data.length - 1].id;
        }
        return rows;
      },
    },
    payments: {
      async listCharges({ sinceSeconds, max }) {
        const stripe = requireInstalled(root, path.join("stripe", "bin", "stripe.js"), "The Stripe module");
        if (typeof stripe.statusCheck === "function" && !stripe.statusCheck().configured) { const error = new Error("The Stripe module is installed but not connected."); error.code = "NOT_CONNECTED"; throw error; }
        const get = readOnlyStripe(stripe.stripeRequest);
        const rows = [];
        let after;
        while (rows.length < max) {
          const page = await get("/v1/charges", { limit: Math.min(100, max - rows.length), created: { gte: sinceSeconds }, ...(after ? { starting_after: after } : {}) });
          const data = Array.isArray(page?.data) ? page.data : [];
          rows.push(...data);
          if (!page?.has_more || !data.length) break;
          after = data[data.length - 1].id;
        }
        return rows;
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Digests: source rows -> note items for brain.pull

// detail "metadata": who, when and how many only. No thread notes (their
// names carry subjects), no subjects and no previews.
function mailItems(threads, max, { detail = "full" } = {}) {
  const metadata = detail === "metadata";
  const items = [];
  const people = new Map();
  for (const thread of threads.slice(0, max)) {
    const id = String(thread.id || thread.threadId || "");
    const { name, email } = parseAddress(thread.from || thread.sender || "");
    const date = day(thread.date || thread.internalDate || thread.timestamp || "");
    const subject = safeTitle(thread.subject, "(subject left out)");
    const count = Number(thread.messageCount || thread.messages?.length || 1) || 1;
    const sender = personTitle(name, email);
    const automated = !email || NO_REPLY.test(email);
    const title = `Email: ${subject}`.slice(0, 110);
    const key = `sources/mail-${brain.slugify(subject).slice(0, 50)}-${sha(id || `${subject}${date}`)}`;
    if (metadata) {
      if (automated || !sender) continue;
      const person = people.get(email) || { name: sender, email, threads: [] };
      person.threads.push({ date, count, key });
      people.set(email, person);
      continue;
    }
    const preview = safeSnippet(thread.snippet || thread.preview);
    const lines = [`- Date: ${date || "unknown"}`, `- From: ${sender || "unknown"}`, `- Messages in the thread: ${count}`];
    if (preview) lines.push("", `Preview: ${preview}`);
    items.push({ type: "source", note: key, title, summary: `Email thread from ${sender || "an unknown sender"}${date ? ` on ${date}` : ""}.`, body: lines.join("\n"), relations: !automated && sender ? [{ type: "related", target: sender }] : [], source: "mail (pulled)", _key: key, _date: date });
    if (automated || !sender) continue;
    const person = people.get(email) || { name: sender, email, threads: [] };
    person.threads.push({ date, subject, key });
    people.set(email, person);
  }
  for (const person of people.values()) {
    person.threads.sort((a, b) => b.date.localeCompare(a.date) || a.key.localeCompare(b.key));
    if (metadata) {
      const messages = person.threads.reduce((sum, entry) => sum + entry.count, 0);
      const lines = [`- Email: ${person.email}`, `- Threads in this window: ${person.threads.length}`, `- Messages in those threads: ${messages}`, `- Last email: ${person.threads[0].date || "unknown"}`, "", "Recent thread dates:", ...person.threads.slice(0, RECENT_PER_NOTE).map((entry) => `- ${entry.date || "undated"}: ${entry.count} message${entry.count === 1 ? "" : "s"}`)];
      items.push({ type: "person", title: person.name, summary: `Recent email with ${person.name}.`, body: lines.join("\n"), source: "mail (pulled)" });
      continue;
    }
    const lines = [`- Email: ${person.email}`, `- Threads in this window: ${person.threads.length}`, `- Last email: ${person.threads[0].date || "unknown"}`, "", "Recent threads:", ...person.threads.slice(0, RECENT_PER_NOTE).map((entry) => `- ${entry.date || "undated"}: ${entry.subject}`)];
    items.push({ type: "person", title: person.name, summary: `Recent email with ${person.name}.`, body: lines.join("\n"), relations: person.threads.slice(0, RECENT_PER_NOTE).map((entry) => ({ type: "related", target: entry.key })), source: "mail (pulled)" });
  }
  return items.map(({ _key, _date, ...item }) => item);
}

function maskJid(jid) {
  const digits = String(jid).split("@")[0].replace(/\D/g, "");
  return digits.length >= 4 ? `ending ${digits.slice(-4)}` : "unknown number";
}

function messageItems(rows, max, { detail = "full" } = {}) {
  const metadata = detail === "metadata";
  const chats = new Map();
  for (const row of rows) {
    const jid = String(row.jid || "");
    if (!jid) continue;
    const seconds = Number(row.timestamp) > 1e11 ? Math.floor(Number(row.timestamp) / 1000) : Number(row.timestamp);
    if (!chats.has(jid)) chats.set(jid, { jid, name: clean(row.name || row.pushName || "", 80), latest: seconds, count: 0, recent: [] });
    const chat = chats.get(jid);
    chat.count += 1;
    if (seconds > chat.latest) chat.latest = seconds;
    if (!chat.name && (row.name || row.pushName)) chat.name = clean(row.name || row.pushName, 80);
    if (!metadata && chat.recent.length < RECENT_PER_NOTE) {
      const text = safeSnippet(row.text);
      chat.recent.push({ seconds, who: Number(row.fromMe) ? "You" : "Them", text });
    }
  }
  const ordered = [...chats.values()].sort((a, b) => b.latest - a.latest || a.jid.localeCompare(b.jid)).slice(0, max);
  const complete = chats.size <= max;
  const items = ordered.map((chat) => {
    const group = chat.jid.endsWith("@g.us");
    const label = safeTitle(chat.name, "") || (group ? `group ${sha(chat.jid, 6)}` : `contact ${maskJid(chat.jid)}`);
    const lines = [`- Messages in this window: ${chat.count}`, `- Last message: ${day(chat.latest * 1000)}`];
    const shown = chat.recent.filter((entry) => entry.text);
    const hidden = chat.recent.length - shown.length;
    if (shown.length) lines.push("", "Most recent messages:", ...shown.map((entry) => `- ${day(entry.seconds * 1000)} ${entry.who}: ${entry.text}`));
    if (hidden) lines.push("", `${hidden} recent message${hidden === 1 ? " was" : "s were"} left out because ${hidden === 1 ? "it" : "they"} looked like a code, a password, a number, an address, a phone number or a health detail.`);
    if (group) return { type: "topic", title: `WhatsApp group: ${label}`, summary: `Recent WhatsApp group messages in ${label}.`, body: lines.join("\n"), source: "messages (pulled)" };
    return { type: "person", title: label, summary: `Recent WhatsApp messages with ${label}.`, body: lines.join("\n"), source: "messages (pulled)" };
  });
  return { items, complete };
}

const ZERO_DECIMAL = new Set(["bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf"]);

function money(amount, currency) {
  const code = String(currency || "usd").toLowerCase();
  const value = ZERO_DECIMAL.has(code) ? amount : amount / 100;
  return `${value.toFixed(ZERO_DECIMAL.has(code) ? 0 : 2)} ${code.toUpperCase()}`;
}

// personNotes: false (a distribution whose default detail is metadata, such
// as PeptAIOS) keeps monthly totals only: no note per paying person and no
// link to a person's name.
function paymentItems(charges, { detail = "full", personNotes = true } = {}) {
  const metadata = detail === "metadata";
  const months = new Map();
  const customers = new Map();
  for (const charge of charges) {
    const created = new Date(Number(charge.created) * 1000);
    const key = month(created);
    if (!key) continue;
    const currency = String(charge.currency || "usd").toLowerCase();
    if (!months.has(key)) months.set(key, { key, count: 0, succeeded: 0, failed: 0, refunds: 0, totals: {}, customers: new Set() });
    const entry = months.get(key);
    entry.count += 1;
    if (charge.status === "succeeded") entry.succeeded += 1;
    if (charge.status === "failed") entry.failed += 1;
    if (charge.amount_refunded) entry.refunds += 1;
    entry.totals[currency] ||= { gross: 0, refunded: 0 };
    if (charge.status === "succeeded") entry.totals[currency].gross += Number(charge.amount) || 0;
    entry.totals[currency].refunded += Number(charge.amount_refunded) || 0;
    const name = safeTitle(charge.billing_details?.name, "");
    if (!name) continue;
    entry.customers.add(name);
    const customer = customers.get(name.toLowerCase()) || { name, charges: [] };
    customer.charges.push({ date: day(created), month: key, amount: Number(charge.amount) || 0, currency, status: String(charge.status || "unknown"), refunded: Number(charge.amount_refunded) || 0, what: metadata ? null : safeSnippet(charge.description) });
    customers.set(name.toLowerCase(), customer);
  }
  const items = [];
  for (const entry of [...months.values()].sort((a, b) => a.key.localeCompare(b.key))) {
    const lines = [`- Charges: ${entry.count} (${entry.succeeded} succeeded, ${entry.failed} failed, ${entry.refunds} with a refund)`];
    for (const currency of Object.keys(entry.totals).sort()) {
      const total = entry.totals[currency];
      lines.push(`- ${currency.toUpperCase()}: ${money(total.gross, currency)} taken, ${money(total.refunded, currency)} refunded, ${money(total.gross - total.refunded, currency)} net`);
    }
    if (entry.customers.size) lines.push(`- Paying customers named on charges: ${entry.customers.size}`);
    items.push({ type: "source", title: `Payments ${entry.key}`, summary: `Payments received in ${entry.key}, from the Stripe module.`, body: lines.join("\n"), relations: personNotes ? [...entry.customers].sort().map((name) => ({ type: "related", target: name })) : [], source: "payments (pulled)" });
  }
  if (!personNotes) return items;
  for (const customer of [...customers.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    customer.charges.sort((a, b) => b.date.localeCompare(a.date));
    const monthsSeen = [...new Set(customer.charges.map((charge) => charge.month))].sort();
    if (metadata) {
      // Totals only: no single charge, no description.
      const totals = {};
      for (const charge of customer.charges) {
        totals[charge.currency] ||= { paid: 0, refunded: 0 };
        if (charge.status === "succeeded") totals[charge.currency].paid += charge.amount;
        totals[charge.currency].refunded += charge.refunded;
      }
      const lines = [`- Charges in this window: ${customer.charges.length}`, `- Last charge: ${customer.charges[0].date}`, ...Object.keys(totals).sort().map((currency) => `- Total paid: ${money(totals[currency].paid, currency)}, refunded: ${money(totals[currency].refunded, currency)}`)];
      items.push({ type: "person", title: customer.name, summary: `Customer: payment totals for ${customer.name}.`, body: lines.join("\n"), relations: monthsSeen.map((key) => ({ type: "related", target: `Payments ${key}` })), source: "payments (pulled)" });
      continue;
    }
    const lines = [`- Charges in this window: ${customer.charges.length}`, "", "Recent charges:", ...customer.charges.slice(0, RECENT_PER_NOTE).map((charge) => `- ${charge.date}: ${money(charge.amount, charge.currency)}, ${charge.status}${charge.refunded ? `, ${money(charge.refunded, charge.currency)} refunded` : ""}${charge.what ? `, ${charge.what}` : ""}`)];
    items.push({ type: "person", title: customer.name, summary: `Customer: recent payments from ${customer.name}.`, body: lines.join("\n"), relations: monthsSeen.map((key) => ({ type: "related", target: `Payments ${key}` })), source: "payments (pulled)" });
  }
  return items;
}

function calendarItems(events, { detail = "full" } = {}) {
  const metadata = detail === "metadata";
  const months = new Map();
  for (const event of events) {
    const start = event.start?.dateTime || event.start?.date || event.startTime || event.start || "";
    const key = month(start);
    if (!key) continue;
    if (!months.has(key)) months.set(key, { key, events: [], people: new Set() });
    const entry = months.get(key);
    const attendees = (Array.isArray(event.attendees) ? event.attendees : []).filter((person) => !person.self && !person.resource);
    for (const person of attendees) {
      const title = personTitle(clean(person.displayName || "", 80), String(person.email || "").toLowerCase());
      if (title && !NO_REPLY.test(String(person.email || ""))) entry.people.add(title);
    }
    entry.events.push({ date: day(start), title: metadata ? "event" : safeTitle(event.summary || event.title, "(title left out)"), attendees: attendees.length });
  }
  return [...months.values()].sort((a, b) => a.key.localeCompare(b.key)).map((entry) => {
    entry.events.sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
    const lines = [`- Events: ${entry.events.length}`, "", ...entry.events.map((event) => `- ${event.date}: ${event.title}${event.attendees ? ` (${event.attendees} other${event.attendees === 1 ? "" : "s"})` : ""}`)];
    // People are linked only when the brain already has a note for them.
    return { type: "source", title: `Calendar ${entry.key}`, summary: `Calendar events in ${entry.key}.`, body: lines.join("\n"), relations: [...entry.people].sort().map((name) => ({ type: "related", target: name })), source: "calendar (pulled)" };
  });
}

// Resend gives "2026-10-01 09:00:00.123456+00"; ISO strings pass straight through.
function resendDate(value) {
  if (!value) return null;
  const text = String(value).trim().replace(/^(\d{4}-\d{2}-\d{2}) /, "$1T").replace(/([+-]\d{2})$/, "$1:00");
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

// True when a Drive file should get no note at all: its name, or the text read
// from it, looks like it holds credentials.
function credentialFile(name, text = "") {
  const title = unwrap(name);
  if (CREDENTIAL_FILE.test(title) || SENSITIVE_MESSAGE.test(title) || brain.isSecretLine(title)) return true;
  const body = unwrap(text);
  if (!body.trim()) return false;
  if (SENSITIVE_MESSAGE.test(body) || CARD_NUMBER.test(body)) return true;
  return body.split(/\r?\n/).some((line) => brain.isSecretLine(line));
}

// The short excerpt a Google Doc note may carry, or null when the opening text
// holds anything shaped like a code or an account number.
function docExcerpt(text) {
  const raw = unwrap(text).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!raw) return null;
  const cut = raw.length > DOC_EXCERPT ? `${raw.slice(0, DOC_EXCERPT - 1).trimEnd()}…` : raw;
  if (/\b\d{6,}\b/.test(cut) || CODE_NEAR_DIGITS.test(cut) || DIGITS_NEAR_CODE.test(cut) || privateText(raw.slice(0, DOC_EXCERPT * 2))) return null;
  return brain.isSecretLine(cut) ? null : cut;
}

function driveKind(mimeType) {
  return DRIVE_KINDS[String(mimeType || "")] || "File";
}

// Which files get a note, and which Google Docs get opened for an excerpt.
function driveSelection(files, max) {
  const kept = [];
  let leftOut = 0;
  for (const file of files.slice(0, max)) {
    const mimeType = String(file.mimeType || "");
    if (DRIVE_SKIPPED_KINDS.has(mimeType) || file.trashed === true) continue;
    const id = unwrap(file.id || "");
    if (!id) continue;
    if (credentialFile(file.name || file.title || "")) { leftOut += 1; continue; }
    kept.push({ file, id, mimeType });
  }
  const docs = kept.filter((entry) => entry.mimeType === GOOGLE_DOC && DRIVE_ID.test(entry.id)).slice(0, DOC_EXCERPT_FILES).map((entry) => entry.id);
  return { kept, docs, leftOut };
}

function driveItems(files, max, texts = new Map(), { detail = "full" } = {}) {
  const metadata = detail === "metadata";
  const selection = driveSelection(files, max);
  const items = [];
  let leftOut = selection.leftOut;
  for (const { file, id, mimeType } of selection.kept) {
    const text = texts.get(id);
    if (text !== undefined && credentialFile("", text)) { leftOut += 1; continue; }
    const name = safeTitle(file.name || file.title, "");
    if (!name) { leftOut += 1; continue; }
    const kind = driveKind(mimeType);
    const changed = day(file.modifiedTime || file.modified || "");
    const key = `sources/drive-${brain.slugify(name).slice(0, 50)}-${sha(id)}`;
    const lines = [`- Kind: ${kind}`, `- Last changed: ${changed || "unknown"}`];
    const excerpt = metadata || text === undefined ? null : docExcerpt(text);
    if (excerpt) lines.push("", `Opening text: ${excerpt}`);
    items.push({ type: "source", note: key, title: `Document: ${name}`.slice(0, 110), summary: `${kind} in Google Drive${changed ? `, last changed ${changed}` : ""}.`, body: lines.join("\n"), source: "drive (pulled)" });
  }
  return { items, leftOut };
}

function sentItems(emails, { detail = "full" } = {}) {
  const metadata = detail === "metadata";
  const months = new Map();
  for (const email of emails) {
    const sent = resendDate(email.created_at);
    const key = sent ? month(sent) : "";
    if (!key) continue;
    if (!months.has(key)) months.set(key, { key, count: 0, recipients: new Set(), events: {}, subjects: new Map(), hidden: 0 });
    const entry = months.get(key);
    entry.count += 1;
    for (const address of (Array.isArray(email.to) ? email.to : email.to ? [email.to] : [])) {
      const { email: bare } = parseAddress(address);
      if (bare) entry.recipients.add(bare);
    }
    const event = String(email.last_event || "unknown").toLowerCase().replace(/[^a-z_]/g, "") || "unknown";
    entry.events[event] = (entry.events[event] || 0) + 1;
    const subject = safeTitle(email.subject, "");
    if (!subject) { entry.hidden += 1; continue; }
    entry.subjects.set(subject, (entry.subjects.get(subject) || 0) + 1);
  }
  return [...months.values()].sort((a, b) => a.key.localeCompare(b.key)).map((entry) => {
    const events = Object.keys(entry.events).sort().map((name) => `${name.replace(/_/g, " ")} ${entry.events[name]}`).join(", ");
    const subjects = [...entry.subjects.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const lines = [`- Emails sent: ${entry.count}, to ${entry.recipients.size} recipient${entry.recipients.size === 1 ? "" : "s"}`, `- Last delivery event: ${events}`];
    if (!metadata && subjects.length) lines.push("", "Subjects:", ...subjects.slice(0, SUBJECTS_PER_MONTH).map(([subject, count]) => `- ${subject}: ${count}`));
    if (!metadata && subjects.length > SUBJECTS_PER_MONTH) lines.push(`- ${subjects.length - SUBJECTS_PER_MONTH} more subject${subjects.length - SUBJECTS_PER_MONTH === 1 ? "" : "s"}`);
    if (!metadata && entry.hidden) lines.push("", `${entry.hidden} email${entry.hidden === 1 ? " had its subject" : "s had their subjects"} left out because ${entry.hidden === 1 ? "it" : "they"} looked like a code, a password, a number, an address, a phone number or a health detail.`);
    return { type: "source", title: `Sent email ${entry.key}`, summary: `Email sent through Resend in ${entry.key}.`, body: lines.join("\n"), source: "sent (pulled)" };
  });
}

// ---------------------------------------------------------------------------
// Settings: <root>/state/brain-refresh-settings.json (opt-in list, account, passes)

function configPath(root) {
  return path.join(path.resolve(root), "state", CONFIG_FILE);
}

function readConfig(root) {
  try {
    const value = JSON.parse(fs.readFileSync(configPath(root), "utf8"));
    return value && typeof value === "object" ? value : {};
  } catch { return {}; }
}

function writeConfig(root, value) {
  const file = configPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
  return file;
}

// How much of each item a pull copies: "full" (today's notes) or "metadata"
// (who, when and counts only). The command line wins, then the remembered
// setting, then the distribution's default in the install's lock
// (brainPullDetail), then "full".
function lockDetail(root) {
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(root, "allsorted-dist.lock.json"), "utf8"));
    return DETAILS.includes(lock?.brainPullDetail) ? lock.brainPullDetail : null;
  } catch { return null; }
}

// Detail is remembered PER SOURCE (pull.perSource.<source>.detail). Older
// installs kept one pull.detail for every source, so remembering
// "--detail full" for payments (even a payments pull that was skipped) turned
// full detail on for messages as well, and the daily refresh rewrote every
// WhatsApp note in full. The command line still wins for its own run.
function detailFor(root, options, settings, source) {
  const remembered = source ? perSourceSettings(root, settings)[source]?.detail : undefined;
  const chosen = options.detail ?? remembered ?? (source ? undefined : settings.detail) ?? lockDetail(root) ?? "full";
  const value = String(chosen).trim().toLowerCase();
  if (!DETAILS.includes(value)) throw new Error(`--detail is ${DETAILS.join(" or ")}, not "${chosen}".`);
  return value;
}

const stricter = (a, b) => (a === "metadata" || b === "metadata" ? "metadata" : "full");
const GOOGLE_SOURCES = ["mail", "calendar", "drive"];

// The per-source settings, with the old single pull.detail / pull.account
// migrated in memory. One remembered detail cannot say which source asked for
// it, so it is ambiguous: every source gets the STRICTER of it and the
// distribution default (metadata whenever either is metadata). The old single
// account applies to the Google sources it was always used for.
function perSourceSettings(root, settings) {
  const current = settings.perSource && typeof settings.perSource === "object" && !Array.isArray(settings.perSource) ? settings.perSource : {};
  const out = {};
  for (const source of SOURCES) out[source] = { ...(current[source] && typeof current[source] === "object" ? current[source] : {}) };
  const legacyDetail = typeof settings.detail === "string" ? settings.detail.trim().toLowerCase() : null;
  if (legacyDetail && DETAILS.includes(legacyDetail)) {
    const migrated = stricter(legacyDetail, lockDetail(root) ?? "full");
    for (const source of SOURCES) if (out[source].detail === undefined) out[source].detail = migrated;
  }
  if (typeof settings.account === "string" && settings.account) {
    for (const source of GOOGLE_SOURCES) if (out[source].account === undefined) out[source].account = settings.account;
  }
  return out;
}

// Settings with the per-source shape written out and the old single values
// removed, so the migration happens once and never re-widens.
function migratedSettings(root, settings) {
  const next = { ...settings, perSource: perSourceSettings(root, settings) };
  for (const source of Object.keys(next.perSource)) if (!Object.keys(next.perSource[source]).length) delete next.perSource[source];
  delete next.detail;
  delete next.account;
  return next;
}

// Default output is counts only: every list of note names is replaced by its
// length, so nothing a note is named after (a person, a subject) is printed.
// --verbose keeps the names for a person reading the result.
const NAME_LISTS = ["planned", "removedNotes", "redirected", "rejected", "kept"];
function countsOnly(entry) {
  for (const key of NAME_LISTS) if (Array.isArray(entry[key])) entry[key] = entry[key].length;
  delete entry.tidy;
  return entry;
}

function chosenSources(options, config) {
  const named = (Array.isArray(options.sources) ? options.sources : options.sources ? [options.sources] : []).map(canonicalSource);
  const list = named.length ? named : (Array.isArray(config.pull?.sources) ? config.pull.sources.map(canonicalSource) : []);
  for (const source of list) if (!SOURCES.includes(source)) throw new Error(`Unknown source "${source}". Choose from ${SOURCES.join(", ")}.`);
  return [...new Set(list)];
}

// ---------------------------------------------------------------------------
// pull

async function readSource(source, adapters, window, max, detail = "full", { personNotes = true, pageToken, history = false } = {}) {
  const after = day(window.start);
  const how = { detail };
  if (source === "mail") {
    const page = unpackPage(await adapters.mail.searchThreads({ after, max, pageToken, ...(history ? { to: day(window.end) } : {}) }), max);
    const threads = page.rows;
    return { items: mailItems(threads, max, how), read: threads.length, complete: page.complete, nextPageToken: page.nextPageToken };
  }
  if (source === "calendar") {
    const to = day(new Date(window.end.getTime() + 14 * 86400000));
    const page = unpackPage(await adapters.calendar.listEvents({ from: after, to: history ? day(window.end) : to, max, pageToken }), max);
    const events = page.rows;
    return { items: calendarItems(events, how), read: events.length, complete: page.complete, nextPageToken: page.nextPageToken };
  }
  if (source === "messages") {
    const rows = await adapters.messages.listMessages({ sinceSeconds: Math.floor(window.start.getTime() / 1000), max });
    const { items, complete } = messageItems(rows, max, how);
    return { items, read: rows.length, complete: complete && rows.length < max * 40 };
  }
  if (source === "drive") {
    const page = unpackPage(await adapters.drive.searchFiles({ after, max, pageToken, ...(history ? { to: day(window.end) } : {}) }), max);
    const files = page.rows;
    const texts = new Map();
    // Metadata detail opens no document at all.
    for (const id of detail === "metadata" ? [] : driveSelection(files, max).docs) {
      try { texts.set(id, String(await adapters.drive.docText({ id }) ?? "")); } catch (error) {
        if (error.code === "NOT_CONNECTED") throw error;
        // One document that cannot be opened keeps its metadata note, no excerpt.
      }
    }
    const { items, leftOut } = driveItems(files, max, texts, how);
    return { items, read: files.length, complete: page.complete, nextPageToken: page.nextPageToken, leftOut };
  }
  if (source === "sent") {
    const emails = await adapters.sent.listEmails({ sinceSeconds: Math.floor(window.start.getTime() / 1000), max });
    return { items: sentItems(emails, how), read: emails.length, complete: emails.length < max };
  }
  const charges = await adapters.payments.listCharges({ sinceSeconds: Math.floor(window.start.getTime() / 1000), max });
  return { items: paymentItems(charges, { ...how, personNotes }), read: charges.length, complete: charges.length < max };
}

// Preserve each page's aggregate evidence separately. Canonical entities keep
// cumulative links, while counts and dates belong to a particular page.
function historyItems(items, pageId) {
  const keys = new Map();
  for (const item of items.filter(item => item.type === "source")) {
    const key = `sources/history-${pageId}-${sha(item.note || item.title)}`;
    keys.set(item.title, key);
    keys.set(item.note || `sources/${brain.slugify(item.title)}`, key);
  }
  const relationsFor = item => (item.relations || []).map(relation => ({ ...relation, target: keys.get(relation.target) || relation.target }));
  return items.flatMap(item => {
    if (item.type === "source") return [{ ...item, note: keys.get(item.title), title: `${item.title.slice(0, 85)} history page ${pageId}`, relations: relationsFor(item) }];
    const title = `${item.title.slice(0, 85)} history page ${pageId}`;
    const key = `sources/${brain.slugify(title)}`;
    return [{ ...item, body: "", summary: `See linked history pages for dated evidence.`, relations: [...relationsFor(item), { type: "related", target: key }] },
      { type: "source", note: key, title, body: String(item.body || "").replace(/in this window/g, "on this page"), summary: "Evidence from one page of the fixed history query.", source: item.source, relations: [{ type: "related", target: item.title }] }];
  });
}

async function pullConnectors(options = {}) {
  const root = path.resolve(options.root || brain.defaultRoot());
  const config = readConfig(root);
  const settings = config.pull && typeof config.pull === "object" ? config.pull : {};
  const sources = chosenSources(options, config);
  const plan = options.plan === true;
  const result = { ok: true, command: "pull", root, plan, readOnly: true, sources: {}, message: "" };
  if (!sources.length) {
    result.message = `No source is opted in. Name one or more with --source (${SOURCES.join(", ")}). Nothing was read.`;
    return result;
  }
  // Validated before anything is saved or read.
  const since = options.since ?? (options.days === undefined ? settings.since : undefined);
  const window = windowFor({ days: options.days ?? settings.days, since }, options.now ? new Date(options.now) : new Date());
  if (options.until !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(options.until)) throw new Error("--until requires YYYY-MM-DD");
    window.end = new Date(`${options.until}T00:00:00Z`);
    if (!Number.isFinite(window.end.getTime()) || day(window.end) !== options.until || window.end <= window.start) throw new Error("--until must be a valid date after --since");
  }
  if (options.history && (!options.since || !options.until)) throw new Error("History requires a fixed --since and --until window");
  if ((options.resume || options.restartHistory) && !options.history) throw new Error("--resume/--restart-history require --history");
  const max = wholeNumber(options.max ?? settings.max, DEFAULT_MAX, MAX_MAX, "--max");
  if (options.detail !== undefined) detailFor(root, options, settings);
  const perSource = perSourceSettings(root, settings);
  const details = Object.fromEntries(sources.map((source) => [source, detailFor(root, options, settings, source)]));
  const accountFor = (source) => options.account || perSource[source]?.account || "";
  // A distribution whose default is metadata keeps payments to monthly totals.
  const personNotes = lockDetail(root) !== "metadata";
  if (!plan && options.forget) {
    // A forgotten source is also taken off the remembered list, so the refresh stops reading it.
    const remembered = Array.isArray(settings.sources) ? settings.sources.map(canonicalSource) : [];
    const kept = remembered.filter((name) => !sources.includes(name));
    if (kept.length !== remembered.length) result.settings = writeConfig(root, { ...config, pull: { ...settings, sources: kept } });
  }
  result.window = { from: day(window.start), to: day(window.end), days: window.days };
  // A window longer than MAX_DAYS used to be shortened in silence, so a request
  // for older history looked complete. Say so in the result every time.
  if (window.clamped) {
    result.window.clamped = window.clamped;
    result.warnings = [`WINDOW CLAMPED: asked for ${window.clamped.requested}, but pulls read at most ${MAX_DAYS} days, so only ${day(window.start)} to ${day(window.end)} was read. Anything older was NOT pulled: a pull cannot reach further back than ${MAX_DAYS} days from today, with or without --history. Record the gap in the report; older history needs a separate import.`];
  }
  result.max = max;
  const distinct = [...new Set(Object.values(details))];
  result.detail = distinct.length === 1 ? distinct[0] : details;
  result.details = details;
  for (const source of sources) {
    const entry = { state: "pulled", detail: details[source] };
    result.sources[source] = entry;
    try {
      if (options.forget) {
        const written = await brain.pull({ root, source, forget: true, plan, paceMs: options.paceMs, onNote: options.onNote });
        if (!plan && ["mail", "calendar", "drive"].includes(source)) {
          const cursor = path.join(root, "state", "brain-history", `${source}.json`);
          if (fs.existsSync(cursor)) {
            if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error("Linked history checkpoint is refused");
            fs.renameSync(cursor, `${cursor}.forgotten-${require("node:crypto").randomUUID()}`);
          }
        }
        Object.assign(entry, { state: plan ? "would forget" : "forgotten", removed: written.removed, removedNotes: written.removedNotes, kept: written.orphansKept });
        continue;
      }
      const adapters = options.adapters || defaultAdapters(root, { account: accountFor(source), whatsappDb: options.whatsappDb || settings.whatsappDb });
      if (options.history) {
        const history = require("./history-paging");
        const read = await history.pullHistory({ root, source, plan, resume: options.resume, restart: options.restartHistory,
          pageSize: max, maxPages: options.maxPages, maxItems: options.maxItems,
          binding: { version: 1, source, account: accountFor(source), from: day(window.start), to: day(window.end), detail: details[source], adapter: options.adapterId || "gog-readonly-v1" },
          acquire: () => require("./refresh").acquireRefresh(root),
          readPage: (pageToken, count) => readSource(source, adapters, window, count, details[source], { personNotes, pageToken, history: true }),
          writePage: (items, pageId) => brain.pull({ root, source, items: historyItems(items, pageId), mergeHistory: true, complete: false, paceMs: options.paceMs, onNote: options.onNote }) });
        Object.assign(entry, read);
        if (["failed", "deferred"].includes(read.state)) result.ok = false;
        continue;
      }
      const read = await readSource(source, adapters, window, max, details[source], { personNotes });
      const written = await brain.pull({ root, source, items: read.items, complete: read.complete, plan, paceMs: options.paceMs, onNote: options.onNote });
      Object.assign(entry, {
        state: plan ? "planned" : "pulled", read: read.read, complete: read.complete, notes: written.notes,
        written: written.written, updated: written.updated, unchanged: written.unchanged, protected: written.protected,
        removed: written.removed, removedNotes: written.removedNotes, redirected: written.redirected, rejected: written.rejected,
        ...(plan ? { planned: written.planned } : {}), ...(written.tidy ? { tidy: written.tidy } : {}),
      });
      if (read.leftOut) entry.leftOut = read.leftOut;
      if (!read.complete) entry.warning = `LIMIT REACHED: ${source} had more than ${max} items in this window. Older ones were left out and nothing was tidied. Raise --max or shorten the window.`;
    } catch (error) {
      const skipped = error.code === "NOT_INSTALLED" || error.code === "NOT_CONNECTED" || error.code === "NEEDS_ACCOUNT";
      if (!skipped) result.ok = false;
      Object.assign(entry, { state: skipped ? "skipped" : "failed", code: error.code || "SOURCE_FAILED", reason: clean(error.message, 300) });
    }
  }
  // Remember only what was actually read. A skipped, failed or not-installed
  // source never changes a remembered setting, its own or anyone else's.
  if (options.remember && !plan && !options.forget) {
    const read = sources.filter((source) => result.sources[source].state === "pulled");
    if (read.length) {
      const pull = migratedSettings(root, settings);
      pull.sources = [...new Set([...(Array.isArray(settings.sources) ? settings.sources.map(canonicalSource) : []), ...read])];
      for (const source of read) {
        const own = { ...(pull.perSource[source] || {}) };
        if (options.detail !== undefined) own.detail = details[source];
        if (options.account) own.account = String(options.account);
        if (Object.keys(own).length) pull.perSource[source] = own;
      }
      if (!Object.keys(pull.perSource).length) delete pull.perSource;
      if (options.days !== undefined) { pull.days = wholeNumber(options.days, DEFAULT_DAYS, MAX_DAYS, "--days"); delete pull.since; }
      if (options.since !== undefined) { pull.since = String(options.since); delete pull.days; }
      if (options.max !== undefined) pull.max = max;
      if (options.whatsappDb && read.includes("messages")) pull.whatsappDb = path.resolve(String(options.whatsappDb));
      result.settings = writeConfig(root, { ...config, pull });
    }
    const notRemembered = sources.filter((source) => !read.includes(source));
    if (notRemembered.length) result.notRemembered = notRemembered;
  }
  if (options.verbose !== true) for (const entry of Object.values(result.sources)) countsOnly(entry);
  const done = Object.entries(result.sources).map(([name, entry]) => `${name}: ${entry.state}${entry.notes !== undefined ? ` (${entry.notes} notes)` : ""}${entry.state === "skipped" || entry.state === "failed" ? ` (${entry.reason})` : ""}`);
  const unsaved = result.notRemembered?.length ? ` Not remembered, because they were not read: ${result.notRemembered.join(", ")}.` : "";
  result.message = `${plan ? "Plan only, nothing was written. " : ""}${done.join("; ")}.${unsaved}`;
  return result;
}

module.exports = {
  SOURCES, DEFAULT_DAYS, DEFAULT_MAX, MAX_DAYS, MAX_MAX, CONFIG_FILE,
  DETAILS, pullConnectors, defaultAdapters, privateText, detailFor, perSourceSettings, migratedSettings, readOnlyGog, readOnlyStripe, readOnlyResend, resendHttp, windowFor, safeSnippet, parseAddress,
  mailItems, messageItems, paymentItems, calendarItems, driveItems, sentItems, credentialFile, docExcerpt, resendDate, readConfig, writeConfig, configPath, chosenSources,
};
