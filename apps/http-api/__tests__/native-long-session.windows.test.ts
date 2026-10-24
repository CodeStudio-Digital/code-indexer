import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { MessageChannel } from 'node:worker_threads';
import { expect, it } from 'vitest';
import { MessageBridge } from '@mcp/orchestrator-host';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import { fsTools } from '@mcp/code-agent/tools/fs.js';
import { prepareCoderAttempt } from '@mcp/code-agent/runtime/attempt-preparation.js';
import type { PreparedCoderInputs } from '@mcp/code-agent/runtime/prepared-coder-execution.js';
import type { ChatProvider } from '@mcp/provider-sdk/adapter.js';
import { agentV1Runtime as wire, asAgentRunAttemptId, asAgentRunId, asCorrelationId, asSessionCommandId, type SessionCommand } from '@mcp/agent-runtime-contracts';
import { NativeSessionReader, parseRuntimePackageAnchor, verifyRuntimePackage } from '@mcp/agent-runtime-host';
import { hashControlPlanePayload } from '@mcp/store/control-plane/index.js';
import { executeNativeCoder } from '../workers/native-coder-execution.js';
import { dispatchNativeAuthority, type NativeAuthorityOperation } from '../workers/native-authority-bridge.js';
import { projectNativeSessionHistory } from '../native-session-history.js';
import { supervisorFactFixture } from './supervisor-fact-fixture.js';
import { clearReplayBuffer, createBus } from '../coder-bus.js';
import { inspectNativeContinuation } from '../workers/native-coder-continuation.js';
import { expandContextChapters } from '../../../packages/agent-runtime-host/src/native/NativeContextChapters.js';
import { nativeConversationDigest, nativePublicConversationDigest } from '../../../packages/agent-runtime-host/src/native/NativeConversationDigest.js';

// Opt-in physical scale run, with a deterministic provider and real per-turn
// Rust IPC, filesystem reads, durable commits and continuation. No seeded
// transcript or production provider. Run only under the tracked PID supervisor.
const requested = Number(process.env.MCP_NATIVE_LONG_SESSION_TURNS ?? 0);
const lineBytes = Number(process.env.MCP_NATIVE_LONG_SESSION_LINE_BYTES ?? 0);
const enabled = process.platform === 'win32' && process.env.MCP_RUST_AGENT_PROCESS_REAL_E2E === '1'
  && [100, 1000, 10000].includes(requested);
const scaleIt = enabled ? it : it.skip;
const percentile = (values: number[], fraction: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
};

