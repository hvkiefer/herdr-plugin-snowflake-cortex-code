#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";

function parseContext() {
  const raw = process.env.HERDR_PLUGIN_CONTEXT_JSON;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

const mode = process.argv[2] || "chat";
const ctx = parseContext();
const targetCwd = ctx.focused_pane_cwd || ctx.workspace_cwd;

if (targetCwd && fs.existsSync(targetCwd)) {
  try {
    process.chdir(targetCwd);
  } catch {
    // Keep current working directory if chdir fails
  }
}

const cortexBin = process.env.CORTEX_BIN_PATH || "cortex";
const args = mode === "resume" ? ["--resume"] : [];

const child = spawn(cortexBin, args, {
  stdio: "inherit",
  env: process.env,
  shell: process.platform === "win32",
});

child.on("error", (err) => {
  console.error(`Failed to launch '${cortexBin}': ${err.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
