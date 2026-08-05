/**
 * Canonical wire-format types shared between the coder runner and every
 * provider adapter.
 *
 * These were historically defined in `@mcp/code-agent/core/messages.ts` and
 * `@mcp/code-agent/core/tool.ts`. They moved here so `@mcp/provider-sdk` can
 * own the streaming-adapter contract (`ChatProvider`/`ChatRequest`) WITHOUT
 * depending back into `@mcp/code-agent` — which would re-create the dependency
 * cycle the SDK exists to break. The old modules now re-export these names, so
 * every existing importer keeps working unchanged.
 */
export {};
//# sourceMappingURL=wire.js.map