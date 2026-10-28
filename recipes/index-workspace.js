"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { index } = require("../lib/organizer");
const { resolveTargets } = require("./_helpers");

module.exports.runRecipe = async function runRecipe(input = {}) {
  const { dir, workspace } = resolveTargets(input.args || {});
  if (!fs.existsSync(dir)) {
    return {
      status: "error",
      reply:
        `Organizer cannot index ${dir} because it does not exist. Pass args.dir to point at a real directory.`,
      artifacts: [],
      metadata: { code: "DIR_NOT_FOUND", dir, workspace },
    };
  }
  try {
    const result = index({ dir, workspace });
    const indexPath = path.join(workspace, "capabilities-index.json");
    return {
      status: "ok",
      reply:
        `Indexed ${dir}: ${result.capabilities} capabilities written to ${indexPath}.`,
      artifacts: [
        {
          type: "document",
          label: "Capability index",
          url: `file://${indexPath}`,
        },
      ],
      metadata: {
        dir,
        workspace,
        capabilities: result.capabilities,
        taskClassConfig: result.taskClassConfig,
      },
    };
  } catch (error) {
    return {
      status: "error",
      reply: `Organizer could not index ${dir}: ${error.message}`,
      artifacts: [],
      metadata: { code: "INDEX_FAILED", dir, workspace },
    };
  }
};
