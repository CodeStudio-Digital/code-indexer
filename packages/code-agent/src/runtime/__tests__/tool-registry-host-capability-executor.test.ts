import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, normalize } from 'node:path';
import { create } from '@bufbuild/protobuf';
import {
  agentV1Capability,
  agentV1Common,
  agentV1Runtime,
  type AgentRunId,
} from '@mcp/agent-runtime-contracts';
import type { ValidatedCapabilityPrepare } from '@mcp/agent-runtime-host';
import { encodeNativeToolUserMessage } from '@mcp/agent-runtime-host';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deriveCapabilityDescriptor,
  resolveCapabilitySet,
  skillAsCatalogCapability,
} from '../../core/capability-catalog.js';
import { createMutationFenceAuthority } from '../../core/mutation-fence.js';
import { HostEffectScope } from '../host-effect-scope.js';
import { ToolRegistry } from '../../core/registry.js';
import type { CoderTool, ToolContext, ToolResult } from '../../core/tool.js';
import { unknownToolOutcome } from '../../core/tool.js';
import { ToolCallLedger } from '../../core/tool-call-ledger.js';
import type { ResolvedSkill } from '../../skills/types.js';
import { buildCapabilityCatalogTool } from '../../tools/capability-catalog-tool.js';
import { createHostCapabilitySnapshot, type HostCapabilitySnapshot } from '../host-capability-snapshot.js';
import { fsTools } from '../../tools/fs.js';
import { httpTools } from '../../tools/http.js';
import { webFetch, webSearch } from '../../tools/web.js';
import { shellTools } from '../../tools/shell.js';
import {
  decodeHostToolExecutionPayload,
  createToolRegistryCapabilityGatewayFactory,
  HOST_TOOL_RESULT_SCHEMA_ID,
  ToolRegistryHostCapabilityExecutor,
  type ToolRegistryHostCapabilityExecutorOptions,
} from '../tool-registry-host-capability-executor.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('ToolRegistryHostCapabilityExecutor P3 corpus', () => {
  it.each(['confirmed', 'missing-receipt', 'foreign-session', 'foreign-owner', 'nested-unknown'] as const)(
    'settles self-review cancellation only with its owned durable receipt: %s', async proof => {
      const root = await temporaryRoot(), controller = new AbortController(), ledger = new ToolCallLedger();
      let entered!: () => void, invocationId = '', confirmed = false;
      const ready = new Promise<void>(resolve => { entered = resolve; });
      const registry = registryWith([tool({ name: 'self_review', source: 'native', mutates: false,
        parallelSafe: false, effectBoundary: 'control', handler: async (_args, context) => {
          invocationId = context.currentToolUseId!; entered();
          await new Promise<void>(resolve => context.signal!.addEventListener('abort', () => resolve(), { once: true }));
          await new Promise(resolve => setTimeout(resolve, 10));
          confirmed = proof !== 'missing-receipt';
          if (proof === 'nested-unknown') ledger.markOutcomeUnknown('reference');
          context.signal!.throwIfAborted(); return { content: 'unreachable' };
        } })]);
      const fixture = executorFor(registry, contextFor(root, { signal: controller.signal, toolCallLedger: ledger,
        runtimeGeneration: 'rust_v1', sessionId: 'session' as never, controlPlaneParentAgentRunId: 'owned-parent', mutationFence: mutationFence(root),
        ports: { sessionReview: { runtimeGeneration: 'rust_v1', sessionId: proof === 'foreign-session' ? 'other' : 'session',
          agentRunId: proof === 'foreign-owner' ? 'other-parent' : 'owned-parent', workspaceRoot: root,
          assertOwner: () => {}, beginInvocation: () => () => {}, isCancellationSettled: id => confirmed && id === invocationId } } }),
      { bindNested: () => ({ turn: 1 }) });
      const pending = fixture.execute('self_review', {}); await ready; controller.abort(new Error('cancel'));
      expect(await pending).toMatchObject({ case: proof === 'confirmed' ? 'cancelled' : 'outcomeUnknown' });
    },
  );
  it.each(['confirmed', 'unknown', 'foreign-owner'] as const)(
    'requires owned child settlement before classifying documentation cancellation: %s', async proof => {
      const root = await temporaryRoot(), controller = new AbortController();
      let entered!: () => void, invocationId = '', confirmed = false;
      const ready = new Promise<void>(resolve => { entered = resolve; });
      const registry = registryWith([tool({ name: 'docs_deep_research', source: 'native', mutates: false,
        parallelSafe: false, effectBoundary: 'nested', handler: async (_args, context) => {
          invocationId = context.currentToolUseId!; entered();
          await new Promise<void>(resolve => context.signal!.addEventListener('abort', () => resolve(), { once: true }));
          await new Promise(resolve => setTimeout(resolve, 10));
          confirmed = proof === 'confirmed';
          context.signal!.throwIfAborted();
          return { content: 'unreachable' };
        } })]);
      const fixture = executorFor(registry, contextFor(root, { signal: controller.signal,
        runtimeGeneration: 'rust_v1', controlPlaneParentAgentRunId: 'owned-parent', mutationFence: mutationFence(root),
        ports: { docsResearch: { runtimeGeneration: 'rust_v1', ownerAgentRunId: proof === 'foreign-owner' ? 'other-parent' : 'owned-parent',
          isReadOnlyInvocation: id => confirmed && id === invocationId, research: async () => ({ content: 'unused' }) } } }));
      const pending = fixture.execute('docs_deep_research', {}); await ready; controller.abort(new Error('cancel'));
      expect(await pending).toMatchObject({ case: proof === 'confirmed' ? 'cancelled' : 'outcomeUnknown' });
    },
  );
  it('authorizes nested self-review lookups without requiring code_exec in the snapshot', async () => {
    const root = await temporaryRoot(); const read = vi.fn(async () => ({ content: 'references' }));
    const registry = registryWith([
      tool({ name: 'review_reference', source: 'native', handler: read }),
      tool({ name: 'self_review', source: 'native', mutates: false, parallelSafe: false, effectBoundary: 'control',
        handler: async (_args, ctx) => {
          expect(ctx.nestedCapabilityDispatch).toBeDefined();
          return (await ctx.nestedCapabilityDispatch!.invoke!('review_reference', {}, ctx, () => {}))!;
        } }),
    ]);
    const resolved = resolveCapabilitySet(registry.list(), setOptions());
    const context = contextFor(root, { mutationFence: mutationFence(root) });
    const effects = new HostEffectScope(); const validateGrant = vi.fn(async () => {});
    const authorized: string[] = [];
    const factory = createToolRegistryCapabilityGatewayFactory({ registry, capabilitySet: resolved.set,
      toolContext: context, effects, validateGrant, decisionResolverFactory: () => ({
        resolve: async request => { authorized.push(request.capabilityId); return { case: 'accepted', value: grantFor(request) }; },
      }) });
    const request = executorFor(registry, context).request('self_review', {});
    const gateway = factory({ identity: request.identity, runtimeInstanceId: request.runtimeInstanceId,
      limits: create(agentV1Common.FrameLimitsSchema, { maxFrameBytes: 1024n * 1024n, maxChunkBytes: 256n * 1024n,
        maxInFlightFrames: 1n, maxInFlightBytes: 1024n * 1024n, readTimeoutMs: 5000n, writeTimeoutMs: 5000n }), timeoutMs: 5000,
    }, { now: () => BigInt(Date.now()) });
    const prepared = await gateway.prepare(create(agentV1Capability.CapabilityPrepareSchema, request));
    expect(prepared.decision.case).toBe('accepted'); if (prepared.decision.case !== 'accepted') return;
    const result = await gateway.execute(create(agentV1Capability.CapabilityExecuteSchema, { identity: request.identity,
      runtimeInstanceId: request.runtimeInstanceId, operationId: request.operationId, toolUseId: request.toolUseId,
      grantId: prepared.decision.value.grantId, effectiveInputSha256: request.inputSha256, deadlineAtUnixMs: request.deadlineAtUnixMs }));
    expect(result.outcome.case).toBe('succeeded');
    if (result.outcome.case === 'succeeded') expect(decodeHostToolExecutionPayload(result.outcome.value.encodedResult)).toMatchObject({ content: 'references', isError: false });
    expect(read).toHaveBeenCalledOnce();
    expect(authorized).toEqual(['cap:native:self_review', 'cap:native:review_reference']);
    expect(validateGrant).toHaveBeenCalledTimes(2);
  });
  it('preserves bounded structured results and keeps successful effects successful when optional metadata is excessive', async () => {
    const root = await temporaryRoot(); let structuredData: unknown = { kind: 'review', findings: [], reference: 'owned-journal' };
    const handler = vi.fn(async () => ({ content: 'confirmed result', structuredData }));
    const registry = registryWith([tool({ name: 'structured_write', source: 'native', mutates: true, effectBoundary: 'control', handler })]);
    const fixture = executorFor(registry, contextFor(root, { mutationFence: mutationFence(root) }));
    const first = await fixture.execute('structured_write', {});
    expect(first.case).toBe('succeeded');
    if (first.case === 'succeeded') expect(decodeHostToolExecutionPayload(first.encodedResult)).toMatchObject({ structuredData });
    structuredData = { huge: 'x'.repeat(70_000) };
    const second = await fixture.execute('structured_write', {});
    expect(second.case).toBe('succeeded');
    if (second.case === 'succeeded') expect(decodeHostToolExecutionPayload(second.encodedResult)).toMatchObject({
      content: 'confirmed result', isError: false, transport: { structuredDataOmitted: 'too_large' } });
    expect(handler).toHaveBeenCalledTimes(2);
  });
  it('does not acknowledge a control mutation when its result accounting fails', async () => {
    const root = await temporaryRoot();
    const registry = registryWith([tool({ name: 'create_goal', source: 'native', mutates: false,
      executionClass: 'control', effectBoundary: 'control', parallelSafe: false,
      handler: async () => ({ content: 'Goal set' }) })]);
    const fixture = executorFor(registry, contextFor(root, { mutationFence: mutationFence(root) }), {
      commitResult: async () => { throw new Error('journal unavailable'); },
    });
    expect(fixture.executor.isParallelSafe(fixture.request('create_goal', {}))).toBe(false);
    expect(await fixture.execute('create_goal', {})).toMatchObject({ case: 'outcomeUnknown', reasonCode: 'host_capability_result_commit_ambiguous' });
  });

  it('keeps private goal state inside the confirmed result envelope', async () => {
    const root = await temporaryRoot();
    const registry = registryWith([tool({ name: 'create_goal', source: 'native', mutates: false,
      executionClass: 'control', effectBoundary: 'control', parallelSafe: false, handler: async () => ({ content: 'Goal set' }) })]);
    const next = { text: 'Keep settings', status: 'in_progress' as const, budgetTokens: null, completionNote: null,
      createdAt: '2026-10-07T00:00:00.000Z', updatedAt: '2026-10-07T00:00:00.000Z' };
    const fixture = executorFor(registry, contextFor(root, { mutationFence: mutationFence(root) }), {
      commitResult: () => ({ nativeGoal: { version: 1, toolUseId: 'attributed', toolName: 'create_goal', expected: null, next } }),
    });
    const result = await fixture.execute('create_goal', {});
    expect(result.case).toBe('succeeded');
    if (result.case !== 'succeeded') return;
    expect(decodeHostToolExecutionPayload(result.encodedResult)).toMatchObject({ content: 'Goal set', nativeGoal: { next } });
  });
  it('admits owned public reads concurrently without granting a mutation fence', async () => {
    const root = await temporaryRoot();
    const registry = registryWith([webFetch, webSearch]);
    const read = vi.fn(async () => ({ url: 'https://example.com/', status: 200, statusText: 'OK', contentType: 'text/plain',
      text: 'PUBLIC_PAGE', truncated: false, inputBytes: 11, inputSizeExact: true }));
    const fixture = executorFor(registry, contextFor(root, { ports: { web: { read, assertCurrent() {} } } }));
    expect(fixture.executor.isParallelSafe(fixture.request('web_fetch', { url: 'https://example.com/' }))).toBe(true);
    const result = await fixture.execute('web_fetch', { url: 'https://example.com/' });
    expect(result.case).toBe('succeeded'); expect(read).toHaveBeenCalledTimes(1);
  });
  it('preserves an explicit transport unknown instead of committing a normal tool failure', async () => {
    const root = await temporaryRoot();
    const commitResult = vi.fn();
    const registry = registryWith([tool({ name: 'uncertain_write', source: 'native', mutates: true,
      effectBoundary: 'control', handler: async () => unknownToolOutcome('effect executed, ACK lost') })]);
    const fixture = executorFor(registry, contextFor(root, { mutationFence: mutationFence(root) }), { commitResult });
    expect(await fixture.execute('uncertain_write', {})).toMatchObject({
      case: 'outcomeUnknown', reasonCode: 'host_capability_effect_unconfirmed',
    });
    expect(commitResult).not.toHaveBeenCalled();
  });
  it('binds execution to the hydrated wire snapshot without accepting its logical catalog hash', async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, 'wire.txt'), 'wire snapshot read', 'utf8');
    const registry = registryWith(fsTools.filter((tool) => tool.name === 'read_file'));
    const resolved = resolveCapabilitySet(registry.list(), setOptions());
    const wireSnapshot = createHostCapabilitySnapshot(registry, resolved.set);
    const fixture = executorFor(registry, contextFor(root), { wireSnapshot });
    const input = fixture.request('read_file', { path: 'wire.txt' });
    expect(await fixture.executor.execute(input, grantFor(input))).toMatchObject({
      case: 'failed', reasonCode: 'host_capability_not_in_attempt_snapshot',
    });
    const nativeInput = { ...input, capabilitySetSha256: wireSnapshot.snapshotSha256 };
    const outcome = await fixture.executor.execute(nativeInput, grantFor(nativeInput));
    expect(outcome.case).toBe('succeeded');
    if (outcome.case === 'succeeded') expect(decodeHostToolExecutionPayload(outcome.encodedResult).content).toContain('wire snapshot read');
  });

  it('rejects a wire snapshot modified and rehashed outside the sealed registry', async () => {
    const root = await temporaryRoot();
    const registry = registryWith(fsTools.filter((tool) => tool.name === 'read_file'));
    const resolved = resolveCapabilitySet(registry.list(), setOptions());
    const wireSnapshot = createHostCapabilitySnapshot(registry, resolved.set);
    wireSnapshot.encodedSnapshot[wireSnapshot.encodedSnapshot.length - 1] ^= 1;
    const changed = { ...wireSnapshot, snapshotSha256: createHash('sha256').update(wireSnapshot.encodedSnapshot).digest() };
    expect(() => executorFor(registry, contextFor(root), { wireSnapshot: changed })).toThrow('wire capability snapshot');
  });

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
          if (result.extraUserBlocks?.length) return { extraUserMessageHex: encodeNativeToolUserMessage(
            create(agentV1Runtime.ProviderMessageSchema, { role: agentV1Runtime.ProviderMessageRole.USER,
              content: [{ body: { case: 'text', value: { body: { case: 'inlineUtf8', value: 'durable Company receipt' } } } }] })) };
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

  it('withholds the recovery ID until its spill commits and preserves ambiguity on failure', async () => {
    const root = await temporaryRoot();
    let finish!: () => void;
    const durable = new Promise<void>(resolve => { finish = resolve; });
    const drain = vi.fn(() => durable);
    const registry = registryWith([tool({ name: 'large_report', source: 'native',
      handler: async () => ({ content: 'z'.repeat(20000) }) })]);
    const fixture = executorFor(registry, contextFor(root, { toolOutputStore: {
      put: () => 'a'.repeat(64), get: () => null, hasOutputs: () => true, drain,
    } }), { maximumInlineChars: 256 });
    let returned = false;
    const pending = fixture.execute('large_report', {}).then(result => { returned = true; return result; });
    await vi.waitFor(() => expect(drain).toHaveBeenCalled()); expect(returned).toBe(false);
    finish(); expect((await pending).case).toBe('succeeded');
    drain.mockRejectedValue(new Error('disk full'));
    expect((await fixture.execute('large_report', {})).case).toBe('failed');
    const writeRegistry = registryWith([tool({ name: 'large_write', source: 'native', mutates: true,
      effectBoundary: 'control', handler: async () => ({ content: 'z'.repeat(20000) }) })]);
    const writeFixture = executorFor(writeRegistry, contextFor(root, {
      mutationFence: mutationFence(root), toolOutputStore: {
        put: () => 'b'.repeat(64), get: () => null, hasOutputs: () => true, drain,
      },
    }), { maximumInlineChars: 256 });
    expect((await writeFixture.execute('large_write', {})).case).toBe('outcomeUnknown');
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

  it('does not report extra content as delivered without its material receipt', async () => {
    const root = await temporaryRoot();
    const registry = registryWith([tool({ name: 'image_probe', source: 'native',
      handler: async () => ({ content: 'image loaded', extraUserBlocks: [{ type: 'text', text: 'extra content' }] }) })]);
    const fixture = executorFor(registry, contextFor(root));
    expect(await fixture.execute('image_probe', {})).toMatchObject({
      case: 'failed', reasonCode: 'host_capability_extra_content_not_committed',
    });
  });

  it('does not release effect ownership when a timed-out handler keeps running', async () => {
    const root = await temporaryRoot();
    const effects = new HostEffectScope();
    let finish!: () => void;
    const registry = registryWith([tool({ name: 'uncooperative_mutation', source: 'native',
      mutates: true, effectBoundary: 'control', handler: async () => {
        await new Promise<void>(resolve => { finish = resolve; });
        await writeFile(join(root, 'late-effect.txt'), 'settled');
        return { content: 'late effect' };
      } })]);
    const fixture = executorFor(registry, contextFor(root, { mutationFence: mutationFence(root) }), { effects });
    expect(await fixture.execute('uncooperative_mutation', {}, 30n)).toMatchObject({ case: 'outcomeUnknown' });
    expect(effects.activeCount).toBe(1);
    let drained = false;
    const idle = effects.waitForIdle().then(() => { drained = true; });
    await Promise.resolve(); expect(drained).toBe(false);
    finish(); await idle;
    expect(await readFile(join(root, 'late-effect.txt'), 'utf8')).toBe('settled');
    expect(effects.activeCount).toBe(0);
  });

  it.each(['ask_user', 'decision_gate', 'mutating_control'])('uses product cancellation proof only for questions: %s', async name => {
    const root = await temporaryRoot(), controller = new AbortController();
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const registry = registryWith([tool({ name, source: 'native', mutates: false, effectBoundary: 'control', handler: async (_args, context) => {
      entered();
      await new Promise<void>(resolve => context.signal!.addEventListener('abort', () => resolve(), { once: true }));
      return { content: 'cancelled', isError: true };
    } })]);
    const fixture = executorFor(registry, contextFor(root, { mutationFence: mutationFence(root), signal: controller.signal }),
      { cancelledQuestionWithoutResponse: () => true });
    const pending = fixture.execute(name, {}); await ready; controller.abort();
    expect(await pending).toMatchObject({ case: name === 'mutating_control' ? 'outcomeUnknown' : 'cancelled' });
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
    bindNested?: ToolRegistryHostCapabilityExecutorOptions['bindNested'];
    cancelledQuestionWithoutResponse?: ToolRegistryHostCapabilityExecutorOptions['cancelledQuestionWithoutResponse'];
    effects?: HostEffectScope;
    wireSnapshot?: HostCapabilitySnapshot;
    maximumInlineChars?: number;
    maximumEncodedResultBytes?: number;
    commitResult?: ToolRegistryHostCapabilityExecutorOptions['commitResult'];
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
  parallelSafe?: boolean;
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
    parallelSafe: options.parallelSafe ?? !options.mutates,
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
