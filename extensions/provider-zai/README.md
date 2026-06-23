# provider-zai — reference declarative provider plugin

Z.AI / GLM packaged as a **provider plugin**, demonstrating that a third party
can add an LLM provider as **pure DATA** through the plugin SDK — the same way
Podman/Cloudflare plugins declare tools. No adapter code, no flags, no trust
allowlist, no externals.

## How it works

`src/plugin.ts` authors a declarative **`ProviderSpec`** with `defineProviderSpec(...)`
(importing only `@mcp/plugin-sdk` + `@mcp/provider-sdk` — **no** adapter classes,
**no** `@mcp/code-agent`/`@mcp/indexer`/`@mcp/services`) and contributes it via
`definePlugin({ providers: [...] })`.

The CLI `build` writes the spec **verbatim** into `.app.json`. The host validates
it against `thirdPartyProviderSpecSchema` (which rejects host-only capabilities)
and turns it into a runtime definition via `@mcp/provider-engine`'s
`buildProviderDefinition` — the **same engine the built-ins use**. So **no plugin
code runs in-process**; the provider dispatches identically to a built-in (admin
picker, model discovery, cost lookup, both factories, the `/test` badge).

The wire (`openai-compat`) + `wireOpts.modelModes` (`::coding`/`::general` baseURL
routing + the `ZAI_BASE_URL` env override) + `discovery: { from: 'openai-models' }`
(live `/models`) express everything the old hand-written adapter did, as data. A
genuinely new wire/auth would be a first-party change in `@mcp/provider-engine`,
never plugin data — `buildProviderDefinition` throws fail-closed on an unknown wire.

## Build + install + test

```
# 1. Build — emits .app.json (pure data, no worker needed, no externals)
npx tsx packages/plugin-sdk/src/cli/index.ts build extensions/provider-zai

# 2. Install + enable it from the running app:
#    Admin → Plugins → "Instalar de uma pasta" → path: extensions/provider-zai
#    (or via the plugins API with source { source: 'local', path: 'extensions/provider-zai' })
```

That's it — **no env var, no flag**. On install/enable the host registers the
provider live (no restart). In **Admin → Providers** you'll see **"Z.AI / GLM
(plugin)"** (it overrides the built-in `zai`, proving the declarative
registration took effect). Add a provider instance with a `ZAI_API_KEY`, hit
**Refresh models** (live discovery from `z.ai/models`), and chat.

## Notes

- `displayName` is suffixed "(plugin)" only so the override is visible in the UI.
- The coder/company **workers** run the same reconcile at boot, so the agent
  resolves plugin providers too. (For a kind that is *also* a built-in, like
  `zai`, the worker would resolve the built-in regardless — same config.)
- Once a provider is fully migrated to a plugin, delete its built-in spec from
  `@mcp/provider-engine`'s `BUILTIN_SPECS` so the plugin is the sole source.
