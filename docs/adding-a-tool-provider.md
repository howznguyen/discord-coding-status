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

The `hooks` list participates in setup eligibility and capability lookup. It is the
*declaration* half of hook support — see step 3 for the installer that implements it.

## 2. Register it

Import the provider in `src/providers/registry.ts` and append it to `builtInProviders`. Registry validation rejects duplicate provider IDs, duplicate presence keys, process providers without presence metadata, and conflicting Discord application definitions.

## 3. Add a hook installer (only if the tool declares `hooks`)

Each hook capability needs one `HookInstaller` supplying `install`, `uninstall`, and
`status`. Put the harness-specific logic in a top-level module — `src/codex-hooks.ts`,
`src/claude-hooks.ts`, and `src/grok-hooks.ts` are the existing examples — then register the
installer in `src/hook-installers.ts`:

```ts
export const openCodeHookInstaller: HookInstaller = {
  capability: 'opencode',
  label: 'OpenCode',
  events: OPENCODE_HOOK_EVENTS,
  install: (scriptPath) => ({ target: HOOKS_FILE, installed, removed }),
  uninstall: () => ({ target: HOOKS_FILE, removed }),
  status: () => ({ target: HOOKS_FILE, targetExists, installed, managedCount, ... }),
  notes: ['Anything the user must do once by hand.']
};
```

Installers deliberately live outside `src/providers/`: the layering test in
`test/architecture.integration.test.js` keeps that directory declarative by forbidding imports
of app modules such as `env` and `state-store`, which every installer needs for its config
paths. `validateHookInstallers` then rejects an installer whose capability no provider
declares, so the two halves cannot drift apart.

Once registered, `hooks setup`, `hooks uninstall`, `hooks status`, and the hook rows in
`setup` and `status` pick the harness up with no CLI changes.

## 4. Configure Discord

When environment names are omitted, the registry derives them from `discord.application`:

```text
DISCORD_CODING_STATUS_OPENCODE_CLIENT_ID
DISCORD_CODING_STATUS_OPENCODE_IMAGE_KEY
```

Providers may supply `defaultClientId`, `clientIdEnvironment`, and `imageKeyEnvironment` when custom names or defaults are required.

## 5. Test the contract

Add provider tests covering:

- matching and rejecting representative process lines;
- installation discovery for supported operating systems;
- surface priority when CLI and desktop are both running;
- hook capability eligibility, and installer round-trip if the tool declares `hooks`;
- Discord application resolution.

`test/provider-registry.integration.test.js` contains a fake OpenCode provider demonstrating that a standard provider can participate in process detection, setup, hook policy, and Discord resolution without modifying core or platform adapters.
