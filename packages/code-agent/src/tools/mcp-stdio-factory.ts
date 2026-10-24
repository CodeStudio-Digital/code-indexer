import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpServerConfig } from '@mcp/store/mcp-server-store.js';

/** Supplied only by the product Host after verifying its native runtime package. */
export interface OwnedMcpStdioTransport extends Transport {
  readonly processTreeContained: true;
  readonly pid: number | null;
}
export type McpStdioTransportFactory = (config: McpServerConfig) => Promise<OwnedMcpStdioTransport>;
