import { AsyncLocalStorage } from 'node:async_hooks';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';

interface DispatchScope {
  assertCurrent(): void;
  active: boolean;
  sent: boolean;
  denied: boolean;
}
const dispatches = new AsyncLocalStorage<DispatchScope>();

/** The transport rejected this call before handing any effect to its transport. */
export class McpDispatchRejected extends Error {}

export async function withMcpWireDispatch<T>(assertCurrent: () => void, operation: () => Promise<T>): Promise<T> {
  const scope: DispatchScope = { assertCurrent, active: true, sent: false, denied: false };
  return dispatches.run(scope, async () => {
    try { return await operation(); }
    catch (error) {
      if (scope.denied && !scope.sent) throw new McpDispatchRejected('External MCP authority expired before transport dispatch.');
      throw error;
    } finally { scope.active = false; }
  });
}

/** Runs after SDK header preparation, synchronously adjacent to the physical send. */
export const fetchWithMcpDispatch: FetchLike = (url, init) => {
  if (init?.method === 'POST' && typeof init.body === 'string') {
    const body: unknown = JSON.parse(init.body);
    const messages = Array.isArray(body) ? body : [body];
    if (messages.some(message => message?.method === 'tools/call')) {
      // A redirect can replay a POST at a second endpoint after the first effect.
      return dispatchMcpEffect(() => globalThis.fetch(url, { ...init, redirect: 'error' }));
    }
  }
  return globalThis.fetch(url, init);
};


/** The callback must admit the physical send synchronously, without an await. */
export function dispatchMcpEffect<T>(send: () => T): T {
  const scope = dispatches.getStore();
  if (!scope) throw new McpDispatchRejected('Missing MCP dispatch scope.');
  if (scope.sent) throw new Error('External MCP effect replay is forbidden.');
  try {
    if (!scope.active) throw new Error('MCP call already settled.');
    scope.assertCurrent();
  } catch (error) { scope.denied = true; throw error; }
  scope.sent = true;
  return send();
}
