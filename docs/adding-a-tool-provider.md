# Adding a tool provider

Tool integrations are capability-driven. A provider may expose process detection, setup discovery, hooks, Discord presence, or any subset of those capabilities.

## 1. Create the provider

Create `src/providers/<tool>/provider.ts`:

```ts
import type { ToolProvider } from '../../core/providers/types';

export const openCodeProvider: ToolProvider = {
  id: 'openCode',
  family: 'opencode',
  presence: {
    key: 'openCode',
    details: 'Using OpenCode',
    state: 'OpenCode CLI',
    family: 'opencode'
  },
  process: {
    surface: 'cli',
    priority: 10,
    familyOrder: 30,
    matches: (process) => {
      const line = typeof process === 'string' ? process : process.line;
      return /(?:^|[\\/\s])opencode(?:\.exe)?(?:\s|$)/i.test(line);
    }
  },
  setup: {
    name: 'OpenCode',
    order: 60,
    probe: { kind: 'executable', candidates: ['opencode'] }
  },
  hooks: ['opencode'],
  discord: {
    application: 'opencode',
    label: 'OpenCode',
    defaultClientId: '<Discord application id>'
  }
};
```

Available setup probes:

- `executable`: resolves one of the declared commands with `which` or `where.exe`.
- `desktop`: checks declared macOS app bundles or Windows Start Apps.
- `path`: checks a configuration or installation path.

Omit capabilities the tool does not support. For example, a desktop app without lifecycle hooks should not declare `hooks`.

The `hooks` list participates in setup eligibility and capability lookup. A tool with a new hook protocol still needs its tool-specific hook adapter/installer; the provider prevents that adapter from being hardcoded into process detection, installation discovery, or Discord routing.

## 2. Register it

Import the provider in `src/providers/registry.ts` and append it to `builtInProviders`. Registry validation rejects duplicate provider IDs, duplicate presence keys, process providers without presence metadata, and conflicting Discord application definitions.

## 3. Configure Discord

When environment names are omitted, the registry derives them from `discord.application`:

```text
DISCORD_CODING_STATUS_OPENCODE_CLIENT_ID
DISCORD_CODING_STATUS_OPENCODE_IMAGE_KEY
```

Providers may supply `defaultClientId`, `clientIdEnvironment`, and `imageKeyEnvironment` when custom names or defaults are required.

## 4. Test the contract

Add provider tests covering:

- matching and rejecting representative process lines;
- installation discovery for supported operating systems;
- surface priority when CLI and desktop are both running;
- hook capability eligibility;
- Discord application resolution.

`test/provider-registry.integration.test.js` contains a fake OpenCode provider demonstrating that a standard provider can participate in process detection, setup, hook policy, and Discord resolution without modifying core or platform adapters.
