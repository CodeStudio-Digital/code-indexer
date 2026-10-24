import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { OwnedMcpStdioTransport } from '@mcp/code-agent/tools/mcp-stdio-factory.js';
import { dispatchMcpEffect, McpDispatchRejected } from '@mcp/code-agent/tools/mcp-wire-dispatch.js';
import type { NativeHostDuplexProcess, NativeDuplexResult } from '@mcp/agent-runtime-host';
import { McpStdioLineBuffer } from './McpStdioLineBuffer.js';

/** The native owner contains/reaps the entire local server process tree. */
export class NativeMcpStdioTransport implements OwnedMcpStdioTransport {
  readonly processTreeContained = true as const;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private owner?: NativeHostDuplexProcess;
  private exited?: Promise<NativeDuplexResult>;
  private closing?: Promise<void>;
  private started = false;
  private closed = false;
  private readonly lines = new McpStdioLineBuffer();
  constructor(private readonly launch: () => NativeHostDuplexProcess) {}
  get pid(): number | null { return this.owner?.processId ?? null; }

  async start(): Promise<void> {
    if (this.started || this.closed) throw new Error('MCP stdio transport already started or closed');
    this.started = true;
    this.owner = this.launch();
    this.exited = this.owner.wait();
    void this.exited.catch(error => this.onerror?.(asError(error)));
    void this.pump().catch(error => this.onerror?.(asError(error)));
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.owner || this.closed) throw new McpDispatchRejected('MCP stdio is closed');
    const bytes = Buffer.from(serializeMessage(message));
    if (bytes.length > 1024 * 1024) throw new McpDispatchRejected('MCP stdio request exceeds 1 MiB');
    const write = () => this.owner!.write(bytes);
    // Native enqueue is synchronous; pipe IO and its ACK run off the JS thread.
    const receipt = 'method' in message && message.method === 'tools/call' ? dispatchMcpEffect(write) : write();
    await receipt.wait();
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true; this.owner?.cancel();
    return this.closing = (async () => {
      try {
        const result = await this.exited;
        if (result && (!result.reaped || result.processId !== this.owner?.processId)) {
          throw new Error('MCP stdio process tree cleanup is unproven');
        }
      } finally { this.lines.clear(); this.onclose?.(); }
    })();
  }

  private async pump(): Promise<void> {
    let sliceStart = performance.now();
    try {
      while (!this.closed) {
        const chunk = await this.owner!.read();
        if (!chunk) { this.lines.assertComplete(); break; }
        if (this.closed) break;
        for (const message of this.lines.push(chunk)) {
          this.onmessage?.(message);
          if (performance.now() - sliceStart >= 4) {
            await new Promise<void>(resolve => setImmediate(resolve)); sliceStart = performance.now();
            if (this.closed) break;
          }
        }
      }
    } catch (error) { this.onerror?.(asError(error)); }
    finally { await this.close(); }
  }
}
function asError(error: unknown): Error { return error instanceof Error ? error : new Error(String(error)); }
