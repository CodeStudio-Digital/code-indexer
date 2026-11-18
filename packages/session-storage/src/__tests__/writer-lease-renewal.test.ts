import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileSessionRepository, SessionLocator, SessionFenceLostError, type SessionStorageFaultContext } from '../index.js';

const opened: Array<{ root: string; repository: FileSessionRepository }> = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'writer-renewal-'));
  const project = join(root, 'project');
  await mkdir(project);
  const locator = new SessionLocator({ dataDir: join(root, 'data'), projectRootResolver: {
    resolveProjectRoot: () => project,
    listProjectRoots: () => [{ project_id: 1, root_path: project }],
  } });
  const faults: SessionStorageFaultContext[] = [];
  const repository = new FileSessionRepository({ locator, faultInjector: context => { faults.push(context); } });
  opened.push({ root, repository });
  const created = await repository.createSession({ kind: 'coder', scope: { kind: 'project', project_id: 1 } });
  await repository.primeSession(created.location);
  faults.length = 0;
  return { repository, location: created.location, faults, leasePath: join(created.location.bundle_path, 'events', 'writer.lease') };
}
afterEach(async () => {
  vi.useRealTimers();
  for (const { root, repository } of opened.splice(0)) {
    await repository.close();
    await rm(root, { recursive: true, force: true });
  }
});

describe('writer lease renewal', () => {
  it('commits and synchronizes consecutive turns without rewriting an already fresh lease', async () => {
    const { repository, location, faults } = await fixture();
    vi.useFakeTimers({ toFake: ['Date'] });
    for (let i = 0; i < 4; i++) await repository.commitTurn(location, { operation_id: `turn-${i}`, payload: { i } });
    expect(repository.readConversationSync(location)).toHaveLength(4);
    expect(faults.filter(f => f.path?.endsWith('writer.lease') && f.point === 'atomic:before-temp-write')).toHaveLength(0);
    expect(faults.filter(f => f.point === 'conversation:after-write-before-fsync')).toHaveLength(4);
  });

  it('renews before expiry, retaining enough time for the next heartbeat', async () => {
    const { repository, location, faults, leasePath } = await fixture();
    const prior = JSON.parse(await readFile(leasePath, 'utf8'));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse(prior.expires_at) - 1000);
    await repository.commitTurn(location, { operation_id: 'near-expiry', payload: {} });
    const next = JSON.parse(await readFile(leasePath, 'utf8'));
    expect(Date.parse(next.expires_at)).toBeGreaterThan(Date.parse(prior.expires_at));
    expect(faults.some(f => f.path?.endsWith('writer.lease') && f.point === 'atomic:before-temp-write')).toBe(true);
  });

  it('detects a replacement owner immediately even while the old lease was fresh', async () => {
    const { repository, location, leasePath } = await fixture();
    const prior = JSON.parse(await readFile(leasePath, 'utf8'));
    await writeFile(leasePath, JSON.stringify({ ...prior, token: 'replacement-owner', fence: prior.fence + 1 }));
    const original = repository.readSessionSync(location);
    await expect(repository.updateSession(location, session => ({ ...session, title: 'must not publish' }))).rejects.toBeInstanceOf(SessionFenceLostError);
    expect(repository.readSessionSync(location)).toEqual(original);
  });

  it('renews its unchanged lease after a delayed heartbeat without losing the conversation', async () => {
    const { repository, location, leasePath } = await fixture();
    const prior = JSON.parse(await readFile(leasePath, 'utf8'));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse(prior.expires_at) + 60_000);
    await repository.updateSession(location, session => ({ ...session, title: 'resumed' }));
    await repository.commitTurn(location, { operation_id: 'resumed', payload: { text: 'still alive' } });
    expect(repository.readSessionSync(location).title).toBe('resumed');
    expect(repository.readConversationSync(location)).toHaveLength(1);
    const next = JSON.parse(await readFile(leasePath, 'utf8'));
    expect(next.token).toBe(prior.token);
    expect(next.fence).toBe(prior.fence);
    expect(Date.parse(next.expires_at)).toBeGreaterThan(Date.now());
  });

  it.each(['replacement', 'revoked-fence', 'external-expiry', 'invalid-expiry'])('refuses delayed renewal after %s', async reason => {
    const { repository, location, leasePath } = await fixture();
    const prior = JSON.parse(await readFile(leasePath, 'utf8'));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse(prior.expires_at) + 60_000);
    if (reason === 'revoked-fence') {
      await writeFile(join(location.bundle_path, 'events', 'writer.fence.json'), JSON.stringify({ schema_version: 1, fence: prior.fence + 1 }));
    } else {
      await writeFile(leasePath, JSON.stringify({ ...prior,
        ...(reason === 'replacement' ? { token: 'replacement', fence: prior.fence + 1 }
          : { expires_at: reason === 'invalid-expiry' ? 'invalid' : new Date(Date.now() - 1).toISOString() }),
      }));
    }
    await expect(repository.commitTurn(location, { operation_id: 'must-not-append', payload: {} })).rejects.toBeInstanceOf(SessionFenceLostError);
    expect(repository.readConversationSync(location)).toEqual([]);
  });
});
