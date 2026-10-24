import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { McpServerConfig } from '@mcp/store/mcp-server-store.js';
/** Per-server connection state. */
export type McpConnectionState = 'connected' | 'disconnected' | 'error';


export interface ServerConnection {
  client: Client;
  transport: Transport;
  config: McpServerConfig;
  state: McpConnectionState;
  error?: string;
  /** Kept only for stdio servers, so their child pid stays discoverable. */
  stdio?: StdioClientTransport;
  /**
   * The server returned at least one malformed tool definition. Once detected,
   * bypass the SDK's all-or-nothing list validator for this connection and
   * validate each tool independently.
   */
  lenientToolListing?: boolean;
  /** Avoid repeating the same malformed-tool warning on every health check. */
  reportedInvalidToolSignature?: string;
}
