# Contributing

Thanks for helping improve Discord Coding Status. This project is local-first, so changes should keep privacy, reliability, and simple setup ahead of extra features.

## Development Setup

Requirements:

- Node.js 18 or newer
- Discord Desktop for manual Rich Presence testing

Install dependencies:

```sh
npm install
```

Run validation before opening a pull request:

```sh
npm test
npm run test:stress
npm pack --dry-run
```

## Pull Request Guidelines

- Keep Discord activity text sanitized. Do not send prompt text, full paths, secrets, repository URLs, customer names, or raw command lines.
- Prefer opt-in detail behind environment variables.
- Keep dependencies minimal. This daemon should remain easy to inspect and run locally.
- Update `README.md` and `.env.example` when adding or changing configuration.
- Add or update type checks/tests for behavior that can regress without Discord Desktop running.

## Local Manual Checks

Useful commands:

```sh
node dist/cli.js --help
node dist/cli.js state
DISCORD_CODING_STATUS_STATE_FILE="$(mktemp)" node dist/cli.js hook --tool codex --surface cli --status running --cwd "$PWD"
node dist/cli.js setup-codex-hooks
node dist/cli.js codex-hooks-status
```

Daemon mode uses the built-in Codex and Claude Code Discord Application IDs. Override them only when testing applications you manage:

```sh
DISCORD_CODING_STATUS_CODEX_CLIENT_ID="YOUR_CODEX_APPLICATION_ID" \
DISCORD_CODING_STATUS_CLAUDE_CLIENT_ID="YOUR_CLAUDE_APPLICATION_ID" \
node dist/cli.js daemon
```
