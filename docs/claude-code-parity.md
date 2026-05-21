# Claude Code OAuth Parity

Verified against `@anthropic-ai/claude-code@2.1.126`, downloaded from npm at implementation time.
Additional desktop parity notes for Claude Desktop `1.8089.1` live in
[`claude-desktop-electron-notes.md`](./claude-desktop-electron-notes.md).

- Native package: `@anthropic-ai/claude-code-win32-x64@2.1.126`
- Build time: `2026-04-30T16:01:00Z`
- Git SHA: `e44c1d97bd39dbf2525164f3fd33be6edbf1661e`
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
- Token exchange/refresh also sends `anthropic-version: 2023-06-01` (confirmed in Claude Desktop `1.8089.1`).
- Claude.ai authorize scopes: `user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload`
- Console/API-key authorize scopes: `org:create_api_key user:profile`
- PKCE verifier and OAuth state entropy: `randomBytes(32)` encoded as base64url, matching Claude Code.

## Scope

This server mirrors the Claude Code login, refresh, profile, roles, model discovery, and inference auth path. It also reads official account and metrics opt-out status for the admin UI.

The admin flow now matches Claude Code's two-URL OAuth shape: it opens the loopback URL with a runtime-selected localhost port and also exposes the official manual URL. If Claude's web page rejects or cannot complete the loopback redirect, the manual code can be pasted into the dialog and exchanged with the official manual redirect URI.

The Claude.ai web authorize endpoint rejects `org:create_api_key` in the account-login flow with `invalid_request_error: Invalid request format`; that scope is only used for the console/API-key path.

It intentionally does not POST Claude Code telemetry/metrics. The admin displays official Anthropic account/capacity fields and avoids local Claude Code cost estimates.

## API Request Parity (Inference)

Verified by extracting strings from `claude.exe` (SEA binary, v2.1.126).

### Beta headers sent per request

Claude Code's `Gb()` function builds the beta array per model:

| Beta | Sent when |
|------|-----------|
| `claude-code-20250219` | Non-Haiku models |
| `oauth-2025-04-20` | OAuth bearer auth |
| `interleaved-thinking-2025-05-14` | Modern models (not Haiku 4.5, not Claude 3.x) |
| `context-management-2025-06-27` | Modern first-party models |
| `context-1m-2025-08-07` | Model has `[1m]` tag |
| `prompt-caching-scope-2026-01-05` | Modern first-party models only |

These upstream-default betas are always kept for Claude Code parity. `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` only disables local optional/non-default betas such as `token-efficient-tools-2025-02-19`; it must not strip `interleaved-thinking`, `context-management`, or `prompt-caching-scope` from 1M Opus/Sonnet requests.

Betas NOT in the default request set (used selectively elsewhere):
`redact-thinking-2026-02-12`, `effort-2025-11-24`, `task-budgets-2026-03-13`,
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

- Sends `thinking: {type: "enabled", budget_tokens: N}` for supported models
- Has fallback: if model rejects `type=enabled`, retries with `type=adaptive`
- Token counting uses `budget_tokens: 1024`, `max_tokens: 2048`
