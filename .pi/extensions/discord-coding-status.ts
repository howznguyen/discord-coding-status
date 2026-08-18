// Discord Coding Status presence for Pi.
//
// Reports the active Pi session to the local discord-coding-status daemon
// through its generic `hook` command, so Discord Rich Presence shows the Pi
// session with model and reasoning effort. Process detection in the daemon
// remains the fallback when this extension is not loaded.
//
// Install: copy to ~/.pi/agent/extensions/ (global) or .pi/extensions/ (project),
// then run /reload in Pi. The daemon must be running with built-in Pi support.
import { spawn, type ChildProcess } from "node:child_process";
import { statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const TOOL = "pi";
const SURFACE = "cli";
const HOOK_TIMEOUT_MS = 10_000;
const THROTTLE_MS = 1_500;

type ReportArgs = {
  sessionId?: string;
  cwd?: string;
  status?: string;
  model?: string;
  effort?: string;
  activity?: string;
};

function installedCliCandidates(): string[] {
  const home = os.homedir();
  if (process.platform === "darwin") {
    return [
      path.join(home, "Library", "Application Support", "discord-coding-status", "app", "dist", "cli.js")
    ];
  }
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    return [
      path.join(localAppData, "discord-coding-status", "app", "dist", "cli.js")
    ];
  }
  const xdg = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
  return [
    path.join(xdg, "discord-coding-status", "app", "dist", "cli.js")
  ];
}

function resolveHookInvocation(): { command: string; args: string[] } | null {
  const override = process.env.DISCORD_CODING_STATUS_BIN?.trim();
  if (override) {
    return { command: override, args: [] };
  }

  const candidate = installedCliCandidates().find((script) => {
    try {
      return statSync(script).isFile();
    } catch {
      return false;
    }
  });
  if (candidate) {
    return { command: process.execPath, args: [candidate] };
  }

  return { command: "discord-coding-status", args: [] };
}

let lastSignature = "";
let lastReportedAt = 0;

function report(session: ReportArgs): void {
  const invocation = resolveHookInvocation();
  if (!invocation) {
    return;
  }

  const status = session.status || "active";
  const args = [
    ...invocation.args,
    "hook",
    "--tool", TOOL,
    "--surface", SURFACE,
    "--status", status,
    "--session-id", session.sessionId || `pi:cli:${session.cwd || process.cwd()}`,
    "--cwd", session.cwd || process.cwd()
  ];
  if (session.model) {
    args.push("--model", session.model);
  }
  if (session.effort) {
    args.push("--effort", session.effort);
  }
  if (session.activity) {
    args.push("--activity", session.activity);
  }

  const signature = args.join("\u0000");
  const now = Date.now();
  if (signature === lastSignature && now - lastReportedAt < THROTTLE_MS) {
    return;
  }
  lastSignature = signature;
  lastReportedAt = now;

  const child: ChildProcess = spawn(invocation.command, args, {
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true
  });
  const timeout = setTimeout(() => {
    child.kill();
  }, HOOK_TIMEOUT_MS);
  child.on("error", () => {
    // Daemon or CLI unavailable; process detection in the daemon still works.
    clearTimeout(timeout);
  });
  child.on("close", () => clearTimeout(timeout));
}

function sessionId(ctx: ExtensionContext): string | undefined {
  return ctx.sessionManager.getSessionId() || undefined;
}

function modelOf(ctx: ExtensionContext): string | undefined {
  return ctx.model?.id || undefined;
}

function effortOf(ctx: ExtensionContext): string | undefined {
  return ctx.thinkingLevel || undefined;
}

function toolActivity(toolName: string): string {
  return toolName ? `Running ${toolName}` : "Running a tool";
}

export default function discordCodingStatusExtension(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    report({
      sessionId: sessionId(ctx),
      cwd: ctx.cwd,
      status: "running",
      model: modelOf(ctx),
      effort: effortOf(ctx)
    });
  });

  pi.on("session_shutdown", (_event, ctx) => {
    report({
      sessionId: sessionId(ctx),
      cwd: ctx.cwd,
      status: "stopped"
    });
  });

  pi.on("before_agent_start", (_event, ctx) => {
    report({
      sessionId: sessionId(ctx),
      cwd: ctx.cwd,
      status: "running",
      model: modelOf(ctx),
      effort: effortOf(ctx)
    });
  });

  pi.on("agent_end", (_event, ctx) => {
    report({
      sessionId: sessionId(ctx),
      cwd: ctx.cwd,
      status: "waiting_input",
      model: modelOf(ctx),
      effort: effortOf(ctx)
    });
  });

  pi.on("tool_call", (event, ctx) => {
    report({
      sessionId: sessionId(ctx),
      cwd: ctx.cwd,
      status: "running",
      model: modelOf(ctx),
      effort: effortOf(ctx),
      activity: toolActivity(event.toolName)
    });
  });

  pi.on("model_select", (event, ctx) => {
    report({
      sessionId: sessionId(ctx),
      cwd: ctx.cwd,
      status: "running",
      model: event.model?.id || modelOf(ctx),
      effort: effortOf(ctx)
    });
  });

  pi.on("thinking_level_select", (event, ctx) => {
    report({
      sessionId: sessionId(ctx),
      cwd: ctx.cwd,
      status: "running",
      model: modelOf(ctx),
      effort: event.level
    });
  });
}