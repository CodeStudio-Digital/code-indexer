# Claude Code OAuth Parity

Verified against the extracted `@anthropic-ai/claude-code@2.1.215` runtime in
`D:\Claude-Open` at implementation time.
Additional desktop parity notes for Claude Desktop `1.8089.1` live in
[`claude-desktop-electron-notes.md`](./claude-desktop-electron-notes.md).

- Package version: `2.1.215`
- Build time: `2026-07-19T00:01:04Z`
- Git SHA: `316ce99628e89900bf0b1328fed3b8fec0c0c92d`
- OAuth client id: `9d1c250a-e61b-44d9-88ed-5944d1962f5e`

## Wire Details

- Authorize URL: `https://claude.com/cai/oauth/authorize`
- Console authorize URL: `https://platform.claude.com/oauth/authorize`
- Token URL: `https://platform.claude.com/v1/oauth/token`
- Manual redirect URL: `https://platform.claude.com/oauth/code/callback`
- Profile URL: `https://api.anthropic.com/api/oauth/profile`
- Roles URL: `https://api.anthropic.com/api/oauth/claude_cli/roles`
- Managed key URL: `https://api.anthropic.com/api/oauth/claude_cli/create_api_key`
- Model URL: `https://api.anthropic.com/v1/models?beta=true`
- OAuth beta header: `anthropic-beta: oauth-2025-04-20`
- Anthropic API version header: `anthropic-version: 2023-06-01`
- Token exchange/refresh sends JSON with `Content-Type: application/json`; the
  `anthropic-version` header belongs to Anthropic API requests, not the OAuth token endpoint.
- Claude.ai authorize scopes: `user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload`
- Console/API-key authorize scopes: `org:create_api_key user:profile`
- PKCE verifier and OAuth state entropy: `randomBytes(32)` encoded as base64url, matching Claude Code.

## Scope

This server mirrors the Claude Code login, refresh, profile, roles, model discovery, and inference auth path. It also reads official account and metrics opt-out status for the admin UI.

The admin flow now matches Claude Code's two-URL OAuth shape: it opens the loopback URL with a runtime-selected localhost port and also exposes the official manual URL. If Claude's web page rejects or cannot complete the loopback redirect, the manual code can be pasted into the dialog and exchanged with the official manual redirect URI.

The Claude.ai web authorize endpoint rejects `org:create_api_key` in the account-login flow with `invalid_request_error: Invalid request format`; that scope is only used for the console/API-key path.

It intentionally does not POST Claude Code telemetry/metrics. The admin displays official Anthropic account/capacity fields and avoids local Claude Code cost estimates.

## API Request Parity (Inference)

Verified from the extracted Claude Code 2.1.215 request assembly.

### Beta headers sent per request

Claude Code's request beta resolver builds the beta array per model:

| Beta | Sent when |
|------|-----------|
| `claude-code-20250219` | Non-Haiku models |
| `oauth-2025-04-20` | OAuth bearer auth |
| `interleaved-thinking-2025-05-14` | Modern models (not Haiku 4.5, not Claude 3.x) |
| `context-management-2025-06-27` | First-party models other than Claude 3.x, unless experimental betas are disabled |
| `context-1m-2025-08-07` | Model has `[1m]` tag |
| `prompt-caching-scope-2026-01-05` | First-party requests unless experimental betas are disabled |

`CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` follows the current client: it strips
`context-management` and `prompt-caching-scope`. It does not strip the Claude
Code identity beta, OAuth beta, explicit 1M beta, or interleaved-thinking beta.
The normal MCP desktop configuration leaves this opt-out disabled.

Betas NOT in the default request set (used selectively elsewhere):
`redact-thinking-2026-02-12`, `task-budgets-2026-03-13`,
`fast-mode-2026-02-01`, `afk-mode-2026-01-31`, `advisor-tool-2026-03-01`,
`cache-diagnosis-2026-04-07`, `structured-outputs-2025-12-15`,
`web-search-2025-03-05`, `advanced-tool-use-2025-11-20`,
`tool-search-tool-2025-10-19`.

### Streaming

- Main conversation: `client.beta.messages.create({...params, stream: true})`
- Compaction / verification: `client.beta.messages.create({...params})` (no stream)
- Always uses `beta.messages.create`, never `messages.create`
- Always uses `maxRetries: 0` — custom retry logic wraps all calls

### Request/Response Statistics

Our Anthropic/Claude Code adapter now uses the SDK's `withResponse()` stream hook to capture sanitized per-turn wire metadata:

- request: actual API model, requested/display model alias, `max_tokens`, streaming flag, beta list, thinking type, effort
- response: HTTP status, `ok`, `request-id`, `retry-after`, `x-should-retry`, and `anthropic-ratelimit-*` headers
- storage: `coder_turn_telemetry` migration 093, surfaced through existing telemetry APIs and model aggregation

It does not store authorization headers, cookies, API keys, raw prompts/messages, request bodies, tool inputs, or response text.

### Thinking

- Opus 4.6+, Sonnet 4.6+, and the current Claude 5 families use
  `thinking: {type: "adaptive"}` plus `output_config.effort`.
- Explicit `thinkingBudgetTokens` is only applied to legacy
  `thinking: {type: "enabled"}` requests. Adding `budget_tokens` to adaptive
  thinking is invalid and is intentionally prevented.
- Defaults follow the 2.1.215 registry: Opus 4.7 uses `xhigh`; Fable 5,
  Opus 4.8, Sonnet 5, Opus 4.6, and Sonnet 4.6 use `high`.

### Current model catalog

- Primary models: Fable 5, Opus 4.8, Sonnet 5, and Haiku 4.5.
- Previous models: Opus 4.7, Opus 4.6, and Sonnet 4.6.
- Native 1M context is model metadata, not a duplicated selectable `[1m]`
  entry. The runtime continues to understand legacy aliases for compatibility.
