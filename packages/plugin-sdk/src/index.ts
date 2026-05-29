/**
 * @mcp/plugin-sdk — authoring SDK + manifest contracts for MCP IDE plugins.
 *
 * Phase 1 surface: the Claude Code/Codex-compatible manifest schemas
 * (plugin.json, .app.json, marketplace.json) shared by the host installer,
 * the CLI validator, and the hosted market worker. Contribution helpers
 * (definePlugin, contributeX) and the CLI arrive in later phases.
 */
export * from './manifest/schema.js';
export type * from './manifest/types.js';
export * from './define.js';
