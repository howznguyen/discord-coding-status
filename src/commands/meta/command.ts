'use strict';

import { createColors } from 'picocolors';

const pc = createColors(Boolean(process.stdout?.isTTY && !process.env.NO_COLOR));

export interface MetaCommandContext {
  appTitle: string;
  version: string;
  author: string;
  website: string;
  repository: string;
  license: string;
  codexClientId: string;
  claudeClientId: string;
  opencodeClientId: string;
  piClientId: string;
  grokClientId: string;
  configFile: string;
  stateFile: string;
}

export function renderMetaHelp(context: MetaCommandContext): string {
  const accent = (value: string): string => pc.cyan(value);
  const commandText = (value: string): string => pc.bold(value);

  return `${pc.bold(pc.cyan(context.appTitle))} ${context.version} ${pc.dim(`by ${context.author}`)}
${pc.dim('Local Discord Rich Presence for Codex and Claude Code.')}

${pc.bold('Usage:')}
  discord-coding-status setup                 Install startup and start the daemon
  discord-coding-status config                Open display TUI with live preview
  discord-coding-status config --advanced     Edit advanced config prompts
  discord-coding-status config --preview      Print the current two-line preview
  discord-coding-status config --no-restart   Save without restarting the daemon
  discord-coding-status daemon                Start the Discord Rich Presence daemon
  discord-coding-status uninstall             Remove startup entry
  discord-coding-status status                Print startup status
  discord-coding-status setup-codex-hooks     Install Codex lifecycle hooks
  discord-coding-status codex-hooks-status    Print Codex hook install status
  discord-coding-status uninstall-codex-hooks Remove Codex lifecycle hooks
  discord-coding-status setup-claude-hooks    Install Claude lifecycle hooks
  discord-coding-status claude-hooks-status   Print Claude hook install status
  discord-coding-status uninstall-claude-hooks Remove Claude lifecycle hooks
  discord-coding-status setup-grok-hooks      Install Grok lifecycle hooks
  discord-coding-status grok-hooks-status     Print Grok hook install status
  discord-coding-status uninstall-grok-hooks  Remove Grok lifecycle hooks
  discord-coding-status hook --tool codex     Write or update a local session state
  discord-coding-status codex-hook --event stop
  discord-coding-status claude-hook --event Stop
  discord-coding-status grok-hook --event SessionStart
  discord-coding-status clear --session-id ID
  discord-coding-status state
  discord-coding-status quota
  discord-coding-status quota --tool claude
  discord-coding-status quota --tool grok
  discord-coding-status quota --tool opencode
  discord-coding-status --version

${pc.bold('Default Discord Application IDs:')}
  Codex: ${accent(context.codexClientId)}
  Claude Code: ${accent(context.claudeClientId)}
  OpenCode: ${accent(context.opencodeClientId)}
  Pi: ${accent(context.piClientId)}
  Grok: ${accent(context.grokClientId)}

${pc.bold('Config file:')}
  ${accent(context.configFile)}

${pc.bold('State file:')}
  ${accent(context.stateFile)}

${pc.bold('Project:')}
  Author: ${accent(context.author)}
  Website: ${accent(context.website)}
  Repository: ${accent(context.repository)}
  License: ${accent(context.license)}

${pc.bold('Examples:')}
  ${commandText('npx -y discord-coding-status@latest')}
  ${commandText('npx -y discord-coding-status@latest setup')}
  ${commandText('npx -y discord-coding-status@latest config')}
  ${commandText('discord-coding-status config --preview')}
  ${commandText('npx -y discord-coding-status@latest setup --codex-hooks')}
  ${commandText('npx -y discord-coding-status@latest setup --claude-hooks')}
  ${commandText('npx -y discord-coding-status@latest setup --grok-hooks')}
  ${commandText('discord-coding-status status')}
  ${commandText('discord-coding-status daemon')}
  ${commandText('DISCORD_CODING_STATUS_DETAIL_LEVEL=project discord-coding-status state')}
  ${commandText('discord-coding-status quota --source oauth')}
  ${commandText('discord-coding-status quota --tool claude')}
`;
}

export function runMetaCommand(
  command: string,
  context: MetaCommandContext,
  output: (value: string) => void = console.log
): boolean {
  const normalized = command.trim().toLowerCase();

  if (!normalized || ['help', '--help', '-h'].includes(normalized)) {
    output(renderMetaHelp(context));
    return true;
  }

  if (['version', '--version', '-v'].includes(normalized)) {
    output(context.version);
    return true;
  }

  return false;
}
