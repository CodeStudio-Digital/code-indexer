# Claude Desktop Electron Notes

Observed locally on Windows from:

- `C:\Program Files\WindowsApps\Claude_1.8089.1.0_x64__pzs8sxrjxfjjc\app`
- Desktop package: `@ant/desktop` version `1.8089.1`
- Electron: `41.6.1`
- Main entry: `.vite/build/index.pre.js` inside `resources/app.asar`
- Main bundled process logic: `.vite/build/index.js`
- Notable bundled dependencies: `@anthropic-ai/sdk ^0.70.0`, `@anthropic-ai/claude-agent-sdk 0.3.142`, `@modelcontextprotocol/sdk 1.28.0`

No local profile stores, cookies, keychains, or user credentials were inspected. The useful signal here is package structure, static endpoint constants, IPC surface, and session architecture.

## ASAR Layout

The Electron package is a normal ASAR archive with a small native unpacked set:

- `.vite/build/index.js` contains the main process, OAuth constants, local agent/session orchestration, MCP bridge wiring, and Claude Code helpers.
- `.vite/build/mainWindow.js`, `buddy.js`, `mainView.js`, and renderer assets expose generated IPC clients.
- `.vite/build/mcp-runtime/directMcpHost.js` is the bundled direct MCP host.
- `app.asar.unpacked/node_modules/@ant/claude-native/claude-native-binding.node` provides native desktop integration.
- `app.asar.unpacked/node_modules/node-pty/...` powers local shell PTY sessions.
- `resources/cowork-svc.exe`, `chrome-native-host.exe`, and `smol-bin.x64.vhdx` support cowork, browser/native host, and VM-style local/remote execution features.

## OAuth Shape

The desktop bundle contains the same Claude Code OAuth constants already mirrored in `packages/services/src/services/oauth/claude-code.ts`:

- Claude.ai authorize: `https://claude.com/cai/oauth/authorize`
- Console authorize: `https://platform.claude.com/oauth/authorize`
- Token: `https://platform.claude.com/v1/oauth/token`
- Manual callback: `https://platform.claude.com/oauth/code/callback`
- API base: `https://api.anthropic.com`
- Managed key endpoint: `/api/oauth/claude_cli/create_api_key`
- Roles endpoint: `/api/oauth/claude_cli/roles`
- Client id: `9d1c250a-e61b-44d9-88ed-5944d1962f5e`
- Claude.ai scopes: `user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload`
- Console/API-key scopes: `org:create_api_key user:profile`

Desktop also has local/staging overrides for internal development, but production only allows approved Claude endpoints. Its internal refresh and exchange calls include `anthropic-version: 2023-06-01` on `/v1/oauth/token`; our helper now does the same.

Important boundary: Claude Desktop can mint some tokens from an already-authenticated Claude web session because it owns the first-party desktop/web integration. For this project, keep using explicit PKCE loopback/manual authorization and stored OAuth rows. Do not depend on Claude Desktop cookies, keychains, or private profile state.

Anthropic's current public docs also say third-party products should use API-key auth unless approved to offer claude.ai login or rate limits. Treat the `claude-code` OAuth provider as a local/personal or approved integration path, not a generic SaaS login path.

References:

- https://platform.claude.com/docs/en/api/overview
- https://platform.claude.com/docs/en/manage-claude/authentication
- https://platform.claude.com/docs/en/api/beta-headers
- https://code.claude.com/docs/en/agent-sdk/overview

## Session And IPC Surface

The renderer talks to main through generated `$eipc_message$...` channels. The largest session-facing surface is `claude.web.LocalAgentModeSessions` with methods such as:

- Lifecycle: `start`, `stop`, `sendMessage`, `getSession`, `getAll`, `updateSession`, `archive`, `delete`, `rewind`, `shareSession`
- Transcript and feedback: `getTranscript`, `getTranscriptFeedback`, `submitTranscriptFeedback`
- Trust and permissions: `addTrustedFolder`, `removeTrustedFolder`, `isFolderTrusted`, `respondToToolPermission`, `onToolPermissionRequest`, `setPermissionMode`, `setChromePermissionMode`
- MCP: `setMcpServers`, `authorizeDirectMcpServer`, `disconnectDirectMcpServer`, `getDirectMcpServerStatuses`, `mcpAuthenticate`, `mcpSubmitOAuthCallbackUrl`, `mcpCallTool`, `mcpListResources`, `mcpReadResource`, `mcpReconnect`
- Bridge state: `resetBridge`, `resetBridgeSession`, `abandonBridgeEnvironment`, `kickBridgePoll`, `sessionsBridgeStatus_*`, `onRemoteSessionStart`
- Interactive auth: `triggerInteractiveAuth`, `revokeInteractiveAuth`, `interactiveAuth_*`
- Skills/context: `listLocalSkills`, `getLocalSkillFiles`, `saveLocalSkill`, `syncSkills`, `setLocalSkillEnabled`

Other useful surfaces:

- `claude.web.ClaudeCode`: `prepare`, `getStatus`, `resolveLocalSettings`, `checkGitAvailable`
- `claude.web.LocalSessions`: shell PTY methods such as `startShellPty`, `writeShellPty`, `resizeShellPty`, `stopShellPty`
- `claude.settings.Custom3pSetup`: third-party provider config, model discovery, inference probe, credential helper, and MCP OAuth setup
- `claude.settings.MCP`: desktop MCP config, status, logs, and server settings
- `claude.web.Cowork*`: artifacts, memory, spaces, scheduled tasks, feedback, and radar cards

The desktop pattern is a main-process session manager with narrow renderer IPC methods, persistent transcript/session state, explicit folder trust, MCP OAuth state, and event stores for status updates. That maps well to our existing SSE/session store approach: keep provider auth refresh centralized, keep tool permission state explicit, persist transcript/task state, and surface MCP auth callbacks as session events rather than ad-hoc UI state.

## Agent Improvements To Carry Forward

- Keep OAuth credentials in `oauth_tokens` as the source of truth; mirror into provider rows only for legacy adapter compatibility.
- Preserve stable runtime identity per provider/session (`device_id`, `session_id`, `account_uuid`) and pass it as metadata where supported.
- Use explicit tool permission preflight and folder trust records before filesystem, shell, browser, or MCP tool execution.
- Treat MCP OAuth as a first-class session capability: pending auth, callback URL/manual paste, refresh, revoke, and reconnect.
- Maintain transcript continuity with fork/rewind semantics rather than only appending raw messages.
- Prefer status/event stores over one-off booleans: desktop exposes `sessionsBridgeStatus_*`, `interactiveAuth_*`, and direct MCP status subscriptions; our equivalent should stay in persisted/session-scoped state.
