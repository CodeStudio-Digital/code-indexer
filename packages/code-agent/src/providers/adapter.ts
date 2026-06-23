/**
 * The streaming chat-adapter contract.
 *
 * The interfaces (`ChatProvider`, `ChatRequest`, `ToolSpec`) now live in
 * `@mcp/provider-sdk` so the provider registry and plugin providers can author
 * against them without depending on code-agent internals. Re-exported here so
 * every existing `@mcp/code-agent/providers/adapter.js` importer keeps working.
 *
 * Each adapter (Anthropic, OpenAI/ZAI/DeepSeek, Gemini) translates the
 * normalized AgentMessage / ToolSpec format to its vendor schema and back.
 */
export type { ChatProvider, ChatRequest, ToolSpec } from '@mcp/provider-sdk';

/**
 * Provider kind. An OPEN string — the store persists `ProviderKind = string`
 * and the registry is keyed by string, so this must accommodate every built-in
 * kind plus any plugin-contributed kind. (Was a closed 8-member union that
 * omitted cloudflare/moonshot/copilot/chatgpt/bedrock/google-oauth.) Kept as a
 * named alias so existing call sites stay readable.
 */
export type CoderProviderName = string;
