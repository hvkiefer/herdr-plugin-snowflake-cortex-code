#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import net from "node:net";
import path from "node:path";

const SOURCE = "snowflake.cortex-code";
const AGENT = "cortex";

const herdrEnv = process.env.HERDR_ENV;
const paneId = process.env.HERDR_PANE_ID;
const socketPath = process.env.HERDR_SOCKET_PATH;
const herdrBin = process.env.HERDR_BIN_PATH || "herdr";

if (herdrEnv !== "1" || !paneId || (!socketPath && !process.env.HERDR_BIN_PATH)) {
  process.exit(0);
}

let seqCounter = Date.now() * 1000 + Number(process.hrtime.bigint() % 1000n);
function nextSeq() {
  seqCounter += 1;
  return seqCounter;
}

function isValidResumeArg(arg) {
  return (
    typeof arg === "string" &&
    arg.length > 0 &&
    arg.length < 512 &&
    !arg.includes("'") &&
    !/[\x00-\x1f\x7f]/.test(arg)
  );
}

// Session identity only (no resume_argv). Herdr rejects resume_argv on a pane
// this reporter does not already hold, so these fields are safe to merge into
// any pane.report_agent call, including the first one that claims the pane.
// resume_argv is attached separately via buildResumeArgv(), only to
// pane.report_agent_session, which runs after the pane is held.
function buildSessionFields(payload) {
  const fields = {};
  const sessionId =
    typeof payload?.session_id === "string" && payload.session_id.trim()
      ? payload.session_id.trim()
      : null;
  const transcriptPath =
    typeof payload?.transcript_path === "string" &&
    (path.posix.isAbsolute(payload.transcript_path) ||
      path.win32.isAbsolute(payload.transcript_path))
      ? payload.transcript_path
      : null;

  if (sessionId) {
    fields.agent_session_id = sessionId;
  }
  if (transcriptPath) {
    fields.agent_session_path = transcriptPath;
  }
  return fields;
}

function buildResumeArgv(sessionId) {
  return typeof sessionId === "string" && isValidResumeArg(sessionId)
    ? ["cortex", "--resume", sessionId]
    : null;
}

function resolveEndpoint(rawPath) {
  if (!rawPath) return null;
  if (process.platform === "win32" && !rawPath.startsWith("\\\\.\\pipe\\")) {
    return `\\\\.\\pipe\\${rawPath}`;
  }
  return rawPath;
}

function parseBufferedResponse(chunks) {
  if (chunks.length === 0) return null;
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return null;
  try {
    return JSON.parse(text.split("\n")[0]);
  } catch {
    return null;
  }
}

function sendSocketRequest(request, timeoutMs = 450) {
  const endpoint = resolveEndpoint(socketPath);
  if (!endpoint) return Promise.resolve({ delivered: false, response: null });

  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const chunks = [];
    const socket = net.createConnection(endpoint);

    const finish = (delivered, response = null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      socket.destroy();
      resolve({ delivered, response });
    };

    socket.on("error", () => finish(false));
    socket.on("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString("utf8");
      if (text.includes("\n")) {
        finish(true, parseBufferedResponse(chunks));
      }
    });
    // The server may close the connection right after writing its reply
    // without a trailing newline. Parse whatever was buffered so far instead
    // of treating this as an unparsed/undelivered response.
    socket.on("end", () => finish(chunks.length > 0, parseBufferedResponse(chunks)));
    timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
  });
}

function sendCliFallback(request) {
  const { method, params } = request;
  if (!params?.pane_id) return;

  const args = ["pane"];
  if (method === "pane.release_agent") {
    args.push(
      "release-agent",
      params.pane_id,
      "--source",
      params.source,
      "--agent",
      params.agent
    );
    if (params.seq) args.push("--seq", String(params.seq));
  } else if (method === "pane.report_agent") {
    args.push(
      "report-agent",
      params.pane_id,
      "--source",
      params.source,
      "--agent",
      params.agent,
      "--state",
      params.state
    );
    if (params.message) args.push("--message", params.message);
    if (params.seq) args.push("--seq", String(params.seq));
    if (params.agent_session_id) {
      args.push("--agent-session-id", params.agent_session_id);
    }
    if (params.agent_session_path) {
      args.push("--agent-session-path", params.agent_session_path);
    }
    if (Array.isArray(params.resume_argv) && params.resume_argv.length > 0) {
      args.push("--", ...params.resume_argv);
    }
  } else if (method === "pane.report_agent_session") {
    args.push(
      "report-agent-session",
      params.pane_id,
      "--source",
      params.source,
      "--agent",
      params.agent
    );
    if (params.seq) args.push("--seq", String(params.seq));
    if (params.agent_session_id) {
      args.push("--agent-session-id", params.agent_session_id);
    }
    if (params.agent_session_path) {
      args.push("--agent-session-path", params.agent_session_path);
    }
    if (params.session_start_source) {
      args.push("--session-start-source", params.session_start_source);
    }
    if (Array.isArray(params.resume_argv) && params.resume_argv.length > 0) {
      args.push("--", ...params.resume_argv);
    }
  } else {
    return;
  }

  try {
    spawnSync(herdrBin, args, {
      stdio: "ignore",
      timeout: 1000,
    });
  } catch {
    // Ignore errors so hooks never block Cortex Code
  }
}

