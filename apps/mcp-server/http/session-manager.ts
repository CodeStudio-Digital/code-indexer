import type { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';

/**
 * Tracks live per-session MCP transports in stateful mode.
 *
 * Each MCP session has its own transport instance (the SDK design: one
 * transport == one session). In stateless mode this manager is unused.
 *
 * Cleanup happens via the transport's `onclose` callback, which the
 * factory wires to `delete(sessionId)`. No background reaper needed.
 */
export class SessionManager {
  private readonly sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();

  get(sessionId: string): WebStandardStreamableHTTPServerTransport | undefined {
    return this.sessions.get(sessionId);
  }

  add(sessionId: string, transport: WebStandardStreamableHTTPServerTransport): void {
    this.sessions.set(sessionId, transport);
  }

  delete(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  size(): number {
    return this.sessions.size;
  }

  closeAll(): Promise<void[]> {
    const all = [...this.sessions.values()];
    this.sessions.clear();
    return Promise.all(all.map((t) => t.close()));
  }
}
