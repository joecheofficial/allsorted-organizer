"use strict";
const { audit } = require("../lib/organizer");
const { resolveTargets } = require("./_helpers");

module.exports.runRecipe = async function runRecipe(input = {}) {
  const { workspace } = resolveTargets(input.args || {});
  try {
    const errors = audit({ workspace });
    if (errors.length) {
      return {
        status: "error",
        reply:
          `Organizer audit found ${errors.length} issue(s) in ${workspace}: ${
            errors.slice(0, 5).join("; ")
          }${errors.length > 5 ? " ..." : ""}`,
        artifacts: [],
        metadata: { workspace, errorCount: errors.length, errors },
      };
    }
    return {
      status: "ok",
      reply:
        `Organizer audit passed for ${workspace}: no dead source paths, no orphan capabilities, fastpath slots within policy.`,
      artifacts: [],
      metadata: { workspace, errorCount: 0 },
    };
  } catch (error) {
    return {
      status: "error",
      reply: `Organizer could not audit ${workspace}: ${error.message}`,
      artifacts: [],
      metadata: { code: "AUDIT_FAILED", workspace },
    };
  }
};
