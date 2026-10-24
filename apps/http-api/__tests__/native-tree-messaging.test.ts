import { create } from '@bufbuild/protobuf';
import { agentV1Runtime as wire } from '@mcp/agent-runtime-contracts';
import { describe, expect, it, vi } from 'vitest';
import { NativeTreeMailbox } from '../workers/native-tree-mailbox.js';
import { NativeTreeInventory } from '../workers/native-tree-inventory.js';
import { NativeTreeJobs } from '../workers/native-tree-jobs.js';
import { NativeCoderInteractions } from '../sse/native-coder-interactions.js';
import { NativeInteractiveToolPort } from '../workers/native-interactive-tool-port.js';
import { sendMessage } from '@mcp/code-agent/tools/send-message.js';
import { sendInput } from '@mcp/code-agent/tools/send-input.js';
import { followupTask } from '@mcp/code-agent/tools/followup-task.js';
import { buildCollectAgentsTool } from '@mcp/code-agent/tools/collect-agents.js';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import { uncertainToolOutcomeError } from '@mcp/code-agent/core/uncertain-tool-outcome.js';

function durable() {
  const rows = new Map<string, unknown>();
  return { rows, persist: vi.fn(async (key: string, value: unknown) => {
    if (rows.has(key)) return false; rows.set(key, structuredClone(value)); return true;
  }) };
}
function fixture() {
  const inventory = new NativeTreeInventory('root');
  inventory.admit({ agentRunId: 'child', parentAgentRunId: 'root', role: 'explore', provider: 'local', model: 'fixture' });
  inventory.admit({ agentRunId: 'peer', parentAgentRunId: 'root', role: 'explore', provider: 'local', model: 'fixture' });
  const mailbox = new NativeTreeMailbox(inventory), root = durable(), child = durable();
  mailbox.register('root', root.persist); mailbox.register('child', child.persist); mailbox.register('peer', durable().persist);
  const start = create(wire.ProviderStartSchema, { messages: [create(wire.ProviderMessageSchema, { role: wire.ProviderMessageRole.USER })] });
  const prepare = mailbox.preparation('child', { prepare: async () => ({ resetContinuation: false }) });
  return { inventory, mailbox, root, child, start, prepare };
}

