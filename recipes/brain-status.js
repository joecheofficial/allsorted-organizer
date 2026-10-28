"use strict";
const path = require("node:path");
const brain = require("../lib/brain");
const { resolveTargets } = require("./_helpers");

// Read-only report on the second brain folder. Writes nothing.
module.exports.runRecipe = async function runRecipe(input = {}) {
  const args = input.args || {};
  const root = path.resolve(args.root || resolveTargets(args).workspace);
  try {
    const report = brain.status({ root });
    const lines = report.exists
      ? [
        `Second brain folder: ${report.brain}.`,
        `Notes: ${report.notes} (${Object.entries(report.byType).map(([name, count]) => `${count} ${name}`).join(", ")}).`,
        `Links between notes: ${report.wikilinks}${report.brokenWikilinks ? `, ${report.brokenWikilinks} pointing at a note that does not exist` : ""}.`,
        ...(report.hint ? [report.hint] : []),
        report.proposed ? `Proposed versions waiting for you to compare: ${report.proposed}.` : "No proposed versions are waiting.",
        report.lastBuild ? `Last build: ${report.lastBuild.at}.` : "Last build: never. Run build-brain.",
        report.lastGraph ? `Last graph: ${report.lastGraph.at}${report.lastGraph.edges === null ? "" : `, ${report.lastGraph.nodes} nodes and ${report.lastGraph.edges} connections`}.` : "Last graph: never.",
        report.atelier === "present" ? "Atelier: installed." : "Atelier: not installed. The notes and links still work; only the Atelier graph file is skipped.",
        report.viewer === "present" ? "Obsidian: installed." : "Obsidian: not installed. It is optional and only a viewer.",
      ]
      : [`There is no second brain at ${report.brain} yet. Run build-brain to create it.`];
    return { status: "ok", reply: lines.join("\n"), artifacts: [], metadata: { ...report, network: false } };
  } catch (error) {
    return { status: "error", reply: `The second brain status could not be read: ${error.message}`, artifacts: [], metadata: { code: "BRAIN_STATUS_FAILED", root } };
  }
};
