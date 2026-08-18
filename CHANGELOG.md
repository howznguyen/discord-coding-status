# Changelog

All notable changes to this project will be documented here.

This project follows semantic versioning once tagged releases begin.

## [1.5.3] - 2026-08-18

- Modularized `setup` and `status` CLI presentation with structured table summaries, ANSI-safe column alignment, and header metadata (`Title`, `Version`, `Author`).
- Added live activities and hooks verification dashboard to `status`, with automatic project directory resolution from working directory `cwd`.
- Added parallel OAuth quota detection to `status` across Claude, Codex, Grok, and OpenCode harnesses.
- Added Grok model and reasoning effort resolution from local cache and config files.
- Refactored tool summary resolution to dynamically inspect the provider registry (`toolProviders`), making future harness extensions fully modular.

## [1.5.2] - 2026-08-18

- Fixed presence reporting to only report active coding sessions.

## [1.5.1] - 2026-08-18

- Added managed Grok Code lifecycle hooks: setup installs passive hooks in `~/.grok/hooks/` that report sessions (status, tool activity, project) to the daemon without ever blocking the agent.

## [1.5.0] - 2026-08-18

- Added OpenCode Go usage quota (rolling/weekly/monthly windows) fetched from the official `/v1/usage` endpoint using an env API key.
- Added Grok Code as a built-in provider with process detection, setup discovery, and a dedicated Discord application identity (`1539161996715495445`).

## [1.4.1] - 2026-08-18

- Fixed Windows `setup` failing with "Access is denied." when creating the logon scheduled task: stderr is now surfaced and task creation retries elevated through UAC (or prompts the user to run setup from an Administrator terminal).
- Fixed Windows `setup` running the daemon in a visible console window: the scheduled task now launches through a hidden VBScript wrapper.

## [1.4.0] - 2026-08-18

- Added companion Pi extension and OpenCode plugin that report live Pi and OpenCode sessions (model, activity, and reasoning) through the generic `hook` command.
- Added status emoji to the activity line and a per-session count marker (`⚡ N`) when several sessions of one tool are active at once.
- Added a session-integrations status block to `setup` output and replaced the `chalk` dependency with the lighter `picocolors`.
- Decomposed the ~5000-line CLI entrypoint into focused modules (`env`, `presence-text`, `state-store`, `quota`, `presence`, `daemon`) with no behavior change.
- Added built-in OpenCode and Pi providers with process detection, setup discovery, and separate Discord application identities (`1538957549364322404` for OpenCode, `1538957711503396986` for Pi), including config aliases and editor fields.
- Added ChatGPT desktop (Codex) and Claude Desktop install/process detection on macOS and Windows, while keeping embedded app servers and the Claude Code URL handler separate from CLI detection.
- Split command policy, platform adapters, core detection, and colocated domain contracts out of the CLI entrypoint; standardized source dependencies on TypeScript imports and added automated architecture-boundary coverage.
- Cleaned `dist` before each build so moved modules cannot remain as stale files in published npm packages.
- Added a capability-driven tool provider registry for process/setup/hook/Discord integration, with built-in Codex and Claude providers plus a tested fake OpenCode extension contract.
- Added an approval-gated release-candidate workflow that builds a draft artifact before publishing npm and the GitHub Release together.
- Fixed setup probes so mocked and real platform paths use the target platform's path semantics on every CI host.

## [1.2.0] - 2026-07-20

- Added native Claude Code raw-model detection, managed lifecycle hooks, and subscription OAuth plan/5-hour/weekly quota with strict custom-provider isolation.
- Added `quota --tool claude` plus Claude hook install/status/disable/uninstall commands, preserving the existing Codex CLI contracts.
- Added a full-screen config TUI with live two-line Discord preview and independent visibility controls for activity, project, model/effort, quota, context, and package blocks.
- Added `config --preview` for non-interactive preview output and retained the prompt-based editor under `config --advanced`.
- Added `fun`, `normal`, `technical`, and `minimal` activity styles plus an optional sanitized context-usage display block.
- Made config save/reset restart managed macOS and Windows daemons automatically, with `--no-restart` as an opt-out.

## [1.1.0] - 2026-07-15

- Added active Codex model and reasoning-effort metadata to Discord Rich Presence.
- Preserved the last successful quota value while temporary OAuth or RPC refreshes are unavailable.
- Made bare `npx -y discord-coding-status@latest` invocations show project information and usage instead of starting the daemon.
- Added npm and project badges, official project metadata, and documented the `@latest` update workflow.

## [1.0.1] - 2026-07-15

- Fixed `npx ... setup` installs so the copied daemon runtime owns its production dependencies instead of depending on npm's temporary hoisted layout.
- Added packed-package regression coverage for running the copied runtime after setup.

## [1.0.0] - 2026-07-14

- Rewrote the open-source README with the project cover, quick-start onboarding, complete CLI/configuration guidance, privacy boundaries, and troubleshooting.
- Derived Codex quota labels from API window durations and moved OAuth quota refreshes off the blocking Discord update path.
- Added immediate state-file watching with polling fallback so hook changes reach Discord without a polling delay.
- Added hook-to-Discord integration coverage and concurrent state-writer stress tests.
- Added npm package dry-run verification to CI and refreshed contributor workflow documentation.
- Renamed the project to Discord Coding Status.
- Switched runtime and setup flow to Node/npm with `npx discord-coding-status setup`.
- Added macOS LaunchAgent and Windows Scheduled Task startup installation.
- Added Claude Code and Codex-specific Discord image asset keys.
- Added Codex hook installer commands and native Codex quota support.
- Removed legacy process-manager and external quota-server integrations.
- Initial public-ready release candidate.
