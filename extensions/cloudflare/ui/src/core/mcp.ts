/** The typed `window.mcp` accessor now lives in the SDK UI lib; this thin
 *  re-export keeps existing `../core/mcp.js` imports stable. */
export { mcp } from '@mcp/plugin-sdk/ui';
export type {
  ToolResult,
  StreamChunk,
  StreamHandlers,
  ModelOption,
  AssistantChunk,
  AssistantHandlers,
} from '@mcp/plugin-sdk/ui';
