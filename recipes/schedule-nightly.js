"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { resolveTargets } = require("./_helpers");
const helper = path.join(__dirname, "../lib/schedule.js");
const { scheduleNightly } = require(fs.existsSync(helper) ? helper : "../../install/lib/schedule");

module.exports.runRecipe = async function runRecipe(input = {}) {
  const args = input.args || {};
  try {
    const metadata = scheduleNightly({ ...resolveTargets(args), remove: args.remove === true });
    const reply = metadata.scheduled
      ? "Nightly index refresh: scheduled for 03:30 local time."
      : "Nightly index refresh: removed.";
    return { ok: true, status: "ok", summary: reply, reply, artifacts: [], metadata };
  } catch (error) {
    const reply = `Organizer could not update the nightly schedule: ${error.message}`;
    return { ok: false, status: "error", summary: reply, reply, artifacts: [], metadata: { code: "SCHEDULE_FAILED" } };
  }
};
