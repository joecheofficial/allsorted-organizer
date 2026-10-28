"use strict";
const path = require("node:path");
const brain = require("../lib/brain");
const { resolveTargets } = require("./_helpers");

// Builds the second brain folder at <workspace>/brain from documents on this
// computer, then counts it. Reads text plus explicitly opted-in local binary documents, never key files.
// The notes are written on this computer and copied nowhere else.
module.exports.runRecipe = async function runRecipe(input = {}) {
  const args = input.args || {};
  const root = path.resolve(args.root || resolveTargets(args).workspace);
  const exclude = (Array.isArray(args.exclude) ? args.exclude : args.exclude ? [args.exclude] : []).map(String);
  const from = (Array.isArray(args.from) ? args.from : args.from ? [args.from] : []).map(String);
  const paceMs = Number.isFinite(Number(args.paceMs)) ? Number(args.paceMs) : undefined;
  try {
    const started = brain.init({ root, viewer: args.viewer === true });
    const built = await brain.build({ root, from, exclude: exclude.length ? exclude : undefined, remember: args.remember === true, extract: args.extract === true ? true : undefined, ocr: args.ocr === true ? true : undefined, paceMs, includeDefault: args.includeDefault !== false, maxFiles: Number.isInteger(args.maxFiles) ? args.maxFiles : undefined, maxNoteBytes: Number.isInteger(args.maxNoteBytes) ? args.maxNoteBytes : undefined });
    const graphed = brain.graph({ root });
    const edges = graphed.atelier.edges === null ? `${graphed.wikilinks} links` : `${graphed.atelier.edges} graph connections and ${graphed.wikilinks} links`;
    const lines = [
      `Your second brain is at ${built.brain}: ${graphed.notes} notes, ${edges}.`,
      `This run wrote ${built.written} new notes and updated ${built.updated}. ${built.unchanged} were already current.`,
    ];
    if (built.protected) lines.push(`${built.protected} notes you edited were left alone. The new versions are beside them as .proposed.md files.`);
    if (!built.folders.length) lines.push("No folders were read. Pass args.from with the folders that hold your documents.");
    const skipped = built.skipped.secrets + built.skipped.symlinks;
    if (skipped) lines.push(`Skipped on purpose: ${built.skipped.secrets} files that look like keys or logins, ${built.skipped.symlinks} links pointing outside the folders you named.`);
    for (const warning of built.warnings) lines.push(warning);
    if (graphed.hint) lines.push(graphed.hint);
    for (const warning of [...started.warnings, ...graphed.warnings]) lines.push(`Note: ${warning}`);
    lines.push("Move that one folder and the whole brain moves with it.");
    return {
      status: built.degraded ? "degraded" : "ok",
      reply: lines.join("\n"),
      artifacts: [{ type: "document", label: "Second brain folder", url: `file://${built.brain}` }],
      metadata: { root, brain: built.brain, notes: graphed.notes, byType: graphed.byType, wikilinks: graphed.wikilinks, brokenWikilinks: graphed.brokenWikilinks, warnings: built.warnings, atelier: graphed.atelier, coverage: built.coverage, extraction: built.extraction, degraded: built.degraded || graphed.degraded, written: built.written, updated: built.updated, unchanged: built.unchanged, protected: built.protected, skipped: built.skipped, network: false },
    };
  } catch (error) {
    return { status: "error", reply: `The second brain could not be built: ${error.message}`, artifacts: [], metadata: { code: "BRAIN_BUILD_FAILED", root } };
  }
};
