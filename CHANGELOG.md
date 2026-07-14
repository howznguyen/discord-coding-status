# Changelog

All notable changes to this project will be documented here.

This project follows semantic versioning once tagged releases begin.

## [Unreleased]

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
