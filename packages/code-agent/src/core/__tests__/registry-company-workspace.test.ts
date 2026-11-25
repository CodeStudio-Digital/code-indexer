import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../registry.js';
import type { ToolContext } from '../tool.js';
import { CompanyWorkspaceCoordinator } from '@mcp/company/services/workspace-coordinator.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
describe('Company registry workspace gate', () => {
  it('reports the actual uncertain file effect and leaves a conflicting writer undispatched', async () => {
    const root = await mkdtemp(join(tmpdir(), 'company-registry-blocked-'));
    roots.push(root);
    const gate = new CompanyWorkspaceCoordinator(root);
    await gate.run({ sessionId: 'owner', agentRunId: 'author', toolUseId: 'prior-write', toolName: 'edit_file' }, async () => 'unknown', () => true);
    const handler = vi.fn(async () => ({ content: 'written' }));
    const registry = new ToolRegistry();
    registry.register({ name: 'write_file', source: 'native', description: 'write', mutates: true, effectBoundary: 'filesystem', parameters: { type: 'object', properties: {} }, handler });
    const result = await registry.invoke('write_file', {}, { cwd: '.', projectName: 'fixture', companyContext: {
      companySessionId: 'review', agentRunId: 'reviewer', workspaceMutationGate: gate,
    } as never });
    expect(result).toMatchObject({ isError: true, error: { code: 'WORKSPACE_OUTCOME_PENDING', kind: 'conflict', retryable: false } });
    expect(result.content).toContain('edit_file (session owner)');
    expect(handler).not.toHaveBeenCalled();
    expect((await gate.owners()).map(owner => owner.toolUseId)).toEqual(['prior-write']);
  });

  it('gates mutations from distinct sessions, reports waiting, permits inspection and releases on physical settlement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'company-registry-gate-')); roots.push(root);
    let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; });
    const writes: string[] = []; const registry = new ToolRegistry();
    registry.register({ name: 'write_file', description: 'fixture', source: 'native', mutates: true, effectBoundary: 'filesystem', parameters: { type: 'object', properties: {} }, handler: async (_args, context) => {
      writes.push(context.companyContext!.companySessionId);
      if (context.companyContext!.companySessionId === 'a') context.retainWorkspaceMutationUntil?.(pending);
      return { content: 'accepted' };
    } });
    registry.register({ name: 'read_file', description: 'fixture', source: 'native', mutates: false, riskLevel: 'read', executionClass: 'read', parameters: { type: 'object', properties: {} }, handler: async () => ({ content: 'inspection' }) });
    const context = (sessionId: string): ToolContext => ({ cwd: '.', projectName: 'fixture', reportProgress: vi.fn(), companyContext: { companySessionId: sessionId, agentRunId: sessionId, workspaceMutationGate: new CompanyWorkspaceCoordinator(root) } as never });
    const a = context('a'); const b = context('b');
    await registry.invoke('write_file', {}, a);
    const next = registry.invoke('write_file', {}, b);
    await vi.waitFor(() => expect(b.reportProgress).toHaveBeenCalledWith(expect.stringContaining('waiting_resource')));
    expect(writes).toEqual(['a']); expect((await registry.invoke('read_file', {}, b)).content).toBe('inspection');
    release(); await expect(next).resolves.toMatchObject({ content: 'accepted' }); expect(writes).toEqual(['a', 'b']);
  });
});
