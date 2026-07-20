'use strict';

import type { ToolProvider } from '../core/providers/types';
import type { ActiveTool } from '../core/tools/types';
import { findProviderForTool } from './registry';

export interface ResolvedDiscordApplication {
  key: string;
  label: string;
  clientId: string;
  clientIdEnvironment: string;
  imageKey: string;
}

type EnvironmentReader = (name: string, fallback?: string) => string;

function environmentSegment(application: string): string {
  return application.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toUpperCase();
}

export function resolveDiscordApplications(
  providers: readonly ToolProvider[],
  readEnvironment: EnvironmentReader
): ReadonlyMap<string, ResolvedDiscordApplication> {
  const applications = new Map<string, ResolvedDiscordApplication>();

  for (const provider of providers) {
    const discord = provider.discord;
    if (!discord || applications.has(discord.application)) {
      continue;
    }

    const segment = environmentSegment(discord.application);
    const clientIdEnvironment = discord.clientIdEnvironment
      || `DISCORD_CODING_STATUS_${segment}_CLIENT_ID`;
    const imageKeyEnvironment = discord.imageKeyEnvironment
      || `DISCORD_CODING_STATUS_${segment}_IMAGE_KEY`;
    applications.set(discord.application, {
      key: discord.application,
      label: discord.label,
      clientId: readEnvironment(clientIdEnvironment, discord.defaultClientId || '').trim(),
      clientIdEnvironment,
      imageKey: readEnvironment(imageKeyEnvironment).trim()
    });
  }

  return applications;
}

export function discordApplicationForTool(
  tool: ActiveTool,
  providers: readonly ToolProvider[],
  applications: ReadonlyMap<string, ResolvedDiscordApplication>
): ResolvedDiscordApplication | null {
  const provider = findProviderForTool(tool, providers);
  return provider?.discord ? applications.get(provider.discord.application) || null : null;
}