scaleIt('executes and reopens a long native session without replaying settled reads', async () => {
  const product = await supervisorFactFixture('coder');
  const ports = new MessageChannel();
  const main = new MessageBridge({ port: ports.port1 }), worker = new MessageBridge({ port: ports.port2 });
  let context = product.context, bus = createBus(new AbortController());
  const continuationAttempts = new Set<string>();
  const root = join(product.directory, 'project'), sessionRoot = join(product.directory, 'native-sessions');
  main.handle('native.authority', payload => dispatchNativeAuthority({ authority: product.store, context,
    operation: (payload as { operation: NativeAuthorityOperation }).operation, assertOwner() {} }));
  let execution: Awaited<ReturnType<typeof executeNativeCoder>> | undefined;
  let calls = 0, reads = 0, attempts = 0, messages: PreparedCoderInputs['messages'] = [
    { role: 'user', content: [{ type: 'text', text: 'Read the numbered lines exactly once, in order.' }] },
  ];
  const reportPath = process.env.MCP_NATIVE_LONG_SESSION_REPORT ? resolve(process.env.MCP_NATIVE_LONG_SESSION_REPORT) : undefined;
  if (reportPath && !reportPath.startsWith(resolve('scratch') + '\\')) throw new Error('Scale report must stay under workspace scratch');
  const report = { schemaVersion: 1, requestedTurns: requested, lineBytes, startedAt: new Date().toISOString(),
    scope: 'Physical Windows Rust runner, deterministic provider, isolated session; excludes real provider latency and Electron UI',
    passed: false, toolTurns: 0, providerCalls: 0, attempts: 0, batches: [] as Record<string, unknown>[],
    failure: undefined as string | undefined, elapsedMs: 0 };
  const started = performance.now();
  const save = async () => {
    Object.assign(report, { toolTurns: reads, providerCalls: calls, attempts, elapsedMs: performance.now() - started });
    if (reportPath) await writeFile(reportPath, JSON.stringify(report, null, 2));
  };
  try {
    if (!Number.isSafeInteger(lineBytes) || lineBytes < 0 || lineBytes > 24 * 1024) throw new Error('Invalid physical line byte budget');
    await writeFile(join(root, 'numbered.txt'), Array.from({ length: requested }, (_, index) => `line-${index + 1}`.padEnd(lineBytes, 'x')).join('\n'));
    const runtime = await verifyRuntimePackage(resolve('dist/native-agent-runtime/x86_64-pc-windows-msvc'),
      parseRuntimePackageAnchor(await readFile('dist/apps/electron/native-agent-runtime-integrity.json')));
    const registry = new ToolRegistry(); registry.register(fsTools.find(tool => tool.name === 'read_file')!); registry.seal();
    const systemPrompt = 'Read each requested line once. Preserve confirmed tool results across continuation.';
    while (reads < requested || !report.passed) {
      // The 10k gate crosses ten cold restarts plus many in-attempt compactions;
      // smaller gates retain a cold restart every 100 tool turns.
      const batchSize = requested === 10_000 ? 1_000 : 100;
      const final = reads === requested, batchStart = reads, batchTurns = final ? 1 : Math.min(batchSize, requested - reads);
      if (attempts) {
        const command: SessionCommand = { schemaVersion: 1, commandId: asSessionCommandId(randomUUID()),
          sessionId: context.sessionId, correlationId: asCorrelationId(randomUUID()), requestedAt: new Date().toISOString(),
          actor: context.actor, kind: 'resume', idempotencyKey: randomUUID(), payload: {} };
        context = { ...context, commandId: command.commandId, correlationId: command.correlationId,
          agentRunId: asAgentRunId(randomUUID()), attemptId: asAgentRunAttemptId(randomUUID()), executorOwnerId: `host:${randomUUID()}` };
        await product.store.acceptCommand({ command, payloadHash: hashControlPlanePayload(command.payload), run: {
          ...context, role: 'coder', agentDefinitionId: 'coder', waitMode: 'foreground', requestedCapabilityProfile: 'full',
          executorExpiresAt: new Date(Date.now() + 600_000).toISOString(),
        } });
        continuationAttempts.add(context.attemptId);
        clearReplayBuffer(bus); bus = createBus(new AbortController());
      }
      // The product replay ring is deliberately bounded; observe live results
      // rather than assuming a thousand-turn batch remains in that ring.
      const toolResults: Array<{ data: unknown }> = [];
      bus.subscribers.add(row => { if (row.event === 'tool_call_result') toolResults.push(row); });
      const gaps: number[] = []; let previousProvider: number | undefined, previousCall = reads;
      const provider: ChatProvider = { name: 'openai', model: 'fixture', setModel() {}, async *chat(request) {
        const now = performance.now(); if (previousProvider !== undefined) gaps.push(now - previousProvider); previousProvider = now;
        calls++;
        if (previousCall) {
          const last = request.messages.at(-1);
          expect(last?.role).toBe('tool');
          expect(JSON.stringify(last)).toContain(`line-${previousCall}`);
        }
        if (final) { yield { type: 'text_delta', text: 'All confirmed reads survived reopening.' }; yield { type: 'done' }; return; }
        const index = ++previousCall;
        yield { type: 'tool_call_start', id: `read-${index}`, name: 'read_file' };
        yield { type: 'tool_call_end', id: `read-${index}`, name: 'read_file', input: { path: 'numbered.txt', start_line: index, end_line: index } };
        yield { type: 'done' };
      } };
      const preparation = prepareCoderAttempt({ sessionId: context.sessionId, agentRunId: context.agentRunId,
        runnerRunId: `long-session-${attempts}`, provider: 'openai', model: 'fixture', agentDefinitionId: 'coder', capabilityProfile: 'full',
        systemPromptSha256: createHash('sha256').update(systemPrompt).digest('hex'), environment: { kind: 'host', cwd: root },
        policy: { permissionMode: 'auto', planMode: false, specMode: false } }, registry);
      const batchAt = performance.now();
      execution = await executeNativeCoder({ bridge: worker, runId: ++attempts, bus, assertOwner() {},
        config: { mode: 'test', context, packageDirectory: resolve('dist/native-agent-runtime/x86_64-pc-windows-msvc'),
          anchorPath: resolve('dist/apps/electron/native-agent-runtime-integrity.json'), sessionRoot,
          workspaceRoot: root, workspaceLeaseRoot: join(product.directory, 'native-workspace-leases') },
        prepared: { preparation, registry, provider, systemPrompt, thinking: false, maxTurns: batchTurns,
          messages, resume: attempts > 1, signal: bus.ctrl.signal,
          toolContext: { cwd: root, projectName: 'native-long-session', signal: bus.ctrl.signal } } });
      const result = await execution.done; execution = undefined;
      expect(result.reason).toBe(final ? 'completed' : 'max_turns');
      expect(toolResults).toHaveLength(final ? 0 : batchTurns);
      for (const row of toolResults) expect((row.data as { result: { isError: boolean } }).result.isError).toBe(false);
      reads = previousCall;
      expect(reads).toBe(final ? requested : batchStart + batchTurns);
      const executionMs = performance.now() - batchAt, reopenAt = performance.now();
      const reader = await NativeSessionReader.open(runtime, { rootPath: sessionRoot, sessionId: context.sessionId });
      try {
        messages = (await projectNativeSessionHistory(reader, context.sessionId, new Date().toISOString(),
          async attemptId => continuationAttempts.has(attemptId))).messages;
        if (!final) {
          let frontier: wire.ProviderResumeContextV1 | undefined;
          await inspectNativeContinuation(reader, true, value => { frontier = value; });
          expect(frontier!.context!.messages.length).toBeLessThanOrEqual(768);
          const expanded = await expandContextChapters(reader.store, context.sessionId, frontier!.context!.messages);
          expect(await nativePublicConversationDigest({ sessionId: context.sessionId, messages }))
            .toBe(nativeConversationDigest(expanded));
        }
      }
      finally { await reader.close(); }
      const recoveryMs = performance.now() - reopenAt;
      expect(messages).toHaveLength(1 + reads * 2 + (final ? 1 : 0));
      expect(JSON.parse(await readFile(join(product.directory, 'native-workspace-leases', 'leases.json'), 'utf8')).state.leases).toEqual([]);
      report.batches.push({ endTurn: reads, final, executionMs, recoveryMs, includesFrontierRoundTripValidation: !final, messages: messages.length,
        betweenProviders: { samples: gaps.length, p50Ms: percentile(gaps, .5), p95Ms: percentile(gaps, .95), maxMs: Math.max(0, ...gaps) },
        hostRssBytes: process.memoryUsage().rss });
      report.passed = final; await save();
      console.log(JSON.stringify({ scaleTurn: reads, final, executionMs, recoveryMs }));
      if (final) break;
    }
    expect(calls).toBe(requested + 1);
    const completedToolIds = messages.flatMap(message => message.content.flatMap(block => block.type === 'tool_use' ? [block.id] : []));
    expect(completedToolIds).toHaveLength(requested); expect(new Set(completedToolIds).size).toBe(requested);
    if (lineBytes && requested * lineBytes > 8 * 1024 * 1024) expect(Buffer.byteLength(JSON.stringify(messages))).toBeGreaterThan(8 * 1024 * 1024);
    let journalBytes = 0;
    for (const path of await readdir(sessionRoot, { recursive: true })) {
      const info = await stat(join(sessionRoot, path)); if (info.isFile()) journalBytes += info.size;
    }
    Object.assign(report, { journalBytes }); await save();
  } catch (cause) {
    report.passed = false; report.failure = cause instanceof Error ? cause.message : String(cause); await save(); throw cause;
  } finally {
    bus.ctrl.abort();
    if (execution) { await execution.cancel({ code: 'user_cancelled' }).catch(() => undefined); await execution.done.catch(() => undefined); }
    main.dispose(); worker.dispose(); ports.port1.close(); ports.port2.close(); clearReplayBuffer(bus);
    await product.sessions.close();
    if (dirname(resolve(product.directory)) !== resolve(tmpdir()) || !product.directory.includes('codestudio-supervisor-facts-')) throw new Error('Unsafe scale fixture cleanup');
    await rm(product.directory, { recursive: true, force: true });
  }
}, 7_000_000);
