'use strict';

import type { ToolProvider } from '../core/providers/types';
import type { ActiveTool, ToolDefinition } from '../core/tools/types';
import { claudeProviders, DEFAULT_CLAUDE_CLIENT_ID } from './claude/provider';
import { codexProviders, DEFAULT_CODEX_CLIENT_ID } from './codex/provider';

export { DEFAULT_CLAUDE_CLIENT_ID, DEFAULT_CODEX_CLIENT_ID };

export function validateToolProviders(providers: readonly ToolProvider[]): void {
  const providerIds = new Set<string>();
  const presenceKeys = new Set<string>();
  const discordApplications = new Map<string, string>();

  for (const provider of providers) {
    if (!provider.id.trim()) {
      throw new Error('Tool provider id cannot be empty.');
    }
    if (providerIds.has(provider.id)) {
      throw new Error(`Duplicate tool provider id: ${provider.id}`);
    }
    providerIds.add(provider.id);

    if (provider.process && !provider.presence) {
      throw new Error(`Process-capable provider requires presence metadata: ${provider.id}`);
    }
    if (provider.presence) {
      if (presenceKeys.has(provider.presence.key)) {
        throw new Error(`Duplicate tool presence key: ${provider.presence.key}`);
      }
      if (provider.presence.family && provider.presence.family !== provider.family) {
        throw new Error(`Provider family mismatch: ${provider.id}`);
      }
      presenceKeys.add(provider.presence.key);
    }
    if (provider.discord) {
      const signature = JSON.stringify([
        provider.discord.label,
        provider.discord.defaultClientId || '',
        provider.discord.clientIdEnvironment || '',
        provider.discord.imageKeyEnvironment || ''
      ]);
      const existingSignature = discordApplications.get(provider.discord.application);
      if (existingSignature && existingSignature !== signature) {
        throw new Error(`Conflicting Discord application capability: ${provider.discord.application}`);
      }
      discordApplications.set(provider.discord.application, signature);
    }
  }
}

const builtInProviders: readonly ToolProvider[] = [
  ...claudeProviders,
  ...codexProviders
];
validateToolProviders(builtInProviders);

export const toolProviders: readonly ToolProvider[] = Object.freeze(builtInProviders);

export function findToolProvider(
  providerId: string,
  providers: readonly ToolProvider[] = toolProviders
): ToolProvider | null {
  return providers.find((provider) => provider.id === providerId) || null;
}

export function requireToolProvider(
  providerId: string,
  providers: readonly ToolProvider[] = toolProviders
): ToolProvider {
  const provider = findToolProvider(providerId, providers);
  if (!provider) {
    throw new Error(`Unknown tool provider: ${providerId}`);
  }
  return provider;
}

export function requireToolPresence(
  providerId: string,
  providers: readonly ToolProvider[] = toolProviders
): ToolDefinition {
  const provider = requireToolProvider(providerId, providers);
  if (!provider.presence) {
    throw new Error(`Tool provider has no presence capability: ${providerId}`);
  }
  return provider.presence;
}

export function findProviderForTool(
  tool: ActiveTool,
  providers: readonly ToolProvider[] = toolProviders
): ToolProvider | null {
  if (tool.providerId) {
    const direct = findToolProvider(tool.providerId, providers);
    if (direct) {
      return direct;
    }
  }

  return providers.find((provider) => provider.presence?.key === tool.key)
    || providers.find((provider) => provider.family === tool.family && provider.discord)
    || null;
}

function normalizedAlias(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function findToolProviderByAlias(
  alias: string,
  surface?: string,
  providers: readonly ToolProvider[] = toolProviders
): ToolProvider | null {
  const normalized = normalizedAlias(alias);
  const candidates = providers.filter((provider) => {
    return [provider.id, provider.presence?.key || '', provider.family]
      .some((value) => normalizedAlias(value) === normalized);
  });
  const normalizedSurface = surface?.trim().toLowerCase();
  return candidates.find((provider) => provider.process?.surface === normalizedSurface)
    || candidates.find((provider) => normalizedAlias(provider.id) === normalized)
    || candidates[0]
    || null;
}
