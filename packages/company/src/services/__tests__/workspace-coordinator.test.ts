import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CompanyWorkspaceCoordinator } from '../workspace-coordinator.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() { const root = await mkdtemp(join(tmpdir(), 'company-workspace-regression-')); roots.push(root); return { a: new CompanyWorkspaceCoordinator(root), b: new CompanyWorkspaceCoordinator(root) }; }
function deferred() { let resolve!: () => void; return { promise: new Promise<void>(done => { resolve = done; }), resolve: () => resolve() }; }
const owner = (sessionId: string, signal?: AbortSignal) => ({ sessionId, signal, agentRunId: sessionId, toolUseId: 'tool', toolName: 'edit_file' });

describe('Company workspace mutation ownership', () => {
  it('queues another session until the physical mutation settles, then wakes without polling', async () => {
    const { a, b } = await fixture(); const entered = deferred(); const release = deferred(); const order: string[] = [];
    const first = a.run(owner('a'), async () => { order.push('a-start'); entered.resolve(); await release.promise; order.push('a-end'); return 'done'; }, () => false);
    await entered.promise;
    const second = b.run(owner('b'), async () => { order.push('b-start'); return 'done'; }, () => false);
    expect(order).toEqual(['a-start']); release.resolve(); await Promise.all([first, second]);
    expect(order).toEqual(['a-start', 'a-end', 'b-start']); expect(await b.owners()).toEqual([]);
  });
  it('cancels a waiting session without dispatching or releasing the active owner', async () => {
    const { a, b } = await fixture(); const entered = deferred(); const release = deferred(); const abort = new AbortController(); let ran = false;
    const first = a.run(owner('a'), async () => { entered.resolve(); await release.promise; }, () => false); await entered.promise;
    const waiting = b.run(owner('b', abort.signal), async () => { ran = true; }, () => false);
    abort.abort(new Error('paused')); await expect(waiting).rejects.toThrow('paused');
    expect(ran).toBe(false); expect((await b.owners()).map(row => row.sessionId)).toEqual(['a']);
    release.resolve(); await first;
  });
  it('retains an uncertain effect and requires review of the exact owner before another session writes', async () => {
    const { a, b } = await fixture();
    await a.run(owner('a'), async () => ({ unknown: true }), value => value.unknown);
    await expect(b.run(owner('b'), async () => 'write', () => false)).rejects.toThrow('WORKSPACE_OUTCOME_PENDING');
    const records = await b.owners(); expect(records[0].phase).toBe('uncertain');
    await expect(b.reconcile(['stale-token'])).rejects.toThrow('WORKSPACE_REVIEW_STALE');
    await b.reconcile(records.map(row => row.token));
    await expect(b.run(owner('b'), async () => 'write', () => false)).resolves.toBe('write');
  });
  it('keeps an interrupted in-flight effect fenced even when its session was cancelled', async () => {
    const { a } = await fixture(); const abort = new AbortController();
    await expect(a.run(owner('a', abort.signal), async () => { abort.abort(); throw new Error('outcome unknown'); }, () => false)).rejects.toThrow('outcome unknown');
    expect((await a.owners())[0].phase).toBe('uncertain');
  });
  it('retains a yielded command until the real process exit receipt', async () => {
    const { a, b } = await fixture(); const receipt = deferred();
    await a.run({ ...owner('a'), pendingEffects: () => [receipt.promise] }, async () => 'process still running', () => false);
    const held = await a.owners(); expect(held[0].phase).toBe('running');
    await expect(b.reconcile(held.map(row => row.token))).rejects.toThrow('WORKSPACE_OWNER_ACTIVE');
    const second = b.run(owner('b'), async () => 'second writer', () => false);
    receipt.resolve(); await expect(second).resolves.toBe('second writer');
    expect(await b.owners()).toEqual([]);
  });
});