describe('native durable tree mailbox', () => {
  it('persists sender and target payload before exposing a message at a provider boundary', async () => {
    const f = fixture();
    const receipt = await f.mailbox.post('root', { to: 'child', kind: 'message', message: 'find the serializer', invocationId: 'call-1' });
    expect(receipt.status).toBe('queued'); expect(f.root.rows.size).toBe(1); expect(f.child.rows.size).toBe(1);
    const context = await f.prepare.prepare(f.start, new AbortController().signal, false);
    expect(context.context?.contentUtf8).toContain('find the serializer'); expect(context.resetContinuation).toBe(true);
    const repeated = await f.prepare.prepare(f.start, new AbortController().signal, true);
    expect(repeated.context).toEqual(context.context); expect(repeated.resetContinuation).toBe(false);
    await expect(f.mailbox.post('root', { to: 'child', kind: 'message', message: 'find the serializer', invocationId: 'call-1' }))
      .rejects.toMatchObject({ code: 'TOOL_OUTCOME_UNKNOWN' });
    expect((await f.prepare.prepare(f.start, new AbortController().signal, false)).context).toEqual(context.context);
  });
  it('does not publish after lost receiver persistence and never retries uncertain delivery', async () => {
    const f = fixture(); f.child.persist.mockRejectedValueOnce(new Error('disk full'));
    await expect(f.mailbox.post('root', { to: 'child', kind: 'input', message: 'stop editing', invocationId: 'call-2' }))
      .rejects.toMatchObject({ code: 'TOOL_OUTCOME_UNKNOWN' });
    expect((await f.prepare.prepare(f.start, new AbortController().signal, false)).context).toBeUndefined();
    expect(f.root.rows.size).toBe(1);
  });
  it('restores a durable inbox at the next provider boundary without replaying delivery or interrupts', async () => {
    const f = fixture(), interrupt = vi.fn(async () => true);
    f.mailbox.bindInterrupt('child', interrupt);
    const entry = { id: 'a'.repeat(64), from: '/root', to: '/root/old-child', kind: 'input' as const, message: 'retained before frontier commit' };
    await f.mailbox.restore('child', [entry, entry]); await f.mailbox.restore('child', [entry]);
    const context = (await f.prepare.prepare(f.start, new AbortController().signal, false)).context!.contentUtf8;
    expect(context.split(entry.id)).toHaveLength(2); expect(context).toContain(entry.message);
    expect(f.root.persist).not.toHaveBeenCalled(); expect(f.child.persist).toHaveBeenCalledOnce(); expect(interrupt).not.toHaveBeenCalled();
    await expect(f.mailbox.restore('child', [{ ...entry, message: 'changed' }])).rejects.toThrow('diverged');
    const nextInventory = new NativeTreeInventory('successor'), nextMailbox = new NativeTreeMailbox(nextInventory), next = durable();
    nextMailbox.register('successor', next.persist);
    await nextMailbox.restore('successor', [...f.child.rows.values()].map(row => (row as { envelope: typeof entry }).envelope));
    expect(next.rows.size).toBe(1);
    const recovered = await nextMailbox.preparation('successor', { prepare: async () => ({ resetContinuation: false }) })
      .prepare(f.start, new AbortController().signal, false);
    expect(recovered.context!.contentUtf8).toContain(entry.message);
  });
  it('rejects self, foreign, terminal, peer interrupts and oversized bodies before persistence', async () => {
    const f = fixture();
    const message = { kind: 'input' as const, message: 'task', invocationId: 'call' };
    for (const to of ['root', 'foreign']) await expect(f.mailbox.post('root', { ...message, to })).rejects.toThrow();
    await expect(f.mailbox.post('child', { ...message, to: 'peer' })).rejects.toThrow('parent or descendant');
    await expect(f.mailbox.post('root', { ...message, to: 'child', message: 'x'.repeat(4097) })).rejects.toThrow('bounds');
    f.inventory.update('child', { status: 'completed' });
    await expect(f.mailbox.post('root', { ...message, to: 'child' })).rejects.toThrow('terminal');
    expect(f.root.rows.size).toBe(0);
  });
  it('does not publish a restored inbox before its successor receipt and safely retries a lost checkpoint ACK', async () => {
    const f = fixture(), entry = { id: 'd'.repeat(64), from: '/root', to: '/root/old-child', kind: 'message' as const, message: 'retained instruction' };
    f.child.persist.mockImplementationOnce(async (key, value) => { f.child.rows.set(key, structuredClone(value)); throw new Error('checkpoint ACK lost'); });
    await expect(f.mailbox.restore('child', [entry])).rejects.toThrow('ACK lost');
    expect((await f.prepare.prepare(f.start, new AbortController().signal, false)).context).toBeUndefined();
    await f.mailbox.restore('child', [entry]);
    expect(f.child.rows.size).toBe(1);
    expect((await f.prepare.prepare(f.start, new AbortController().signal, false)).context!.contentUtf8).toContain(entry.message);
  });
  it('retains the inbox across failed provider preparation and bounds the context', async () => {
    const f = fixture();
    for (let n = 0; n < 5; n++) await f.mailbox.post('root', { to: 'child', kind: 'message', message: 'ä'.repeat(1800), invocationId: `call-${n}` });
    const preparation = f.mailbox.preparation('child', { prepare: async () => ({ context: create(wire.ProviderPreparedBoundaryContextV1Schema,
      { contentUtf8: 'memory'.repeat(4000) }), resetContinuation: false }) });
    const result = await preparation.prepare(f.start, new AbortController().signal, false);
    expect(Buffer.byteLength(result.context!.contentUtf8)).toBeLessThanOrEqual(32768);
    expect(result.context!.contentUtf8.includes('"to":"/root/agent-child"')).toBe(true);
    f.mailbox.close('child');
    await expect(preparation.prepare(f.start, new AbortController().signal, false)).rejects.toThrow('not live');
  });
});

