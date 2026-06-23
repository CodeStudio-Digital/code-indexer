# provider-zai — reference provider plugin

Z.AI / GLM packaged as a **provider plugin**, demonstrating the `providers`
contribution point (Fase C/E of the provider-SDK extraction). It is the
template for migrating the OAuth providers (Kimi, Copilot, Codex, Gemini).

## How it works

`src/plugin.ts` authors a `ProviderDefinition` with `defineProvider(...)` (from
`@mcp/provider-sdk`) and contributes it via `definePlugin({ providers: [...] })`.
Because a contributed provider **is** a `ProviderDefinition`, once registered it
dispatches identically to a built-in (CLI wizard, admin picker, model discovery,
cost lookup, both factories, the `/test` badge).

Provider adapters run **in-process** on the agent hot path (unlike sandboxed
tool plugins), so the provider-host loader (`@mcp/plugin-host/provider-loader`)
imports the bundle in-process and registers each provider via `upsertProvider`
— but **only for bundles that pass the trust gate**.

## Build (IMPORTANT: externalize the host packages)

The adapter bases (`OpenAIChatProvider`, `ZAIProvider`) and the SDK live in the
**host**. They must be `external` in the bundle so it binds to the host's single
copy at load time (bundling `@mcp/code-agent` would pull in its whole native dep
tree and break). The default CLI `build` does **not** externalize them yet — a
provider-plugin build must pass:

```
esbuild src/plugin.ts --bundle --format=esm --platform=node --outfile=dist/plugin.js \
  --external:@mcp/provider-sdk --external:@mcp/code-agent --external:@mcp/indexer \
  --external:@mcp/services --external:@mcp/shared --external:@mcp/store --external:@mcp/plugin-sdk
```

TODO (Fase E): teach `@mcp/plugin-sdk` CLI `build` to apply these externals
automatically when a plugin contributes `providers` (and confirm it does not
regress existing tool-only plugin bundles, whose worker resolves `@mcp/plugin-sdk`
inline today).

## Enable + trust

The loader only loads providers from **trusted** plugins. Today the gate is an
explicit namespace allowlist:

```
MCP_TRUSTED_PROVIDER_PLUGINS=provider-zai
```

TODO (Fase E hardening): derive trust from a verified Ed25519 signature against a
**pinned first-party key** (stricter than the general market key); `trustTier`
derived from the verifying key, never declared by the manifest.

## Remaining E2E wiring (needs the running app)

1. **Build** with the externals above; `.app.json` is generated (declarative
   provider snapshot, adapter functions stripped to `supports*` flags).
2. **Install** into the IDE (`installPlugin`) and **enable** it.
3. **Workers**: the main process calls `loadPluginProviders` at boot
   (`apps/http-api/server.ts`). The provider-resolving **workers** (coder,
   company) need the same call at their boot for the agent to actually use the
   provider — pending.
4. Verify: kind `zai` resolves to this plugin (overriding the built-in via
   `upsertProvider`); a GLM chat session streams; `::coding`/`::general` routing
   works; the admin tile shows it.

Once verified end-to-end, delete the built-in
`packages/services/src/providers/definitions/zai.ts` (and drop it from
`BUILTIN_DEFINITIONS`) so this plugin is the sole source.
