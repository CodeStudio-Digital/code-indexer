import type {
  AgentRunAttemptId,
  AgentRunId,
  SessionCommandId,
  SessionId,
} from '@mcp/agent-runtime-contracts';
import type {
  EngineJsonRpcPeerPort,
  JsonRpcPeerHandlers,
} from '../engine-bakeoff/JsonRpcPeer.js';
import type { OssEngineAttemptSpec } from '../engine-bakeoff/types.js';

export class ScriptedJsonRpcPeer implements EngineJsonRpcPeerPort {
  readonly requests: Array<{ method: string; params: unknown }> = [];
  readonly notifications: Array<{ method: string; params: unknown }> = [];
  #handlers?: JsonRpcPeerHandlers;
  #closed = false;

  start(handlers: JsonRpcPeerHandlers): void {
    this.#handlers = handlers;
  }

  async request(method: string, params: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    if (method === 'initialize') return { userAgent: 'codex-test' };
    if (method === 'thread/start') return { thread: { id: 'thread-1' } };
    if (method === 'turn/start') return { turn: { id: 'turn-1', status: 'inProgress' } };
    if (method === 'turn/interrupt') return {};
    if (method === 'thread/delete') return {};
    throw new Error(`Unexpected request ${method}`);
  }

  async notify(method: string, params: unknown): Promise<void> {
    this.notifications.push({ method, params });
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#handlers?.onClosed?.();
  }

  async serverRequest(method: string, params: unknown): Promise<unknown> {
    if (!this.#handlers) throw new Error('Peer has not started');
    return this.#handlers.onRequest(method, params, new AbortController().signal);
  }

  async serverNotification(method: string, params: unknown): Promise<void> {
    if (!this.#handlers) throw new Error('Peer has not started');
    await this.#handlers.onNotification(method, params);
  }

  get closed(): boolean {
    return this.#closed;
  }
}

export function ossAttemptSpec(
  overrides: Partial<OssEngineAttemptSpec> = {},
): OssEngineAttemptSpec {
  return {
    candidate: 'codex_app_server',
    candidateVersion: '0.139.0',
    protocolVersion: 'app-server-v2-experimental-tools',
    protocolSchemaDigest: 'b'.repeat(64),
    authority: {
      sessionId: '11111111-1111-4111-8111-111111111111' as SessionId,
      commandId: '22222222-2222-4222-8222-222222222222' as SessionCommandId,
      agentRunId: '33333333-3333-4333-8333-333333333333' as AgentRunId,
      attemptId: '44444444-4444-4444-8444-444444444444' as AgentRunAttemptId,
      executorOwnerId: 'host:1',
      fencingEpoch: 7n,
      correlationId: '55555555-5555-4555-8555-555555555555',
      rootAgentRunId: '33333333-3333-4333-8333-333333333333' as AgentRunId,
      leaseExpiresAtUnixMs: 1_900_000_000_000n,
      deadlineAtUnixMs: 1_900_000_060_000n,
    },
    cwd: 'D:\\workspace',
    prompt: 'Inspect the repository using the authorized tool.',
    model: 'test-model',
    capabilities: [{
      capabilityId: 'index.search@1',
      canonicalName: 'search_code',
      description: 'Search indexed code',
      descriptorDigest: 'a'.repeat(64),
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
        additionalProperties: false,
      },
      mutates: false,
    }],
    ...overrides,
  };
}

export async function waitForRequest(peer: ScriptedJsonRpcPeer, method: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (peer.requests.some((request) => request.method === method)) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for ${method}`);
}