describe('owned background jobs', () => {
  it('returns admission before completion and delivers only a durably committed result', async () => {
    const persistence = durable(), ctrl = new AbortController(), jobs = new NativeTreeJobs(persistence.persist, ctrl.signal);
    let finish!: (value: { content: string }) => void;
    const task = new Promise<{ content: string }>(resolve => { finish = resolve; });
    const admitted = await jobs.start({ invocationId: 'call-1', task: { text: 'inspect' } }, async signal => { expect(signal).toBe(ctrl.signal); return task; });
    const jobId = (admitted.structuredData as { jobId: string }).jobId;
    expect((await jobs.collect({ jobId, timeoutMs: 0 })).structuredData).toMatchObject({ kind: 'collect_agents_pending' });
    const collection = jobs.collect({ jobId, timeoutMs: 10_000 });
    finish({ content: 'finished result' });
    expect(await collection).toMatchObject({ content: 'finished result', structuredData: { kind: 'collect_agents_result', status: 'completed' } });
    expect(persistence.rows.size).toBe(2); await jobs.drain();
    await expect(jobs.start({ invocationId: 'call-1', task: {} }, async () => ({ content: 'bad' }))).rejects.toMatchObject({ code: 'TOOL_OUTCOME_UNKNOWN' });
  });
  it('blocks automatic replay after an admission ACK is lost and fences result persistence failures', async () => {
    const persistence = durable(), jobs = new NativeTreeJobs(persistence.persist, new AbortController().signal);
    persistence.persist.mockResolvedValueOnce(false);
    const run = vi.fn(async () => ({ content: 'effect complete' }));
    await expect(jobs.start({ invocationId: 'old', task: {} }, run)).rejects.toMatchObject({ code: 'TOOL_OUTCOME_UNKNOWN' });
    expect(run).not.toHaveBeenCalled();
    const result = await jobs.start({ invocationId: 'new', task: {} }, run);
    persistence.persist.mockRejectedValueOnce(new Error('disk full'));
    await expect(jobs.drain()).rejects.toMatchObject({ code: 'TOOL_OUTCOME_UNKNOWN' });
    await expect(jobs.collect({ jobId: (result.structuredData as { jobId: string }).jobId, timeoutMs: 0 })).rejects.toMatchObject({ code: 'TOOL_OUTCOME_UNKNOWN' });
  });
  it('does not let an uncollected unknown child complete the parent, but retains known failures', async () => {
    const jobs = new NativeTreeJobs(durable().persist, new AbortController().signal);
    await jobs.start({ invocationId: 'failed', task: {} }, async () => ({ content: 'known failure', isError: true }));
    await jobs.drain();
    await jobs.start({ invocationId: 'unknown', task: {} }, async () => ({ content: 'ACK lost', isError: true, effectOutcome: 'unknown' }));
    await expect(jobs.drain()).rejects.toMatchObject({ code: 'TOOL_OUTCOME_UNKNOWN' });
  });
  it('bounds durable result metadata without dropping the child transcript reference', async () => {
    const persistence = durable(), jobs = new NativeTreeJobs(persistence.persist, new AbortController().signal);
    const reference = 'native-child-journal:retained';
    const started = await jobs.start({ invocationId: 'large', task: {} }, async () => ({ content: 'x'.repeat(100_000),
      structuredData: { nativeTranscriptRef: reference, details: 'y'.repeat(200_000) } }));
    await jobs.drain();
    const result = await jobs.collect({ jobId: (started.structuredData as { jobId: string }).jobId, timeoutMs: 0 });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(70_000);
    expect(result.structuredData).toMatchObject({ result: { nativeTranscriptRef: reference, truncated: true } });
  });
  it('retains a child unknown effect when owner cancellation aborts the result checkpoint', async () => {
    const persist = durable(), ctrl = new AbortController(), jobs = new NativeTreeJobs(persist.persist, ctrl.signal);
    let finish!: (result: { content: string; effectOutcome: 'unknown' }) => void;
    const result = new Promise<{ content: string; effectOutcome: 'unknown' }>(resolve => { finish = resolve; });
    await jobs.start({ invocationId: 'cancelled-unknown', task: {} }, async () => result);
    persist.persist.mockRejectedValueOnce(Object.assign(new Error('checkpoint cancelled'), { name: 'AbortError' }));
    ctrl.abort(); finish({ content: 'child effect could not be confirmed', effectOutcome: 'unknown' });
    await expect(jobs.drain()).rejects.toMatchObject({ code: 'TOOL_OUTCOME_UNKNOWN' });
  });
});

