// Discord Coding Status presence for OpenCode.
//
// Reports the active OpenCode session to the local discord-coding-status daemon
// through its generic `hook` command, so Discord Rich Presence shows the session
// with activity and model context. Process detection in the daemon remains the
// fallback when this plugin is not loaded.
//
// Install: place in ~/.config/opencode/plugins/ (global) or .opencode/plugins/
// (project), then restart OpenCode. The daemon must be running with built-in
// OpenCode support.
import { spawn } from "node:child_process"
import { statSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const TOOL = "opencode"
const SURFACE = "cli"
const HOOK_TIMEOUT_MS = 10_000
const THROTTLE_MS = 1_500

function installedCliCandidates() {
  const home = os.homedir()
  if (process.platform === "darwin") {
    return [
      path.join(home, "Library", "Application Support", "discord-coding-status", "app", "dist", "cli.js"),
    ]
  }
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local")
    return [path.join(localAppData, "discord-coding-status", "app", "dist", "cli.js")]
  }
  const xdg = process.env.XDG_CONFIG_HOME || path.join(home, ".config")
  return [path.join(xdg, "discord-coding-status", "app", "dist", "cli.js")]
}

function resolveHookInvocation() {
  const override = process.env.DISCORD_CODING_STATUS_BIN?.trim()
  if (override) {
    return { command: override, args: [] }
  }
  const script = installedCliCandidates().find((file) => {
    try {
      return statSync(file).isFile()
    } catch {
      return false
    }
  })
  if (!script) {
    return { command: "discord-coding-status", args: [] }
  }
  const runtime = resolveJavascriptRuntime()
  if (!runtime) {
    // No JS runtime on PATH; fall through to the bare command.
    return { command: "discord-coding-status", args: [] }
  }
  return { command: runtime, args: [script] }
}

function resolveJavascriptRuntime() {
  const self = process.execPath || ""
  const selfName = path.basename(self).toLowerCase()
  if (/^(node|bun)(\.[a-z0-9]+)?$/.test(selfName)) {
    return self
  }
  return findOnPath(["bun", "node", "deno"])
}

function findOnPath(names) {
  const dirs = String(process.env.PATH || "").split(path.delimiter).filter(Boolean)
  for (const name of names) {
    for (const dir of dirs) {
      const candidate = path.join(dir, name)
      try {
        if (statSync(candidate).isFile()) {
          return candidate
        }
      } catch {
        // Try the next candidate.
      }
    }
  }
  return undefined
}

let lastSignature = ""
let lastReportedAt = 0

function report(client, session) {
  const invocation = resolveHookInvocation()
  if (!invocation) {
    log(client, "warn", "no hook CLI available; process detection only")
    return
  }
  const args = [
    ...invocation.args,
    "hook",
    "--tool", TOOL,
    "--surface", SURFACE,
    "--status", session.status || "active",
    "--session-id", session.sessionId || `opencode:cli:${session.cwd || process.cwd()}`,
    "--cwd", session.cwd || process.cwd(),
  ]
  if (session.model) {
    args.push("--model", session.model)
  }
  if (session.activity) {
    args.push("--activity", session.activity)
  }

  const signature = args.join("\u0000")
  const now = Date.now()
  if (signature === lastSignature && now - lastReportedAt < THROTTLE_MS) {
    return
  }
  lastSignature = signature
  lastReportedAt = now

  log(client, "debug", "reporting presence", { status: session.status, sessionId: session.sessionId || null, model: session.model || null })

  const child = spawn(invocation.command, args, {
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  })
  const timeout = setTimeout(() => child.kill(), HOOK_TIMEOUT_MS)
  child.on("error", (error) => {
    clearTimeout(timeout)
    log(client, "error", `hook spawn failed: ${error?.message || String(error)}`)
  })
  child.on("close", (code) => {
    clearTimeout(timeout)
    if (code !== 0) {
      log(client, "warn", `hook exited with code ${code} (interpreter=${invocation.command})`)
    }
  })
}

function log(client, level, message, extra) {
  try {
    if (!client?.app?.log) return
    void client.app.log({ body: { service: "discord-coding-status", level, message, extra: extra || {} } })
  } catch {
    // Logging must never break the plugin.
  }
  if (level === "error" || level === "warn") {
    try {
      console.error(`[discord-coding-status] ${level}: ${message}`)
    } catch {
      // Best effort.
    }
  }
  if (process.env.DISCORD_CODING_STATUS_OPENCODE_DEBUG === "1") {
    try {
      console.log(`[discord-coding-status] ${level}: ${message} ${JSON.stringify(extra || {})}`)
    } catch {
      // Best effort.
    }
  }
}

function sessionIdFromEvent(event) {
  const props = event.properties || {}
  const info = props.info || {}
  return props.sessionID || props.sessionId || info.id || info.sessionID || undefined
}

export const DiscordCodingStatus = async ({ client, directory }) => {
  const sessionModels = new Map()

  function rememberModel(sessionID, model) {
    if (!sessionID || !model) return
    if (model.providerID || model.modelID) {
      sessionModels.set(sessionID, model.providerID && model.modelID ? `${model.providerID}/${model.modelID}` : (model.modelID || model.providerID))
    } else {
      sessionModels.set(sessionID, String(model))
    }
  }

  async function currentModel(sessionID) {
    const known = sessionModels.get(sessionID)
    if (known) {
      return known
    }
    try {
      const result = await client.config.get({})
      const configModel = result?.data?.model || undefined
      if (configModel) {
        return String(configModel)
      }
    } catch (error) {
      log(client, "warn", `config.get failed: ${error?.message || String(error)}`)
    }
    return undefined
  }

  async function reportWithModel(client, session) {
    report(client, session)
    const model = await currentModel(session.sessionId)
    if (model && model !== session.model) {
      report(client, { ...session, model })
    }
  }

  await log(client, "info", "Discord Coding Status plugin initialized")

  return {
    event: async ({ event }) => {
      try {
        if (!event) return
        log(client, "debug", `event received: ${event.type}`)
        if (event.type === "session.created") {
          await reportWithModel(client, {
            sessionId: sessionIdFromEvent(event),
            cwd: directory,
            status: "running",
          })
        } else if (event.type === "session.idle") {
          await reportWithModel(client, {
            sessionId: event.properties?.sessionID,
            cwd: directory,
            status: "waiting_input",
          })
        } else if (event.type === "session.error") {
          await reportWithModel(client, {
            sessionId: event.properties?.sessionID,
            cwd: directory,
            status: "error",
          })
        }
      } catch (error) {
        log(client, "error", `event handler failed: ${error?.message || String(error)}`)
      }
    },
    "tool.execute.before": async ({ tool, sessionID }) => {
      try {
        log(client, "debug", `tool.execute.before: ${tool}`)
        await reportWithModel(client, {
          sessionId: sessionID,
          cwd: directory,
          status: "running",
          activity: `Running ${tool}`,
        })
      } catch (error) {
        log(client, "error", `tool hook failed: ${error?.message || String(error)}`)
      }
    },
    "chat.message": async ({ sessionID, model }) => {
      try {
        if (!model) return
        rememberModel(sessionID, model)
        log(client, "debug", "captured session model", { sessionID, model: model.providerID ? `${model.providerID}/${model.modelID}` : model.modelID })
        await reportWithModel(client, {
          sessionId: sessionID,
          cwd: directory,
          status: "running",
        })
      } catch (error) {
        log(client, "error", `chat.message hook failed: ${error?.message || String(error)}`)
      }
    },
  }
}