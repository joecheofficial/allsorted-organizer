"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const LABEL = "ai.allsorted.organizer-nightly";
const TASK_NAME = "AllSorted Organizer Nightly";
const taskClass = "default_automation";

function run(command, args) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function job({ platform = process.platform, home = os.homedir() } = {}) {
  if (platform === "darwin") {
    const domain = `gui/${process.getuid()}`;
    return { platform, domain, service: `${domain}/${LABEL}`,
      plist: path.join(home, "Library", "LaunchAgents", `${LABEL}.plist`) };
  }
  if (platform === "win32") return { platform };
  throw new Error("Nightly scheduling is supported on Mac and Windows.");
}

function isScheduled(options = {}) {
  const current = job(options);
  try {
    if (current.platform === "darwin") run("launchctl", ["print", current.service]);
    else run("schtasks", ["/Query", "/TN", TASK_NAME]);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") throw new Error("The system scheduling command is not available.");
    return false;
  }
}

function xml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
  })[char]);
}

function windowsCommand(args) {
  return args.map((arg) => {
    if (/["\r\n\0]/.test(arg)) throw new Error("The scheduled command contains an unsupported path character.");
    // Double trailing slashes before a closing quote for Windows argv parsing.
    return `"${arg.replace(/\\+$/, (slashes) => slashes + slashes)}"`;
  }).join(" ");
}

function unload(current) {
  try { run("launchctl", ["bootout", current.service]); }
  catch { run("launchctl", ["unload", current.plist]); }
}

function scheduleNightly(options = {}) {
  const current = job(options);
  if (options.remove) {
    if (isScheduled(options)) {
      if (current.platform === "darwin") unload(current);
      else run("schtasks", ["/Delete", "/TN", TASK_NAME, "/F"]);
      if (isScheduled(options)) throw new Error("The nightly index refresh is still scheduled.");
    }
    if (current.plist) fs.rmSync(current.plist, { force: true });
    return { scheduled: false, taskClass };
  }
  const workspace = path.resolve(options.workspace);
  const dir = path.resolve(options.dir);
  const organizerBin = options.organizerBin || path.join(workspace, "organizer", "bin", "organizer.js");
  if (!fs.statSync(dir).isDirectory()) throw new Error("Choose a directory to index.");
  if (!fs.statSync(organizerBin).isFile()) throw new Error("Install Organizer before scheduling it.");
  const args = [process.execPath, organizerBin, "reconcile-index", "--dir", dir, "--workspace", workspace];
  if (current.platform === "darwin") {
    const data = path.join(workspace, "organizer", "data");
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>
  <key>WorkingDirectory</key><string>${xml(dir)}</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(process.env.PATH || path.dirname(process.execPath))}</string></dict>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>30</integer></dict>
  <key>StandardOutPath</key><string>${xml(path.join(data, "nightly-index.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(data, "nightly-index-error.log"))}</string>
</dict></plist>
`;
    if (isScheduled(options)) unload(current);
    fs.mkdirSync(path.dirname(current.plist), { recursive: true });
    fs.mkdirSync(data, { recursive: true });
    const temporary = `${current.plist}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, plist, { mode: 0o600 });
      fs.renameSync(temporary, current.plist);
    } finally { fs.rmSync(temporary, { force: true }); }
    try { run("launchctl", ["bootstrap", current.domain, current.plist]); }
    catch { run("launchctl", ["load", current.plist]); }
  } else {
    run("schtasks", ["/Create", "/SC", "DAILY", "/ST", "03:30", "/TN", TASK_NAME,
      "/TR", windowsCommand(args), "/F"]);
  }
  if (!isScheduled(options)) throw new Error("The nightly index refresh could not be verified. Run schedule-nightly again.");
  return { scheduled: true, time: "03:30", taskClass };
}

module.exports = { scheduleNightly, isScheduled };
