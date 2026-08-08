import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, normalize } from 'node:path';
import { create } from '@bufbuild/protobuf';
import {
  agentV1Capability,
  agentV1Common,
  type AgentRunId,
} from '@mcp/agent-runtime-contracts';
import type { ValidatedCapabilityPrepare } from '@mcp/agent-runtime-host';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deriveCapabilityDescriptor,
  resolveCapabilitySet,
  skillAsCatalogCapability,
} from '../../core/capability-catalog.js';
import { createMutationFenceAuthority } from '../../core/mutation-fence.js';
import { ToolRegistry } from '../../core/registry.js';
import type { CoderTool, ToolContext, ToolResult } from '../../core/tool.js';
import type { ResolvedSkill } from '../../skills/types.js';
import { buildCapabilityCatalogTool } from '../../tools/capability-catalog-tool.js';
import { fsTools } from '../../tools/fs.js';
import { httpTools } from '../../tools/http.js';
import { shellTools } from '../../tools/shell.js';
import {
  decodeHostToolExecutionPayload,
  createToolRegistryCapabilityGatewayFactory,
  HOST_TOOL_RESULT_SCHEMA_ID,
  ToolRegistryHostCapabilityExecutor,
} from '../tool-registry-host-capability-executor.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('ToolRegistryHostCapabilityExecutor P3 corpus', () => {
  it('executes real native filesystem read and fenced mutation from one attempt snapshot', async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, 'seed.txt'), 'hello from P3', 'utf8');
    const registry = registryWith(
      fsTools.filter((tool) => tool.name === 'read_file' || tool.name === 'create_file'),
    );
    const fixture = executorFor(registry, contextFor(root, { mutationFence: mutationFence(root) }));

    const read = await fixture.execute('read_file', { path: 'seed.txt' });
    expect(read.case).toBe('succeeded');
    if (read.case !== 'succeeded') return;
    expect(read.schemaId).toBe(HOST_TOOL_RESULT_SCHEMA_ID);
    expect(decodeHostToolExecutionPayload(read.encodedResult)).toMatchObject({
      content: expect.stringContaining('hello from P3'),
      isError: false,
    });

    const created = await fixture.execute('create_file', {
      path: 'created.txt',
      content: 'created through HostCapability',
    });
    expect(created.case).toBe('succeeded');
    expect(await readFile(join(root, 'created.txt'), 'utf8'))
      .toBe('created through HostCapability');

    const unfenced = executorFor(registry, contextFor(root));
    const blocked = await unfenced.execute('create_file', {
      path: 'must-not-exist.txt',
      content: 'blocked before dispatch',
    });
    expect(blocked).toMatchObject({
      case: 'failed',
      reasonCode: 'host_mutation_fence_unavailable',
    });
    await expect(readFile(join(root, 'must-not-exist.txt'), 'utf8')).rejects.toThrow();
  });

  it('executes a real supervised shell process through the same fenced Host path', async () => {
    const root = await temporaryRoot();
    const registry = registryWith(
      shellTools.filter((candidate) => candidate.name === 'run_command'),
    );
    const fixture = executorFor(
      registry,
      contextFor(root, { mutationFence: mutationFence(root) }),
    );

    const outcome = await fixture.execute('run_command', {
      command: 'echo host-shell-p3',
      timeout_ms: 5_000,
    });
    expect(outcome.case).toBe('succeeded');
    if (outcome.case !== 'succeeded') return;
    expect(decodeHostToolExecutionPayload(outcome.encodedResult)).toMatchObject({
      content: expect.stringContaining('host-shell-p3'),
      isError: false,
    });
  });

  it('executes a real bounded localhost HTTP call through the network fence', async () => {
    const root = await temporaryRoot();
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ source: 'p3-localhost', ok: true }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('test server address unavailable');
      const registry = registryWith(
        httpTools.filter((candidate) => candidate.name === 'http_request'),
      );
      const fixture = executorFor(
        registry,
        contextFor(root, { mutationFence: mutationFence(root) }),
      );
      const outcome = await fixture.execute('http_request', {
        url: `http://127.0.0.1:${address.port}/health`,
        timeoutMs: 5_000,
        maxBytes: 4_096,
      });
      expect(outcome.case).toBe('succeeded');
      if (outcome.case !== 'succeeded') return;
      expect(decodeHostToolExecutionPayload(outcome.encodedResult)).toMatchObject({
        content: expect.stringContaining('p3-localhost'),
        isError: false,
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (
        error ? reject(error) : resolve()
      )));
    }
  });

  it('crosses the real CapabilityGateway and replays one mutation exactly once', async () => {
    const root = await temporaryRoot();
    const registry = registryWith(fsTools.filter((tool) => tool.name === 'create_file'));
    const resolved = resolveCapabilitySet(registry.list(), setOptions());
    let authorizedDecisions = 0;
    const gatewayFactory = createToolRegistryCapabilityGatewayFactory({
      registry,
      capabilitySet: resolved.set,
      toolContext: contextFor(root, { mutationFence: mutationFence(root) }),
      decisionResolverFactory: (_context, clock) => ({
        async resolve(request) {
          authorizedDecisions += 1;
          const now = clock.now();
          return {
            case: 'accepted' as const,
            value: create(agentV1Capability.SealedExecutionGrantSchema, {
              grantId: `grant/${request.operationId}`,
              decisionId: `decision/${request.operationId}`,
              capabilityId: request.capabilityId,
              capabilityVersion: request.capabilityVersion,
              operationId: request.operationId,
              toolUseId: request.toolUseId,
              effectiveInputSha256: request.inputSha256,
              executionClass: request.executionClass,
              mutates: request.mutates,
              environmentId: 'environment/p3',
              environmentVersion: 1n,
              resourceBindingId: 'binding/p3',
              constraintsSha256: new Uint8Array(32).fill(7),
              policyVersion: 'policy/p3',
              nonce: new Uint8Array(32).fill(8),
              issuedAtUnixMs: now,
              expiresAtUnixMs: request.deadlineAtUnixMs,
            }),
          };
        },
      }),
    });
    const attemptIdentity = identity();
    const runtimeInstanceId = 'runtime/p3-gateway';
    const gatewayContext = Object.freeze({
      identity: attemptIdentity,
      runtimeInstanceId,
      limits: create(agentV1Common.FrameLimitsSchema, {
        maxFrameBytes: 1024n * 1024n,
        maxChunkBytes: 256n * 1024n,
        maxInFlightFrames: 1n,
        maxInFlightBytes: 1024n * 1024n,
        readTimeoutMs: 5_000n,
        writeTimeoutMs: 5_000n,
      }),
      timeoutMs: 5_000,
    });
    const gateway = gatewayFactory(gatewayContext, { now: () => BigInt(Date.now()) });
    const descriptor = deriveCapabilityDescriptor(registry.get('create_file')!).descriptor;
    const encodedJsonInput = new TextEncoder().encode(JSON.stringify({
      path: 'gateway-created.txt',
      content: 'one physical effect',
    }));
    const deadlineAtUnixMs = BigInt(Date.now()) + 5_000n;
    const prepare = create(agentV1Capability.CapabilityPrepareSchema, {
      identity: attemptIdentity,
      runtimeInstanceId,
      operationId: 'operation/gateway-create',
      providerOperationId: 'provider/gateway-create',
      toolUseId: 'tool/gateway-create',
      capabilityId: descriptor.capabilityId,
      capabilityVersion: descriptor.version,
      executionClass: agentV1Capability.CapabilityExecutionClass.HOST_CAPABILITY,
      mutates: descriptor.execution.mutates,
      encodedJsonInput,
      inputSha256: digest(encodedJsonInput),
      capabilitySetSha256: Buffer.from(resolved.set.hash, 'hex'),
      idempotencyKey: 'idempotency/gateway-create',
      deadlineAtUnixMs,
    });
    const foreign = await gateway.prepare(create(agentV1Capability.CapabilityPrepareSchema, {
      ...prepare,
      operationId: 'operation/foreign-snapshot',
      providerOperationId: 'provider/foreign-snapshot',
      toolUseId: 'tool/foreign-snapshot',
      capabilitySetSha256: new Uint8Array(32).fill(9),
    }));
    expect(foreign.decision.case).toBe('rejected');
    expect(authorizedDecisions).toBe(0);
    const update = await gateway.prepare(prepare);
    expect(update.decision.case).toBe('accepted');
    expect(authorizedDecisions).toBe(1);
    if (update.decision.case !== 'accepted') return;
    const execute = create(agentV1Capability.CapabilityExecuteSchema, {
      identity: attemptIdentity,
      runtimeInstanceId,
      operationId: prepare.operationId,
      toolUseId: prepare.toolUseId,
      grantId: update.decision.value.grantId,
      effectiveInputSha256: prepare.inputSha256,
      deadlineAtUnixMs,
    });

    const first = await gateway.execute(execute);
    const replay = await gateway.execute(execute);
    expect(first.outcome.case).toBe('succeeded');
    expect(replay).toBe(first);
    expect(gateway.executedOperationCount).toBe(1);
    expect(await readFile(join(root, 'gateway-created.txt'), 'utf8')).toBe('one physical effect');
  });

  it('routes indexer/MCP and plugin tools through the same immutable executor', async () => {
    const root = await temporaryRoot();
    const invoked: string[] = [];
    const registry = registryWith([
      tool({
        name: 'mcp__search',
        source: 'mcp',
        provenance: { kind: 'mcp_internal', providerId: 'code-indexer' },
        handler: async (args) => {
          invoked.push(`mcp:${String(args.query)}`);
          return { content: JSON.stringify({ hits: ['symbol:A'] }), contentFormat: 'json' };
        },
      }),
      tool({
        name: 'plugin__quality__audit',
        source: 'mcp_external',
        provenance: { kind: 'plugin', providerId: 'quality' },
        mutates: true,
        effectBoundary: 'control',
        handler: async () => {
          invoked.push('plugin:audit');
          return {
            content: 'plugin rejected the candidate',
            isError: true,
            error: {
              code: 'PLUGIN_REJECTED',
              kind: 'refusal',
              retryable: false,
              suggestedAction: 'Fix the reported issue.',
            },
          };
        },
      }),
    ]);
    const fixture = executorFor(registry, contextFor(root, { mutationFence: mutationFence(root) }));

    const mcp = await fixture.execute('mcp__search', { query: 'A' });
    expect(mcp.case).toBe('succeeded');
    const plugin = await fixture.execute('plugin__quality__audit', {});
    expect(plugin.case).toBe('succeeded');
    if (plugin.case === 'succeeded') {
      expect(decodeHostToolExecutionPayload(plugin.encodedResult)).toMatchObject({
        content: 'plugin rejected the candidate',
        isError: true,
        error: { code: 'PLUGIN_REJECTED', retryable: false },
      });
    }
    expect(invoked).toEqual(['mcp:A', 'plugin:audit']);
  });

  it('commits subagent usage and Company lifecycle material before bounding the wire result', async () => {
    const root = await temporaryRoot();
    const committed: Array<{ toolName: string; result: ToolResult }> = [];
    const registry = registryWith([
      tool({
        name: 'spawn_agent',
        source: 'native',
        executionClass: 'execute',
        effectBoundary: 'nested',
        handler: async () => ({
          content: 'subagent complete',
          subUsage: { input_tokens: 120, output_tokens: 30 },
        }),
      }),
      tool({
        name: 'send_to_agent',
        source: 'native',
        executionClass: 'control',
        effectBoundary: 'control',
        handler: async () => ({
          content: 'company message delivered',
          extraUserBlocks: [{ type: 'text', text: 'durable Company receipt' }],
        }),
      }),
    ]);
    const fixture = executorFor(
      registry,
      contextFor(root, { mutationFence: mutationFence(root) }),
      {
        commitResult: ({ toolName, result }) => {
          committed.push({ toolName, result });
        },
      },
    );

    expect((await fixture.execute('spawn_agent', {})).case).toBe('succeeded');
    expect((await fixture.execute('send_to_agent', {})).case).toBe('succeeded');
    expect(committed).toMatchObject([
      {
        toolName: 'spawn_agent',
        result: { subUsage: { input_tokens: 120, output_tokens: 30 } },
      },
      {
        toolName: 'send_to_agent',
        result: { extraUserBlocks: [{ type: 'text', text: 'durable Company receipt' }] },
      },
    ]);
  });

  it('keeps deny and approval-required policy decisions ahead of every handler', async () => {
    const root = await temporaryRoot();
    const handler = vi.fn(async () => ({ content: 'must not run during prepare' }));
    const registry = registryWith([tool({ name: 'policy_probe', source: 'native', handler })]);
    const resolved = resolveCapabilitySet(registry.list(), setOptions());
    const requestFixture = executorFor(registry, contextFor(root));
    const request = requestFixture.request('policy_probe', {});
    const prepare = create(agentV1Capability.CapabilityPrepareSchema, request);
    const gatewayContext = Object.freeze({
      identity: request.identity,
      runtimeInstanceId: request.runtimeInstanceId,
      limits: create(agentV1Common.FrameLimitsSchema, {
        maxFrameBytes: 1024n * 1024n,
        maxChunkBytes: 256n * 1024n,
        maxInFlightFrames: 1n,
        maxInFlightBytes: 1024n * 1024n,
        readTimeoutMs: 5_000n,
        writeTimeoutMs: 5_000n,
      }),
      timeoutMs: 5_000,
    });
    const cases = [
      {
        expected: 'rejected' as const,
        resolve: (now: bigint) => ({
          case: 'rejected' as const,
          value: create(agentV1Capability.CapabilityRejectedSchema, {
            decisionId: 'decision/p3-deny',
            reasonCode: 'policy_denied',
            policyVersion: 'policy/p3',
            decidedAtUnixMs: now,
          }),
        }),
      },
      {
        expected: 'approvalRequired' as const,
        resolve: (now: bigint) => ({
          case: 'approvalRequired' as const,
          value: create(agentV1Capability.CapabilityApprovalRequiredSchema, {
            decisionId: 'decision/p3-approval',
            interactionId: 'interaction/p3-approval',
            reasonCode: 'approval_required',
            policyVersion: 'policy/p3',
            decidedAtUnixMs: now,
          }),
        }),
      },
    ];
    for (const entry of cases) {
      const clock = { now: () => BigInt(Date.now()) };
      const gateway = createToolRegistryCapabilityGatewayFactory({
        registry,
        capabilitySet: resolved.set,
        toolContext: contextFor(root),
        decisionResolverFactory: () => ({
          resolve: async () => entry.resolve(clock.now()),
        }),
      })(gatewayContext, clock);
      expect((await gateway.prepare(prepare)).decision.case).toBe(entry.expected);
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it('activates a catalog-only skill without granting a new tool', async () => {
    const root = await temporaryRoot();
    const skill: ResolvedSkill = {
      id: 'unity-audit',
      name: 'Unity Audit',
      description: 'Inspect a Unity scene safely',
      slashCommand: null,
      promptBody: 'Inspect ${PROJECT_NAME}: ${USER_INPUT}',
      allowedTools: ['read_file'],
      modelOverride: null,
      providerOverride: null,
      contextMode: 'tool',
      pathPatterns: null,
      triggerPaths: null,
      triggerRoles: null,
      triggerTags: null,
      tags: ['unity', 'audit'],
      source: 'imported',
      author: 'unity-pack',
      sortOrder: 0,
    };
    const registry = new ToolRegistry();
    registry.register(fsTools.find((candidate) => candidate.name === 'read_file')!);
    registry.register(buildCapabilityCatalogTool({
      registry,
      skills: [skill],
      skillTemplateContext: {
        PROJECT_NAME: 'P3 Game',
        PROJECT_ROOT: root,
        SESSION_ID: 'p3-session',
        OS: 'win32',
        TIMESTAMP: '2026-08-05T00:00:00.000Z',
      },
    }));
    registry.seal();
    const fixture = executorFor(
      registry,
      contextFor(root, {
        mutationFence: mutationFence(root),
        runner: {
          runId: '33333333-3333-4333-8333-333333333333',
          promoteTool: vi.fn(() => []),
        } as never,
      }),
      {},
      [skillAsCatalogCapability(skill)],
    );

    const found = await fixture.execute('capability_catalog', {
      op: 'search',
      query: 'unity audit',
    });
    expect(found.case).toBe('succeeded');
    if (found.case !== 'succeeded') return;
    const searchPayload = decodeHostToolExecutionPayload(found.encodedResult);
    const skillCapabilityId = JSON.parse(searchPayload.content).items[0].capabilityId as string;
    const activated = await fixture.execute('capability_catalog', {
      op: 'activate',
      capability_ids: [skillCapabilityId, 'cap:plugin:late-tool'],
      input: 'scene decals',
    });
    expect(activated.case).toBe('succeeded');
    if (activated.case !== 'succeeded') return;
    const activation = JSON.parse(
      decodeHostToolExecutionPayload(activated.encodedResult).content,
    );
    expect(activation.activated[0].instruction).toContain('Inspect P3 Game: scene decals');
    expect(activation.rejected[0]).toMatchObject({ reason: 'not_in_attempt_snapshot' });
  });

  it('spills a large result before crossing the Host transport budget', async () => {
    const root = await temporaryRoot();
    const snapshots = new Map<string, string>();
    const registry = registryWith([tool({
      name: 'large_report',
      source: 'native',
      handler: async () => ({ content: 'z'.repeat(20_000) }),
    })]);
    const fixture = executorFor(registry, contextFor(root, {
      toolOutputStore: {
        put(content) {
          const id = `output-${snapshots.size + 1}`;
          snapshots.set(id, content);
          return id;
        },
        get: (id) => snapshots.get(id) ?? null,
        hasOutputs: () => snapshots.size > 0,
      },
    }), { maximumInlineChars: 256, maximumEncodedResultBytes: 4_096 });

    const outcome = await fixture.execute('large_report', {});
    expect(outcome.case).toBe('succeeded');
    if (outcome.case !== 'succeeded') return;
    const payload = decodeHostToolExecutionPayload(outcome.encodedResult);
    expect(payload.transport).toMatchObject({
      truncated: true,
      originalBytes: 20_000,
      outputId: 'output-1',
    });
    expect(payload.content).toContain('output-1');
    expect(snapshots.get('output-1')).toHaveLength(20_000);
    expect(outcome.encodedResult.byteLength).toBeLessThanOrEqual(4_096);
  });

  it('marks a post-dispatch deadline unknown for effects and cancelled for reads', async () => {
    const root = await temporaryRoot();
    const registry = registryWith([
      tool({
        name: 'slow_control_mutation',
        source: 'native',
        mutates: true,
        effectBoundary: 'control',
        handler: async (_args, ctx) => new Promise((resolve) => {
          ctx.signal?.addEventListener('abort', () => resolve({ content: 'late' }), { once: true });
        }),
      }),
      tool({
        name: 'slow_read',
        source: 'native',
        handler: async (_args, ctx) => new Promise((resolve) => {
          ctx.signal?.addEventListener('abort', () => resolve({ content: 'late' }), { once: true });
        }),
      }),
    ]);
    const fixture = executorFor(registry, contextFor(root, { mutationFence: mutationFence(root) }));

    const mutation = await fixture.execute('slow_control_mutation', {}, 30n);
    const read = await fixture.execute('slow_read', {}, 30n);
    expect(mutation).toMatchObject({
      case: 'outcomeUnknown',
      reasonCode: 'host_capability_deadline_after_dispatch',
    });
    expect(read).toMatchObject({
      case: 'cancelled',
      reasonCode: 'host_capability_deadline_after_dispatch',
    });
  });

  it('fails closed for an unsealed registry, foreign set or unsafe JSON', async () => {
    const root = await temporaryRoot();
    const handler = vi.fn(async () => ({ content: 'must not run' }));
    const unsealed = new ToolRegistry();
    unsealed.register(tool({ name: 'probe', source: 'native', handler }));
    const unsealedSet = resolveCapabilitySet(unsealed.list(), setOptions());
    expect(() => new ToolRegistryHostCapabilityExecutor({
      registry: unsealed,
      capabilitySet: unsealedSet.set,
      toolContext: contextFor(root),
    })).toThrow(/sealed ToolRegistry/);

    unsealed.seal();
    const fixture = executorFor(unsealed, contextFor(root));
    const unsafe = await fixture.executeEncoded(
      'probe',
      new TextEncoder().encode('{"__proto__":{"polluted":true}}'),
    );
    expect(unsafe).toMatchObject({
      case: 'failed',
      reasonCode: 'host_capability_input_invalid',
    });
    expect(handler).not.toHaveBeenCalled();

    const foreign = {
      ...fixture.request('probe', {}),
      capabilitySetSha256: new Uint8Array(32).fill(9),
    };
    const rejected = await fixture.executor.execute(foreign, grantFor(foreign));
    expect(rejected).toMatchObject({
      case: 'failed',
      reasonCode: 'host_capability_not_in_attempt_snapshot',
    });
    expect(handler).not.toHaveBeenCalled();
  });
});

function registryWith(tools: readonly CoderTool[]): ToolRegistry {
  const registry = new ToolRegistry();
  registry.registerAll([...tools]);
  registry.seal();
  return registry;
}

function executorFor(
  registry: ToolRegistry,
  context: ToolContext,
  limits: {
    maximumInlineChars?: number;
    maximumEncodedResultBytes?: number;
    commitResult?: (input: {
      toolName: string;
      result: ToolResult;
    }) => void | Promise<void>;
  } = {},
  catalogOnly: readonly CoderTool[] = [],
) {
  const resolved = resolveCapabilitySet([...registry.list(), ...catalogOnly], setOptions());
  const executor = new ToolRegistryHostCapabilityExecutor({
    registry,
    capabilitySet: resolved.set,
    toolContext: context,
    ...limits,
  });
  let sequence = 0;
  const request = (
    toolName: string,
    args: Record<string, unknown>,
    deadlineAfterMs = 5_000n,
  ): ValidatedCapabilityPrepare => {
    sequence += 1;
    const target = registry.get(toolName)!;
    const descriptor = deriveCapabilityDescriptor(target).descriptor;
    const encodedJsonInput = new TextEncoder().encode(JSON.stringify(args));
    return {
      identity: identity(),
      runtimeInstanceId: 'runtime/p3',
      operationId: `operation/${sequence}`,
      providerOperationId: `provider/${sequence}`,
      toolUseId: `tool/${sequence}`,
      capabilityId: descriptor.capabilityId,
      capabilityVersion: descriptor.version,
      executionClass: agentV1Capability.CapabilityExecutionClass.HOST_CAPABILITY,
      mutates: descriptor.execution.mutates,
      encodedJsonInput,
      inputSha256: digest(encodedJsonInput),
      capabilitySetSha256: Buffer.from(resolved.set.hash, 'hex'),
      idempotencyKey: `idempotency/${sequence}`,
      deadlineAtUnixMs: BigInt(Date.now()) + deadlineAfterMs,
    };
  };
  return {
    executor,
    request,
    async execute(toolName: string, args: Record<string, unknown>, deadlineAfterMs?: bigint) {
      const input = request(toolName, args, deadlineAfterMs);
      return executor.execute(input, grantFor(input));
    },
    async executeEncoded(toolName: string, encodedJsonInput: Uint8Array) {
      const input = {
        ...request(toolName, {}),
        encodedJsonInput,
        inputSha256: digest(encodedJsonInput),
      };
      return executor.execute(input, grantFor(input));
    },
  };
}

function setOptions() {
  return {
    agentRunId: '33333333-3333-4333-8333-333333333333' as AgentRunId,
    resolvedAt: '2026-08-05T00:00:00.000Z',
  };
}

function grantFor(request: ValidatedCapabilityPrepare) {
  return create(agentV1Capability.SealedExecutionGrantSchema, {
    grantId: `grant/${request.operationId}`,
    decisionId: `decision/${request.operationId}`,
    capabilityId: request.capabilityId,
    capabilityVersion: request.capabilityVersion,
    operationId: request.operationId,
    toolUseId: request.toolUseId,
    effectiveInputSha256: request.inputSha256,
    executionClass: request.executionClass,
    mutates: request.mutates,
    environmentId: 'environment/p3',
    environmentVersion: 1n,
    resourceBindingId: 'binding/p3',
    constraintsSha256: new Uint8Array(32).fill(7),
    policyVersion: 'policy/p3',
    nonce: new Uint8Array(32).fill(8),
    issuedAtUnixMs: BigInt(Date.now()),
    expiresAtUnixMs: request.deadlineAtUnixMs,
  });
}

function identity() {
  return create(agentV1Common.AttemptIdentitySchema, {
    sessionId: '11111111-1111-4111-8111-111111111111',
    commandId: '22222222-2222-4222-8222-222222222222',
    agentRunId: '33333333-3333-4333-8333-333333333333',
    attemptId: '44444444-4444-4444-8444-444444444444',
    executorOwnerId: 'host/p3',
    fencingEpoch: 1n,
    correlationId: '55555555-5555-4555-8555-555555555555',
    rootAgentRunId: '33333333-3333-4333-8333-333333333333',
    ownerAgentRunId: '33333333-3333-4333-8333-333333333333',
  });
}

function contextFor(root: string, overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    cwd: root,
    projectName: 'p3-fixture',
    ...overrides,
  };
}

