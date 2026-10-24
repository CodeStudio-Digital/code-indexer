import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import { createMutationFenceAuthority } from '@mcp/code-agent/core/mutation-fence.js';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import { submitSpec } from '@mcp/code-agent/tools/spec/submit-spec.js';
import { LocalFilesystemAdapter } from '@mcp/code-agent/ports/filesystem-port.js';
import { evaluateToolInvocation } from '@mcp/code-agent/core/policy.js';
import { NativeCoderInteractions } from '../sse/native-coder-interactions.js';
import { NativeInteractiveToolPort } from '../workers/native-interactive-tool-port.js';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), 'native-spec-')); roots.push(cwd);
  const controller = new AbortController(); const slots = new NativeCoderInteractions(controller.signal);
  const emit = vi.fn();
  const port = new NativeInteractiveToolPort('spec', true, slots, emit, () => controller.signal.throwIfAborted());
  const fs = new LocalFilesystemAdapter();
  const context: ToolContext = { cwd, projectName: 'fixture', currentToolUseId: 'native-tool:spec', signal: controller.signal,
    ports: { interactions: port, fs }, setSessionAgent: vi.fn() };
  Object.defineProperty(context, 'runner', { get() { throw new Error('Legacy runner access forbidden'); } });
  const mutationAllowed = () => evaluateToolInvocation({ ...submitSpec, name: 'write_file', mutates: true }, {},
    { planMode: false, planApproved: false, specMode: true, specApproved: port.specApproved, taskScope: null }).allowed;
  return { cwd, controller, slots, emit, port, fs, context, mutationAllowed };
}

it('keeps mutations gated, saves separate drafts, and accepts only the displayed review identity', async () => {
  const f = await fixture(); vi.spyOn(Date, 'now').mockReturnValue(1234567890000);
  const first = submitSpec.handler({ name: 'Feature', body: '# Draft one' }, f.context);
  await vi.waitFor(() => expect(f.slots.isWaiting).toBe(true));
  const posted = f.emit.mock.calls[0]![1];
  expect(f.emit.mock.calls[0]![0]).toBe('spec');
  expect(await readFile(join(f.cwd, posted.spec_path), 'utf8')).toBe('# Draft one');
  expect(f.mutationAllowed()).toBe(false);
  expect(await f.slots.provideInput('native-tool:foreign', '{"approved":true}')).toBe(false);
  await f.slots.provideInput('native-tool:spec', '{"approved":false,"requested_changes":"Add tests"}');
  expect((await first).content).toContain('Add tests');
  expect((await submitSpec.handler({ name: 'Feature', body: '# Draft one' }, f.context)).isError).toBe(true);
  const next = submitSpec.handler({ name: 'Feature', body: '# Draft two with tests' }, f.context);
  await vi.waitFor(() => expect(f.slots.isWaiting).toBe(true));
  expect(f.mutationAllowed()).toBe(false);
  expect(await readdir(join(f.cwd, '.mcp/specs'))).toHaveLength(2);
  await f.slots.provideInput('native-tool:spec', '{"approved":true}');
  expect((await next).extraUserBlocks).toHaveLength(1);
  expect(f.context.setSessionAgent).toHaveBeenCalledWith('build');
  expect(f.mutationAllowed()).toBe(true); expect(f.port.specMode).toBe(false);
  expect(await readFile(join(f.cwd, posted.spec_path), 'utf8')).toBe('# Draft one');
  f.slots.close();
});

it('does not publish approval when the artifact cannot be committed', async () => {
  const f = await fixture(); vi.spyOn(f.fs, 'createFile').mockRejectedValueOnce(new Error('disk full'));
  await expect(submitSpec.handler({ name: 'Feature', body: '# Draft' }, f.context)).rejects.toThrow('disk full');
  expect(f.emit).not.toHaveBeenCalled(); expect(f.mutationAllowed()).toBe(false); f.slots.close();
});

it('does not unlock the gate when saving the approved mode fails', async () => {
  const f = await fixture(); f.context.setSessionAgent = vi.fn(async () => { throw new Error('mode write failed'); });
  const pending = submitSpec.handler({ name: 'Feature', body: '# Draft' }, f.context);
  const failed = expect(pending).rejects.toThrow('mode write failed');
  await vi.waitFor(() => expect(f.slots.isWaiting).toBe(true));
  await f.slots.provideInput('native-tool:spec', '{"approved":true}'); await failed;
  expect(f.mutationAllowed()).toBe(false); f.slots.close();
});

it('cancels an outstanding review without granting later mutations', async () => {
  const f = await fixture(); const pending = submitSpec.handler({ name: 'Feature', body: '# Draft' }, f.context);
  const failed = expect(pending).rejects.toThrow();
  await vi.waitFor(() => expect(f.slots.isWaiting).toBe(true)); f.controller.abort(); await failed;
  expect(f.slots.isWaiting).toBe(false); expect(f.port.specApproved).toBe(false);
  expect(f.context.setSessionAgent).not.toHaveBeenCalled();
});

it('dispatches the specification through the registry and the physical filesystem fence', async () => {
  const f = await fixture();
  f.context.mutationFence = createMutationFenceAuthority({ mode: 'enforce', authorizedRoot: f.cwd,
    assertLease: () => f.controller.signal.throwIfAborted(), snapshot: () => ({
      environmentId: 'environment:spec', environmentVersion: 1, workspaceLeaseId: 'lease:spec',
      workspaceLeaseVersion: 1, workspaceFencingEpoch: 1, ownerAgentRunId: '00000000-0000-4000-8000-000000000001',
    }) });
  const registry = new ToolRegistry(); registry.register(submitSpec); registry.seal();
  const pending = registry.invoke('submit_spec', { name: 'Native fixture', body: '# Fenced draft' }, f.context);
  try {
    await vi.waitFor(() => expect(f.slots.isWaiting).toBe(true));
    const posted = f.emit.mock.calls[0]![1];
    expect(await readFile(join(f.cwd, posted.spec_path), 'utf8')).toBe('# Fenced draft');
    await f.slots.provideInput('native-tool:spec', '{"approved":true}');
    expect((await pending).isError).not.toBe(true); expect(f.port.specApproved).toBe(true);
  } finally { f.controller.abort(); f.slots.close(); await pending; }
});