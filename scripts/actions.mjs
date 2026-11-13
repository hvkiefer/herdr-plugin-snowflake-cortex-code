#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const PLUGIN_ID = process.env.HERDR_PLUGIN_ID || "snowflake.cortex-code";
const herdrBin = process.env.HERDR_BIN_PATH || "herdr";
const cortexCmd = process.env.CORTEX_BIN_PATH || "cortex";

function parseContext() {
  const raw = process.env.HERDR_PLUGIN_CONTEXT_JSON;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function runHerdr(args) {
  const res = spawnSync(herdrBin, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  let json = null;
  if (res.stdout && res.stdout.trim()) {
    try {
      json = JSON.parse(res.stdout);
    } catch {
      json = null;
    }
  }
  return {
    status: res.status ?? 1,
    stdout: res.stdout || "",
    stderr: res.stderr || "",
    json,
  };
}

function resolveTargetCwd(ctx) {
  return ctx.focused_pane_cwd || ctx.workspace_cwd || null;
}

function resolveTargetPane(ctx) {
  return ctx.focused_pane_id || process.env.HERDR_PANE_ID || null;
}

function resolveTargetWorkspace(ctx) {
  return ctx.workspace_id || process.env.HERDR_WORKSPACE_ID || null;
}

function splitAndLaunch(direction, ctx, initialCmd = cortexCmd) {
  const args = ["pane", "split", "--direction", direction, "--focus"];
  const targetPane = resolveTargetPane(ctx);
  if (targetPane) {
    args.push("--pane", targetPane);
  }
  const cwd = resolveTargetCwd(ctx);
  if (cwd) {
    args.push("--cwd", cwd);
  }

  const splitRes = runHerdr(args);
  if (splitRes.status !== 0) {
    process.stderr.write(splitRes.stderr || splitRes.stdout);
    process.exit(splitRes.status);
  }

  const newPaneId = splitRes.json?.result?.pane?.pane_id;
  if (!newPaneId) {
    console.error("Could not determine new pane_id from pane split response.");
    process.exit(1);
  }

  const runRes = runHerdr(["pane", "run", newPaneId, initialCmd]);
  if (runRes.status !== 0) {
    process.stderr.write(runRes.stderr || runRes.stdout);
    process.exit(runRes.status);
  }
  console.log(`Launched '${initialCmd}' in split pane ${newPaneId}`);
}

function newTabAndLaunch(ctx) {
  const args = ["tab", "create", "--label", "cortex", "--focus"];
  const workspaceId = resolveTargetWorkspace(ctx);
  if (workspaceId) {
    args.push("--workspace", workspaceId);
  }
  const cwd = resolveTargetCwd(ctx);
  if (cwd) {
    args.push("--cwd", cwd);
  }

  const tabRes = runHerdr(args);
  if (tabRes.status !== 0) {
    process.stderr.write(tabRes.stderr || tabRes.stdout);
    process.exit(tabRes.status);
  }

  const newPaneId = tabRes.json?.result?.root_pane?.pane_id;
  if (!newPaneId) {
    console.error("Could not determine root_pane.pane_id from tab create response.");
    process.exit(1);
  }

  const runRes = runHerdr(["pane", "run", newPaneId, cortexCmd]);
  if (runRes.status !== 0) {
    process.stderr.write(runRes.stderr || runRes.stdout);
    process.exit(runRes.status);
  }
  console.log(`Launched '${cortexCmd}' in new tab pane ${newPaneId}`);
}

function openPluginOverlay(entrypoint, ctx) {
  const args = [
    "plugin",
    "pane",
    "open",
    "--plugin",
    PLUGIN_ID,
    "--entrypoint",
    entrypoint,
    "--placement",
    "overlay",
    "--focus",
  ];
  const workspaceId = resolveTargetWorkspace(ctx);
  if (workspaceId) {
    args.push("--workspace", workspaceId);
  }
  const targetPane = resolveTargetPane(ctx);
  if (targetPane) {
    args.push("--target-pane", targetPane);
  }
  const cwd = resolveTargetCwd(ctx);
  if (cwd) {
    args.push("--cwd", cwd);
  }

  const res = runHerdr(args);
  if (res.status !== 0) {
    process.stderr.write(res.stderr || res.stdout);
    process.exit(res.status);
  }
  console.log(`Opened plugin overlay '${entrypoint}'`);
}

function findCortexPaneInWorkspace(workspaceId, excludePaneId) {
  const args = ["pane", "list"];
  if (workspaceId) {
    args.push("--workspace", workspaceId);
  }
  const res = runHerdr(args);
  const panes = res.json?.result?.panes;
  if (!Array.isArray(panes)) return null;

  const cortexPanes = panes.filter(
    (p) =>
      p.agent === "cortex" ||
      p.display_agent?.toLowerCase().includes("cortex")
  );
  if (cortexPanes.length === 0) return null;

  const nonSelf = cortexPanes.find((p) => p.pane_id !== excludePaneId);
  return (nonSelf || cortexPanes[0]).pane_id;
}

function sendSelectionToCortex(ctx) {
  const selectedText = ctx.selected_text;
  if (!selectedText || !selectedText.trim()) {
    runHerdr([
      "notification",
      "show",
      "Cortex Code",
      "--body",
      "No selected terminal text to send.",
    ]);
    return;
  }

  const workspaceId = resolveTargetWorkspace(ctx);
  const focusedPaneId = resolveTargetPane(ctx);
  const targetPaneId = findCortexPaneInWorkspace(workspaceId, focusedPaneId);

  if (targetPaneId) {
    const sendRes = runHerdr(["pane", "send-text", targetPaneId, selectedText]);
    if (sendRes.status !== 0) {
      process.stderr.write(sendRes.stderr || sendRes.stdout);
      process.exit(sendRes.status);
    }
    runHerdr(["agent", "focus", targetPaneId]);
    console.log(`Sent selection to Cortex Code pane ${targetPaneId}`);
    return;
  }

  splitAndLaunch("right", ctx, cortexCmd);
}

const action = process.argv[2] || process.env.HERDR_PLUGIN_ACTION_ID || "";
const ctx = parseContext();

switch (action) {
  case "split-right":
    splitAndLaunch("right", ctx);
    break;
  case "split-down":
    splitAndLaunch("down", ctx);
    break;
  case "new-tab":
    newTabAndLaunch(ctx);
    break;
  case "open-overlay":
    openPluginOverlay("cortex", ctx);
    break;
  case "resume":
    openPluginOverlay("resume", ctx);
    break;
  case "send-selection":
    sendSelectionToCortex(ctx);
    break;
  default:
    console.error(`Unknown action: ${action}`);
    process.exit(2);
}