function mutationFence(root: string) {
  return createMutationFenceAuthority({
    mode: 'enforce',
    authorizedRoot: root,
    assertLease: () => undefined,
    snapshot: () => ({
      environmentId: 'environment:p3',
      environmentVersion: 1,
      workspaceLeaseId: 'workspace-lease:p3',
      workspaceLeaseVersion: 1,
      workspaceFencingEpoch: 1,
      ownerAgentRunId: '33333333-3333-4333-8333-333333333333',
    }),
  });
}

function tool(options: {
  name: string;
  source: CoderTool['source'];
  provenance?: NonNullable<CoderTool['capabilityProvenance']>;
  mutates?: boolean;
  executionClass?: CoderTool['executionClass'];
  effectBoundary?: CoderTool['effectBoundary'];
  handler: CoderTool['handler'];
}): CoderTool {
  return {
    name: options.name,
    description: `${options.name} P3 fixture`,
    parameters: { type: 'object', properties: {}, additionalProperties: true },
    source: options.source,
    capabilityProvenance: options.provenance,
    mutates: options.mutates ?? false,
    parallelSafe: options.mutates ? false : true,
    executionClass: options.executionClass,
    effectBoundary: options.effectBoundary,
    handler: options.handler,
  };
}

async function temporaryRoot(): Promise<string> {
  const root = normalize(await mkdtemp(join(tmpdir(), 'codestudio-p3-')));
  roots.push(root);
  return root;
}

function digest(value: Uint8Array): Uint8Array {
  return createHash('sha256').update(value).digest();
}
