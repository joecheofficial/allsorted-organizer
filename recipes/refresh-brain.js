"use strict";
const path = require("node:path");
const { refresh, schedule } = require("../lib/refresh");
const { resolveTargets } = require("./_helpers");

// Re-runs the brain's passes from <root>/state/brain-refresh-settings.json:
// folders, opted-in connector sources and registered passes, then the graph.
// args.schedule = "template" | "on" | "off" manages the schedule, which is off
// by default. args.plan shows what would run and writes nothing.
module.exports.runRecipe = async function runRecipe(input = {}) {
  const args = input.args || {};
  const root = path.resolve(args.root || resolveTargets(args).workspace);
  try {
    if (args.schedule) {
      const result = schedule({ root, mode: String(args.schedule) });
      const reply = result.schedule === "on" ? `Brain refresh scheduled daily at ${result.time}.` : result.schedule === "off" ? "Brain refresh schedule turned off." : result.message;
      return { status: "ok", reply, artifacts: [], metadata: result };
    }
    const result = await refresh({ root, plan: args.plan === true });
    const reply = result.message || result.steps.map((step) => `${step.step}${step.name ? ` ${step.name}` : ""}: ${step.state}${step.reason ? ` (${step.reason})` : ""}`).join("\n");
    return { status: result.ok ? (result.degraded ? "degraded" : "ok") : "error", reply: result.degraded ? `${reply}\nDEGRADED: some sources, protected notes or graph outputs are incomplete; inspect the step receipts.` : reply, artifacts: [], metadata: result };
  } catch (error) {
    return { status: "error", reply: `The brain refresh could not run: ${error.message}`, artifacts: [], metadata: { code: "BRAIN_REFRESH_FAILED", root } };
  }
};
