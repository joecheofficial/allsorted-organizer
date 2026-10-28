#!/usr/bin/env node
"use strict";

// Second brain command line. Every command prints one JSON result on stdout;
// build and add also print one progress line per note on stderr.
//
//   brain init   --root <root> [--viewer]
//   brain build  --root <root> [--from <folder> ...] [--pace-ms N] [--max-files N] [--max-note-bytes N] [--exclude <path> ...] [--dry-run|--plan] [--no-default]
//   brain add    --root <root> --json <file|->   [--pace-ms N]
//   brain graph  --root <root>
//   brain open   --root <root> [--install]
//   brain status --root <root>
//   brain pull   --root <root> [--source mail|calendar|messages|payments|drive|sent ...] [--days N | --since YYYY-MM-DD] [--max N] [--plan] [--account <email>] [--whatsapp-db <file>] [--remember] [--forget] [--detail metadata|full] [--verbose]
//   brain refresh --root <root> [--plan] [--schedule template|on|off]
//   brain freshness --root <root> [--months N] [--vault <folder> ...] [--write]

const fs = require("node:fs");
const brain = require("../lib/brain");

const USAGE = "Usage: brain init|build|add|pull|refresh|graph|open|status|freshness|helpers|propose|import [--months <n>] [--vault <folder>] [--write] [--root <install root>] [--from <folder>] [--exclude <path>] [--pace-ms <n>] [--max-files <n>] [--max-note-bytes <n>] [--json <file or ->] [--viewer] [--install] [--no-default] [--quiet] [--source <name>] [--days <n>] [--since <date>] [--max <n>] [--history --since <date> --until <date> --max-pages <n> --max-items <n> --resume|--restart-history] [--plan] [--dry-run (build only)] [--account <email>] [--whatsapp-db <file>] [--remember] [--forget] [--detail metadata|full] [--verbose] [--schedule template|on|off] [--extract] [--ocr]";
const VALUE_FLAGS = new Set(["--months", "--vault", "--until", "--max-pages", "--max-items", "--root", "--from", "--exclude", "--pace-ms", "--max-files", "--max-note-bytes", "--json", "--source", "--days", "--since", "--max", "--account", "--whatsapp-db", "--schedule", "--detail"]);
const BOOLEAN_FLAGS = new Set(["--write", "--history", "--resume", "--restart-history", "--viewer", "--install", "--no-default", "--quiet", "--plan", "--dry-run", "--remember", "--forget", "--scheduled", "--verbose", "--extract", "--ocr"]);

function parse(argv) {
  const options = { from: [], exclude: [], source: [], vault: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (BOOLEAN_FLAGS.has(flag)) { options[flag.slice(2)] = true; continue; }
    if (!VALUE_FLAGS.has(flag)) throw new Error(`Unknown option: ${flag}. ${USAGE}`);
    const value = argv[index + 1];
    if (value === undefined || (value.startsWith("--") && value !== "-")) throw new Error(`${flag} needs a value.`);
    index += 1;
    if (flag === "--from") options.from.push(value);
    else if (flag === "--exclude") options.exclude.push(value);
    else if (flag === "--source") options.source.push(value);
    else if (flag === "--vault") options.vault.push(value);
    else options[flag.slice(2)] = value;
  }
  return options;
}

function wholeNumber(value, name) {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a whole number.`);
  return Number(value);
}

async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h" || command === "help") { console.log(USAGE); return 0; }
  const flags = parse(rest);
  if (flags["dry-run"] && command !== "build") throw new Error("--dry-run is supported only by build.");
  const base = { root: flags.root, paceMs: wholeNumber(flags["pace-ms"], "--pace-ms") };
  const progress = flags.quiet ? undefined : (event) => process.stderr.write(`${event.outcome === "written" ? "+" : "~"} ${event.note}\n`);
  let result;
  if (command === "init") result = brain.init({ ...base, viewer: flags.viewer === true });
  else if (command === "build") result = await brain.build({ ...base, from: flags.from, exclude: flags.exclude.length ? flags.exclude : undefined, remember: flags.remember === true, extract: flags.extract === true ? true : undefined, ocr: flags.ocr === true ? true : undefined, plan: flags.plan === true || flags["dry-run"] === true, includeDefault: flags["no-default"] !== true, maxFiles: wholeNumber(flags["max-files"], "--max-files"), maxNoteBytes: wholeNumber(flags["max-note-bytes"], "--max-note-bytes"), onNote: progress });
  else if (command === "helpers") result = require("../lib/extraction").helpers({ ...base, install: flags.install === true });
  else if (command === "propose") result = require("../lib/propositions").propose(base);
  else if (command === "import") {
    if (!flags.json) throw new Error("import needs --json <file> or --json -.");
    const proposal = JSON.parse(fs.readFileSync(flags.json === "-" ? 0 : flags.json, "utf8"));
    result = await require("../lib/propositions").importProposal({ ...base, proposal, plan: flags.plan === true, onNote: progress });
  }
  else if (command === "add") {
    if (!flags.json) throw new Error("add needs --json <file> (or --json - to read from standard input).");
    const raw = fs.readFileSync(flags.json === "-" ? 0 : flags.json, "utf8");
    let items;
    try { items = JSON.parse(raw); } catch (error) { throw new Error(`The notes file is not valid JSON: ${error.message}`); }
    result = await brain.add({ ...base, items, onNote: progress });
  } else if (command === "pull") {
    result = await require("../lib/connector-pull").pullConnectors({ ...base, sources: flags.source, days: wholeNumber(flags.days, "--days"), since: flags.since, until: flags.until, history: flags.history === true, resume: flags.resume === true, restartHistory: flags["restart-history"] === true, maxPages: wholeNumber(flags["max-pages"], "--max-pages"), maxItems: wholeNumber(flags["max-items"], "--max-items"), max: wholeNumber(flags.max, "--max"), plan: flags.plan === true, account: flags.account, whatsappDb: flags["whatsapp-db"], remember: flags.remember === true, forget: flags.forget === true, detail: flags.detail, verbose: flags.verbose === true,
      // Pulled note names carry people's names and subjects: they are printed only with --verbose.
      onNote: flags.verbose === true ? progress : undefined });
  } else if (command === "refresh") {
    const refresher = require("../lib/refresh");
    result = flags.schedule ? refresher.schedule({ root: flags.root, mode: flags.schedule }) : await refresher.refresh({ ...base, plan: flags.plan === true, scheduled: flags.scheduled === true });
  } else if (command === "graph") result = brain.graph(base);
  else if (command === "open") result = brain.open({ ...base, install: flags.install === true });
  else if (command === "status") result = brain.status(base);
  else if (command === "freshness") result = require("../lib/freshness").freshness({ root: flags.root, months: flags.months === undefined ? undefined : Number(flags.months), vaults: flags.vault, write: flags.write === true });
  else throw new Error(`Unknown command: ${command}. ${USAGE}`);
  console.log(JSON.stringify(result, null, 2));
  for (const warning of Array.isArray(result.warnings) ? result.warnings : []) if (/^WINDOW CLAMPED/.test(warning)) console.error(`brain: ${warning}`);
  return result.ok === false ? 1 : 0;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(`brain: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { main, parse };