it('send_input releases only questions and never approves plan/spec/permissions', async () => {
  const slots = new NativeCoderInteractions(new AbortController().signal);
  const port = new NativeInteractiveToolPort('coder', false, slots, () => {}, () => {});
  const question = port.request({ kind: 'question', payload: { id: 'question', question: 'Which file?' } } as never);
  expect(await port.interruptForAgent()).toBe(true);
  expect(JSON.parse(await question)).toEqual({ interrupted: true, source: 'agent' });
  const plan = port.request({ kind: 'plan', payload: { id: 'plan' } } as never);
  expect(await port.interruptForAgent()).toBe(false); expect(port.planApproved).toBe(false);
  const permission = slots.waitForInput('tool_approval:danger');
  expect(await port.interruptForAgent()).toBe(false); expect(slots.hasPending('tool_approval:danger')).toBe(true);
  slots.close(); await Promise.all([plan, permission]);
});

it('all native tool handlers require their owned native ports, without Company fallback', async () => {
  const message = vi.fn(async () => ({ id: 'id', status: 'queued' as const, target: '/root/agent-child', interrupted: false }));
  const collect = vi.fn(async () => ({ content: 'collected' }));
  const ctx = { runtimeGeneration: 'rust_v1', controlPlaneParentAgentRunId: 'root', currentToolUseId: 'call',
    ports: { agentTree: { runtimeGeneration: 'rust_v1', ownerAgentRunId: 'root', run: vi.fn(), message, collect } } } as unknown as ToolContext;
  await sendMessage.handler({ to: 'child', message: 'hello' }, ctx);
  await sendInput.handler({ to: 'child', message: 'urgent' }, ctx);
  await followupTask.handler({ to: 'child', task: 'next' }, ctx);
  expect(message.mock.calls.map((call: unknown[]) => (call[0] as { kind: string }).kind)).toEqual(['message', 'input', 'followup']);
  await buildCollectAgentsTool({} as never).handler({ wait: false }, ctx);
  expect(collect).toHaveBeenCalledWith({ jobId: undefined, signal: undefined, timeoutMs: 0 });
  const foreign = { ...ctx, controlPlaneParentAgentRunId: 'foreign' };
  await expect(sendMessage.handler({ to: 'child', message: 'hello' }, foreign)).rejects.toThrow('admitted tree');
});

it('preserves typed uncertain messaging effects across the actual registry boundary', async () => {
  const registry = new ToolRegistry(); registry.register({ ...sendMessage, handler: async () => { throw uncertainToolOutcomeError('lost-mailbox-ack'); } });
  const result = await registry.invoke('send_message', { to: 'child', message: 'task' }, { cwd: process.cwd(), projectName: 'fixture' });
  expect(result).toMatchObject({ isError: true, effectOutcome: 'unknown' });
});
