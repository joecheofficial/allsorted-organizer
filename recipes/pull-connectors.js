"use strict";
const path = require("node:path");
const { pullConnectors } = require("../lib/connector-pull");
const { resolveTargets } = require("./_helpers");

// Reads the customer's connected accounts (read-only, opted-in sources only)
// and writes a bounded, privacy-filtered digest into the second brain as
// linked notes. args.plan shows what would be written and writes nothing.
module.exports.runRecipe = async function runRecipe(input = {}) {
  const args = input.args || {};
  const root = path.resolve(args.root || resolveTargets(args).workspace);
  const list = (value) => (Array.isArray(value) ? value : value ? [value] : []).map(String);
  try {
    const result = await pullConnectors({
      root, sources: list(args.sources || args.source), days: args.days, since: args.since, max: args.max,
      plan: args.plan === true, account: args.account, whatsappDb: args.whatsappDb, remember: args.remember === true, forget: args.forget === true, detail: args.detail, verbose: args.verbose === true,
      paceMs: Number.isFinite(Number(args.paceMs)) ? Number(args.paceMs) : undefined,
    });
    const lines = [result.message];
    for (const [name, entry] of Object.entries(result.sources)) {
      if (entry.warning) lines.push(entry.warning);
      if (entry.reason) lines.push(`${name}: ${entry.reason}`);
    }
    if (result.window) lines.push(`Window: ${result.window.from} to ${result.window.to}, at most ${result.max} items per source. Read only: nothing was changed or sent on any account.`);
    return { status: result.ok ? "ok" : "error", reply: lines.join("\n"), artifacts: [], metadata: { ...result, network: Object.keys(result.sources).some((name) => name !== "messages") } };
  } catch (error) {
    return { status: "error", reply: `The connector pull could not run: ${error.message}`, artifacts: [], metadata: { code: "BRAIN_PULL_FAILED", root } };
  }
};
