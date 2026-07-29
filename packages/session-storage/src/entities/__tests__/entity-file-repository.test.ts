import { randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EntityFileRepository } from '../entity-file-repository.js';

interface TestData {
  name: string;
  state: string;
}

let temporaryRoot: string;
let sessionRoot: string;

beforeEach(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), 'mcp-entity-repository-'));
  sessionRoot = join(temporaryRoot, randomUUID());
  await mkdir(sessionRoot);
});

afterEach(async () => {
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe('EntityFileRepository', () => {
  it('stores independent records, sequences them and paginates by seq', async () => {
    const ownerId = randomUUID();
    const repository = new EntityFileRepository<TestData>({
      sessionRoot,
      namespace: 'company/board-items',
      kind: 'company.boardItem',
      journal: true,
    });
    const first = await repository.create({
      id: randomUUID(),
      operationId: randomUUID(),
      relations: { owner: ownerId },
      data: { name: 'one', state: 'open' },
    });
    const second = await repository.create({
      id: randomUUID(),
      operationId: randomUUID(),
      relations: { owner: ownerId },
      data: { name: 'two', state: 'open' },
    });
    const third = await repository.create({
      id: randomUUID(),
      operationId: randomUUID(),
      data: { name: 'three', state: 'closed' },
    });

    expect([first.seq, second.seq, third.seq]).toEqual([1, 2, 3]);
    await expect(
      stat(join(sessionRoot, 'company', 'board-items', `${first.id}.json`)),
    ).resolves.toBeDefined();
    await expect(
      stat(join(sessionRoot, 'company', 'board-items', `${second.id}.json`)),
    ).resolves.toBeDefined();

    const firstPage = await repository.list({ limit: 2 });
    expect(firstPage.items.map((item) => item.data.name)).toEqual([
      'one',
      'two',
    ]);
    expect(firstPage.nextCursor).not.toBeNull();
    const secondPage = await repository.list({
      limit: 2,
      cursor: firstPage.nextCursor!,
    });
    expect(secondPage.items.map((item) => item.data.name)).toEqual(['three']);
    expect(secondPage.nextCursor).toBeNull();

    const owned = await repository.list({
      relation: { name: 'owner', id: ownerId },
    });
    expect(owned.items.map((item) => item.id)).toEqual([first.id, second.id]);
  });

  it('updates atomically, journals mutations and moves deletion to trash', async () => {
    const repository = new EntityFileRepository<TestData>({
      sessionRoot,
      namespace: 'events/runs',
      kind: 'control-plane.run',
      journal: true,
    });
    const created = await repository.create({
      id: randomUUID(),
      operationId: randomUUID(),
      data: { name: 'run', state: 'queued' },
    });
    const updated = await repository.update(created.id, {
      operationId: randomUUID(),
      data: { name: 'run', state: 'running' },
    });
    expect(updated.seq).toBe(created.seq);
    expect((await repository.require(created.id)).data.state).toBe('running');

    const trashed = await repository.moveToTrash(created.id);
    expect(await repository.get(created.id)).toBeNull();
    await expect(
      stat(join(sessionRoot, ...trashed.relativeTrashPath.split('/'))),
    ).resolves.toBeDefined();

    const journal = (
      await readFile(
        join(sessionRoot, 'events', 'runs', '.journal.jsonl'),
        'utf8',
      )
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { operation: string });
    expect(journal.map((entry) => entry.operation)).toEqual([
      'create',
      'update',
      'trash',
    ]);
    const leftovers = (
      await readdir(join(sessionRoot, 'events', 'runs'))
    ).filter((name) => name.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('replays a create operation idempotently and rejects conflicting IDs', async () => {
    const repository = new EntityFileRepository<TestData>({
      sessionRoot,
      namespace: 'tasks',
      kind: 'task',
    });
    const id = randomUUID();
    const operationId = randomUUID();
    const first = await repository.create({
      id,
      operationId,
      data: { name: 'task', state: 'open' },
    });
    const replay = await repository.create({
      id,
      operationId,
      data: { name: 'ignored replay payload', state: 'open' },
    });
    expect(replay).toEqual(first);
    await expect(
      repository.create({
        id,
        operationId: randomUUID(),
        data: { name: 'collision', state: 'open' },
      }),
    ).rejects.toThrow('already exists');
  });

  it('serializes concurrent creates in one repository without duplicate seq values', async () => {
    const repository = new EntityFileRepository<TestData>({
      sessionRoot,
      namespace: 'company/agent-runs',
    });
    const records = await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        repository.create({
          data: { name: `run-${index}`, state: 'queued' },
        }),
      ),
    );
    expect(records.map((record) => record.seq).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 24 }, (_, index) => index + 1),
    );
    expect(new Set(records.map((record) => record.id)).size).toBe(24);
  });

  it('fails closed for traversal, non-UUID relations and symlinked namespaces', async () => {
    expect(
      () =>
        new EntityFileRepository<TestData>({
          sessionRoot,
          namespace: '../outside',
        }),
    ).toThrow('unsafe path segment');

    const repository = new EntityFileRepository<TestData>({
      sessionRoot,
      namespace: 'company/services',
    });
    await expect(
      repository.create({
        data: { name: 'service', state: 'up' },
        relations: { owner: '../../outside' },
      }),
    ).rejects.toThrow('canonical UUID');

    const outside = join(temporaryRoot, 'outside');
    await mkdir(outside);
    await mkdir(join(sessionRoot, 'sprite'));
    try {
      await symlink(
        outside,
        join(sessionRoot, 'sprite', 'assets'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
      throw error;
    }
    const unsafe = new EntityFileRepository<TestData>({
      sessionRoot,
      namespace: 'sprite/assets',
    });
    await expect(
      unsafe.create({ data: { name: 'asset', state: 'ready' } }),
    ).rejects.toThrow('Unsafe repository path component');
  });
});
