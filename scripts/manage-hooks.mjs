#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HOOK_SCRIPT_FILENAME = "herdr-cortex-hook.mjs";
const HOOK_MARKER = "herdr-cortex-hook.mjs";

const MATCHER_EVENTS = ["PreToolUse", "PostToolUse", "PermissionRequest"];
const NON_MATCHER_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "Stop",
  "SessionEnd",
];
const ALL_MANAGED_EVENTS = [...NON_MATCHER_EVENTS, ...MATCHER_EVENTS];

function getCortexDir() {
  if (process.env.CORTEX_CONFIG_DIR) {
    return process.env.CORTEX_CONFIG_DIR;
  }
  return path.join(os.homedir(), ".snowflake", "cortex");
}

function isManagedHookEntry(hookObj) {
  return (
    typeof hookObj?.command === "string" &&
    hookObj.command.includes(HOOK_MARKER)
  );
}

function removeManagedHooksFromConfig(config) {
  if (!config || typeof config !== "object") {
    return { hooks: {} };
  }
  if (!config.hooks || typeof config.hooks !== "object") {
    config.hooks = {};
    return config;
  }

  for (const [eventName, groups] of Object.entries(config.hooks)) {
    if (!Array.isArray(groups)) continue;
    const cleanedGroups = [];
    for (const group of groups) {
      if (!group || typeof group !== "object" || !Array.isArray(group.hooks)) {
        cleanedGroups.push(group);
        continue;
      }
      const remainingHooks = group.hooks.filter((h) => !isManagedHookEntry(h));
      if (remainingHooks.length > 0) {
        cleanedGroups.push({ ...group, hooks: remainingHooks });
      }
    }
    if (cleanedGroups.length > 0) {
      config.hooks[eventName] = cleanedGroups;
    } else {
      delete config.hooks[eventName];
    }
  }
  return config;
}

function readJsonFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return { hooks: {} };
  }
  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) {
    return { hooks: {} };
  }
  return JSON.parse(raw);
}

function writeJsonAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  fs.renameSync(tmpPath, filePath);
}

function notifyHerdr(title, body) {
  if (!process.env.HERDR_PLUGIN_ACTION_ID) return;
  const herdrBin = process.env.HERDR_BIN_PATH || "herdr";
  try {
    spawnSync(herdrBin, ["notification", "show", title, "--body", body], {
      stdio: "ignore",
      timeout: 2000,
    });
  } catch {
    // Ignore notification errors
  }
}

function installHooks() {
  const cortexDir = getCortexDir();
  const hooksDir = path.join(cortexDir, "hooks");
  const targetScriptPath = path.join(hooksDir, HOOK_SCRIPT_FILENAME);
  const sourceScriptPath = path.join(__dirname, "cortex-hook.mjs");
  const hooksJsonPath = path.join(cortexDir, "hooks.json");

  fs.mkdirSync(hooksDir, { recursive: true });
  fs.copyFileSync(sourceScriptPath, targetScriptPath);
  try {
    fs.chmodSync(targetScriptPath, 0o755);
  } catch {
    // Ignore chmod on platforms that do not use POSIX modes
  }

  const commandStr = `node "${targetScriptPath}"`;
  const config = removeManagedHooksFromConfig(readJsonFile(hooksJsonPath));

  for (const eventName of NON_MATCHER_EVENTS) {
    if (!Array.isArray(config.hooks[eventName])) {
      config.hooks[eventName] = [];
    }
    config.hooks[eventName].push({
      hooks: [
        {
          type: "command",
          command: commandStr,
          timeout: 5,
          enabled: true,
        },
      ],
    });
  }

  for (const eventName of MATCHER_EVENTS) {
    if (!Array.isArray(config.hooks[eventName])) {
      config.hooks[eventName] = [];
    }
    config.hooks[eventName].push({
      matcher: ".*",
      hooks: [
        {
          type: "command",
          command: commandStr,
          timeout: 5,
          enabled: true,
        },
      ],
    });
  }

  writeJsonAtomic(hooksJsonPath, config);
  console.log(
    `Installed Herdr Cortex Code hooks (${ALL_MANAGED_EVENTS.join(", ")}) in ${hooksJsonPath}`
  );
  notifyHerdr(
    "Cortex Code hooks installed",
    "New Cortex Code sessions in Herdr will report state and session restore."
  );
}

function uninstallHooks() {
  const cortexDir = getCortexDir();
  const hooksDir = path.join(cortexDir, "hooks");
  const targetScriptPath = path.join(hooksDir, HOOK_SCRIPT_FILENAME);
  const hooksJsonPath = path.join(cortexDir, "hooks.json");

  if (fs.existsSync(hooksJsonPath)) {
    const config = removeManagedHooksFromConfig(readJsonFile(hooksJsonPath));
    writeJsonAtomic(hooksJsonPath, config);
  }
  if (fs.existsSync(targetScriptPath)) {
    fs.unlinkSync(targetScriptPath);
  }
  console.log(`Removed Herdr Cortex Code hooks from ${hooksJsonPath}`);
  notifyHerdr(
    "Cortex Code hooks removed",
    "Removed Herdr lifecycle hooks from ~/.snowflake/cortex/hooks.json."
  );
}

const mode = process.argv[2] || "install";
if (mode === "uninstall") {
  uninstallHooks();
} else {
  installHooks();
}
