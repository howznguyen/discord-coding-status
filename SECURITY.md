# Security Policy

## Supported Versions

Security fixes target the latest version on the default branch until the project publishes tagged releases.

## Reporting a Vulnerability

Please do not open a public issue for sensitive reports. If GitHub private vulnerability reporting is enabled, use that channel. Otherwise, contact the maintainer privately and include:

- affected version or commit
- reproduction steps
- what local data could be exposed
- any suggested mitigation

## Privacy Expectations

Discord Coding Status is designed to run locally and send activity to Discord Desktop through local RPC/IPC. When Codex quota is enabled, it also contacts the configured OpenAI authentication and usage endpoints; OAuth tokens must never be included in Discord activity or sent anywhere else. It must not send prompts, full filesystem paths, secrets, customer names, raw command lines, account emails, or identity fields to Discord.

Configuration that increases detail must stay opt-in and must sanitize values before they appear in Rich Presence.