async function dispatchRequest(method, params) {
  const request = {
    id: `${SOURCE}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    method,
    params,
  };
  const { delivered, response } = await sendSocketRequest(request);
  if (delivered && response?.error && params.resume_argv) {
    const { resume_argv: _ignored, ...fallbackParams } = params;
    await sendSocketRequest({
      id: `${SOURCE}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
      method,
      params: fallbackParams,
    });
    return;
  }
  if (!delivered) {
    sendCliFallback(request);
  }
}

function readStdinJson(timeoutMs = 200) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve({});
      return;
    }
    const chunks = [];
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        const text = Buffer.concat(chunks).toString("utf8").trim();
        resolve(text ? JSON.parse(text) : {});
      } catch {
        resolve({});
      }
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
    process.stdin.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
  });
}

async function main() {
  const cliAction = process.argv[2] || "";
  const payload = await readStdinJson();
  const eventName = payload.hook_event_name || cliAction;
  const sessionFields = buildSessionFields(payload);

  if (eventName === "SessionEnd" || cliAction === "release") {
    if (payload.reason === "clear") {
      await dispatchRequest("pane.report_agent", {
        pane_id: paneId,
        source: SOURCE,
        agent: AGENT,
        state: "idle",
        seq: nextSeq(),
        ...sessionFields,
      });
      return;
    }
    await dispatchRequest("pane.release_agent", {
      pane_id: paneId,
      source: SOURCE,
      agent: AGENT,
      seq: nextSeq(),
    });
    return;
  }

  if (eventName === "SessionStart" || cliAction === "session") {
    await dispatchRequest("pane.report_agent", {
      pane_id: paneId,
      source: SOURCE,
      agent: AGENT,
      state: "idle",
      seq: nextSeq(),
      ...sessionFields,
    });
    if (sessionFields.agent_session_id || sessionFields.agent_session_path) {
      const startSource =
        typeof payload.source === "string" && payload.source
          ? payload.source
          : "startup";
      const resumeArgv = buildResumeArgv(sessionFields.agent_session_id);
      await dispatchRequest("pane.report_agent_session", {
        pane_id: paneId,
        source: SOURCE,
        agent: AGENT,
        seq: nextSeq(),
        session_start_source: startSource,
        ...sessionFields,
        ...(resumeArgv ? { resume_argv: resumeArgv } : {}),
      });
    }
    return;
  }

  if (eventName === "PermissionRequest" || cliAction === "blocked") {
    const toolName =
      typeof payload.tool_name === "string" && payload.tool_name
        ? payload.tool_name
        : "";
    const message = toolName
      ? `Permission required: ${toolName}`
      : "Permission required";
    await dispatchRequest("pane.report_agent", {
      pane_id: paneId,
      source: SOURCE,
      agent: AGENT,
      state: "blocked",
      message: message.slice(0, 80),
      seq: nextSeq(),
      ...sessionFields,
    });
    return;
  }

  if (eventName === "PreToolUse") {
    const toolName =
      typeof payload.tool_name === "string" ? payload.tool_name : "";
    if (toolName === "ask_user_question" || toolName === "AskUserQuestion") {
      await dispatchRequest("pane.report_agent", {
        pane_id: paneId,
        source: SOURCE,
        agent: AGENT,
        state: "blocked",
        message: "Waiting for user answer",
        seq: nextSeq(),
        ...sessionFields,
      });
      return;
    }
    await dispatchRequest("pane.report_agent", {
      pane_id: paneId,
      source: SOURCE,
      agent: AGENT,
      state: "working",
      seq: nextSeq(),
      ...sessionFields,
    });
    return;
  }

  if (
    eventName === "UserPromptSubmit" ||
    eventName === "PostToolUse" ||
    cliAction === "working"
  ) {
    await dispatchRequest("pane.report_agent", {
      pane_id: paneId,
      source: SOURCE,
      agent: AGENT,
      state: "working",
      seq: nextSeq(),
      ...sessionFields,
    });
    return;
  }

  if (eventName === "Stop" || cliAction === "idle") {
    await dispatchRequest("pane.report_agent", {
      pane_id: paneId,
      source: SOURCE,
      agent: AGENT,
      state: "idle",
      seq: nextSeq(),
      ...sessionFields,
    });
    return;
  }
}

main()
  .catch(() => {})
  .finally(() => {
    process.exit(0);
  });
