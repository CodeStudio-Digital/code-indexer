import { appendFile, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ArtifactRecoveryCorruptionError,
  ArtifactStore,
  FileSessionRepository,
  SESSION_BUNDLE_DIRECTORIES,
  SESSION_LAYOUT_VERSION,
  SessionCatalog,
  SessionFenceLostError,
  SessionLeaseHeldError,
  SessionLocator,
  SessionOperationConflictError,
  SessionRootUnavailableError,
  emptySessionMetricsSummary,
  newSessionId,
  releaseSessionWriterLeaseForOwner,
  toolOutputRecordFileName,
  ToolOutputConflictError,
  UnsafeSessionPathError,
  type ProjectRootRecord,
  type ProjectRootResolver,
  type JsonValue,
  type SessionLocation,
  type SessionStorageFaultContext,
  type SessionStorageFaultInjector,
} from '../index.js';

interface Fixture {
  readonly base: string;
  readonly dataDir: string;
  readonly projectRoots: readonly ProjectRootRecord[];
  readonly locator: SessionLocator;
  readonly repository: FileSessionRepository;
}

const fixtures: Fixture[] = [];

async function fixture(options: {
  readonly faultInjector?: SessionStorageFaultInjector;
  readonly leaseTtlMs?: number;
  readonly artifactRecoveryRegistry?: Set<string>;
  readonly writerOwnerId?: string;
} = {}): Promise<Fixture> {
  const base = mkdtempSync(join(tmpdir(), 'mcp-session-storage-'));
  const dataDir = join(base, 'data');
  const firstProject = join(base, 'project-a');
  const secondProject = join(base, 'project-b');
  await Promise.all([mkdir(dataDir), mkdir(firstProject), mkdir(secondProject)]);
  const projectRoots: readonly ProjectRootRecord[] = [
    { project_id: 1, root_path: firstProject },
    { project_id: 2, root_path: secondProject },
  ];
  const resolver: ProjectRootResolver = {
    resolveProjectRoot(projectId) {
      return projectRoots.find((project) => project.project_id === projectId)?.root_path;
    },
    listProjectRoots() {
      return projectRoots;
    },
  };
  const locator = new SessionLocator({ dataDir, projectRootResolver: resolver });
  const repository = new FileSessionRepository({
    locator,
    writerOwnerId: options.writerOwnerId,
    faultInjector: options.faultInjector,
    leaseTtlMs: options.leaseTtlMs,
    artifactRecoveryRegistry: options.artifactRecoveryRegistry,
  });
  const result = { base, dataDir, projectRoots, locator, repository };
  fixtures.push(result);
  return result;
}

afterEach(async () => {
  const pending = fixtures.splice(0);
  await Promise.allSettled(pending.map((entry) => entry.repository.close()));
  await Promise.allSettled(pending.map((entry) => rm(entry.base, { recursive: true, force: true })));
});

describe('filesystem session bundle', () => {
  it('persists diagnostic rows without flushing unchanged accounting totals, and still counts replacements', async () => {
    let summaryFlushes = 0;
    const { repository } = await fixture({ faultInjector: ({ point, path }) => {
      if (point === 'atomic:after-temp-fsync-before-rename' && path?.endsWith('summary.json')) summaryFlushes++;
    } });
    const { location } = await repository.createSession({ kind: 'coder', scope: { kind: 'project', project_id: 1 } });
    const zeroUsage = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 };
    const metric = { schema_version: 1, turns: 1, tool_calls: 1,
      usage: { ...zeroUsage, input_tokens: 10 }, subagent_usage: zeroUsage };
    await repository.writeEntity(location, 'metrics/turns', 'canonical', metric);
    const summaryPath = join(location.bundle_path, 'metrics', 'summary.json');
    const before = await readFile(summaryPath, 'utf8');
    summaryFlushes = 0;
    const diagnostic = { ...metric, metric_kind: 'turn_telemetry', turns: 0, tool_calls: 0, usage: zeroUsage };
    for (const id of ['diagnostic-1', 'diagnostic-2']) {
      const persisted = await repository.writeEntity(location, 'metrics/turns', id, diagnostic);
      expect(JSON.parse(await readFile(persisted, 'utf8'))).toEqual(diagnostic);
    }
    expect(summaryFlushes).toBe(0);
    expect(await readFile(summaryPath, 'utf8')).toBe(before);
    await repository.writeEntity(location, 'metrics/turns', 'diagnostic-2', {
      ...diagnostic, usage: { ...zeroUsage, input_tokens: 3 },
    });
    expect(repository.readMetricsSummarySync(location)).toMatchObject({ turns: 1, tool_calls: 1, tokens: { input: 13 } });
    expect(summaryFlushes).toBe(1);
    await repository.writeEntity(location, 'metrics/provider_attempts', 'attempt-1', { schema_version: 1 });
    expect(repository.readMetricsSummarySync(location).provider_attempts).toBe(1);
    expect(summaryFlushes).toBe(2);
    await repository.rebuildMetricsSummary(location);
    expect(repository.readMetricsSummarySync(location)).toMatchObject({ turns: 1, provider_attempts: 1, tokens: { input: 13 } });
  });

  it('rebuilds hot metric totals after a lost acknowledgement of the metric rename', async () => {
    let failRename = false;
    const { repository } = await fixture({ faultInjector: async (context) => {
      if (failRename && context.point === 'atomic:after-rename-before-directory-fsync'
        && context.path?.endsWith('turn-2.json')) {
        failRename = false;
        throw new Error('metric acknowledgement lost');
      }
    } });
    const { location } = await repository.createSession({ kind: 'coder', scope: { kind: 'project', project_id: 1 } });
    const metric = (seq: number) => ({ schema_version: 1, turn_seq: seq, message_seq: seq,
      turns: 1, tool_calls: 0,
      usage: { input_tokens: 10, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
      subagent_usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
    });
    await repository.writeEntity(location, 'metrics/turns', 'turn-1', metric(1));
    failRename = true;
    await expect(repository.writeEntity(location, 'metrics/turns', 'turn-2', metric(2)))
      .rejects.toThrow('metric acknowledgement lost');
    await repository.writeEntity(location, 'metrics/turns', 'turn-3', metric(3));
    expect(repository.readMetricsSummarySync(location)).toMatchObject({ turns: 3, tokens: { input: 30 } });
  });

  it('invalidates hot metric totals after a rollback projection batch', async () => {
    const { repository } = await fixture();
    const { location } = await repository.createSession({ kind: 'coder', scope: { kind: 'project', project_id: 1 } });
    const metric = (seq: number, tokens: number) => ({ schema_version: 1, turn_seq: seq,
      message_seq: seq, turns: 1, tool_calls: 0,
      usage: { input_tokens: tokens, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
      subagent_usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
    });
    await repository.writeEntity(location, 'metrics/turns', 'turn-1', metric(1, 10));
    await repository.writeEntity(location, 'metrics/turns', 'turn-2', metric(2, 20));
    expect(repository.readMetricsSummarySync(location).tokens.input).toBe(30);
    await repository.updateProjectionBatch(location, { entities: [{ directory: 'metrics/turns', id: 'turn-3',
      value: { ...metric(3, 0), turns: 0, truncate_from_message_seq: 2 },
    }] });
    await repository.writeEntity(location, 'metrics/turns', 'turn-4', metric(4, 5));
    expect(repository.readMetricsSummarySync(location).tokens.input).toBe(15);
    expect(repository.readMetricsSummarySync(location).turns).toBe(2);
  });

  it('advances cached writer projections once per commit and rejects external changes', async () => {
    const { repository } = await fixture();
    const created = await repository.createSession({ kind: 'coder', scope: { kind: 'project', project_id: 1 } });
    const projection = {
      create: vi.fn(() => ({ count: 0 })),
      apply: vi.fn((state: { count: number }) => { state.count++; }),
    };
    await repository.commitTurn(created.location, { operation_id: 'one', payload: { text: 'one' } });
    expect(await repository.readWriterProjection(created.location, projection)).toEqual({ count: 1 });
    await repository.readWriterProjection(created.location, projection);
    await repository.commitTurn(created.location, { operation_id: 'two', payload: { text: 'two' } });
    expect(await repository.readWriterProjection(created.location, projection)).toEqual({ count: 2 });
    expect(projection.create).toHaveBeenCalledTimes(1);
    expect(projection.apply).toHaveBeenCalledTimes(2);
    await appendFile(join(created.location.bundle_path, 'journal.jsonl'), 'unexpected\n');
    await expect(repository.readWriterProjection(created.location, projection)).rejects.toThrow('Journal changed');
    await expect(repository.commitTurn(created.location, { operation_id: 'three', payload: {} })).rejects.toThrow('Journal changed');
  });

  it('rejects an empty MCP data root instead of resolving it to cwd', () => {
    expect(
      () =>
        new SessionLocator({
          dataDir: '   ',
          projectRootResolver: {
            resolveProjectRoot: () => null,
            listProjectRoots: () => [],
          },
        }),
    ).toThrow(SessionRootUnavailableError);
  });

  it('rejects empty catalog roots instead of resolving them to the process cwd', async () => {
    const base = mkdtempSync(join(tmpdir(), 'mcp-session-empty-root-'));
    const dataDir = join(base, 'data');
    await mkdir(dataDir);
    const locator = new SessionLocator({
      dataDir,
      projectRootResolver: {
        resolveProjectRoot: () => '',
        listProjectRoots: () => [{ project_id: 1, root_path: '' }],
      },
    });

    expect(() => locator.resolveProjectRoot(1)).toThrow(SessionRootUnavailableError);
    expect(() => locator.sessionRoot({ kind: 'project', project_id: 1 })).toThrow(
      SessionRootUnavailableError,
    );
    expect(locator.listProjectRoots()).toEqual([]);
    expect(locator.allKnownSessionRoots()).toEqual([
      {
        scope: { kind: 'global' },
        session_root: join(dataDir, 'sessions', 'global'),
      },
    ]);
    await rm(base, { recursive: true, force: true });
  });

  it('publishes compound projections in one concurrent durability wave', async () => {
    let batchActive = false;
    let arrivals = 0;
    let releaseBatch!: () => void;
    const batchGate = new Promise<void>((resolve) => {
      releaseBatch = resolve;
    });
    const { repository } = await fixture({
      faultInjector: async (context) => {
        if (
          batchActive &&
          context.point === 'atomic:after-temp-write-before-fsync' &&
          !context.path?.replaceAll('\\', '/').endsWith('/events/writer.lease')
        ) {
          arrivals += 1;
          if (arrivals === 4) releaseBatch();
          await batchGate;
        }
      },
    });
    const created = await repository.createSession({
      kind: 'coder',
      scope: { kind: 'project', project_id: 1 },
    });
    const sessionPath = join(created.location.bundle_path, 'session.json');
    const sessionBeforeDeferredCommit = await readFile(sessionPath, 'utf8');
    await repository.commitTurn(created.location, {
      operation_id: 'compound-canonical-turn',
      payload: { compound: true },
      touch_session: false,
    });
    expect(await readFile(sessionPath, 'utf8')).toBe(
      sessionBeforeDeferredCommit,
    );

    const eventId = newSessionId();
    batchActive = true;
    await repository.updateProjectionBatch(created.location, {
      update_session: (current) => ({ ...current, title: 'Projected' }),
      update_state: (current) => ({ ...current, status: 'idle' }),
      entities: [{
        directory: 'events',
        id: eventId,
        value: { schema_version: 1, kind: 'projection-test' },
      }],
      metrics_summary: emptySessionMetricsSummary(),
    });
    expect(arrivals).toBe(4);
    expect(repository.readSessionSync(created.location).title).toBe('Projected');
    await expect(
      readFile(
        join(created.location.bundle_path, 'events', `${eventId}.json`),
        'utf8',
      ),
    ).resolves.toContain('"projection-test"');
  });

  it('publishes the complete versioned bundle and exposes safe synchronous reads', async () => {
    const { repository, projectRoots } = await fixture();
    const created = await repository.createSession({
      kind: 'coder',
      scope: { kind: 'project', project_id: 1 },
      title: 'Filesystem session',
      linked_projects: [{ project_id: 1, root_path: projectRoots[0].root_path }],
      metadata: { source: 'test' },
    });

    expect(SESSION_LAYOUT_VERSION).toBe(1);
    expect(created.location.bundle_path).toBe(
      join(projectRoots[0].root_path, '.mcp-indexer', 'session', created.session.id),
    );
    await expect(stat(join(created.location.bundle_path, 'session.json'))).resolves.toMatchObject({ size: expect.any(Number) });
    await expect(stat(join(created.location.bundle_path, 'state.json'))).resolves.toMatchObject({ size: expect.any(Number) });
    await expect(stat(join(created.location.bundle_path, 'conversation.jsonl'))).resolves.toMatchObject({ size: 0 });
    await expect(stat(join(created.location.bundle_path, 'journal.jsonl'))).resolves.toMatchObject({ size: 0 });
    await expect(stat(join(created.location.bundle_path, 'migration.json'))).resolves.toMatchObject({ size: expect.any(Number) });
    for (const directory of SESSION_BUNDLE_DIRECTORIES) {
      await expect(stat(join(created.location.bundle_path, ...directory.split('/')))).resolves.toMatchObject({
        size: expect.any(Number),
      });
    }
    expect(repository.readSessionSync(created.location)).toMatchObject({
      schema_version: 1,
      id: created.session.id,
      kind: 'coder',
    });
    expect(repository.readStateSync(created.location)).toMatchObject({
      schema_version: 1,
      status: 'idle',
    });
    expect(repository.readConversationSync(created.location)).toEqual([]);
  });

  it('reuses metrics projections while detecting external worker updates', async () => {
    const { repository } = await fixture();
    const created = await repository.createSession({
      kind: 'coder',
      scope: { kind: 'project', project_id: 1 },
    });
    expect(repository.readMetricsSummarySync(created.location).tokens.input).toBe(0);

    const summaryPath = join(
      created.location.bundle_path,
      'metrics',
      'summary.json',
    );
    const updated = {
      ...emptySessionMetricsSummary('2026-08-02T12:00:00.000Z'),
      tokens: {
        input: 7,
        output: 3,
        cache_read: 2,
        cache_creation: 1,
      },
    };
    await writeFile(summaryPath, `${JSON.stringify(updated)}\n`);
    const timestamp = new Date(Date.now() + 2_000);
    await utimes(summaryPath, timestamp, timestamp);

    expect(repository.readMetricsSummarySync(created.location).tokens).toEqual(
      updated.tokens,
    );
  });

  it('persists independent initial projections in one concurrent write wave', async () => {
    let arrivals = 0;
    let arrivalsWhenReleased = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { repository } = await fixture({
      faultInjector: async ({ point, session_id }) => {
        if (point !== 'atomic:before-temp-write' || session_id === undefined) return;
        arrivals += 1;
        if (arrivals === 6) {
          arrivalsWhenReleased = arrivals;
          release();
        }
        await barrier;
      },
    });
    const watchdog = setTimeout(() => {
      arrivalsWhenReleased = arrivals;
      release();
    }, 1_000);

    await repository.createSession({
      kind: 'coder',
      scope: { kind: 'project', project_id: 1 },
    });
    clearTimeout(watchdog);

    expect(arrivals).toBe(6);
    expect(arrivalsWhenReleased).toBe(6);
  });

  it('catalog scans project and global roots without creating a persistent index', async () => {
    const { repository, locator } = await fixture();
    const project = await repository.createSession({
      kind: 'coder',
      scope: { kind: 'project', project_id: 1 },
      title: 'Project',
    });
    const global = await repository.createSession({
      kind: 'global',
      scope: { kind: 'global' },
      title: 'Global',
    });
    const catalog = new SessionCatalog({ locator, repository });
    const scan = await catalog.refresh();

    expect(scan.issues).toHaveLength(1); // project 2 has never created its session root
    expect(catalog.get(project.session.id)?.location.bundle_path).toBe(project.location.bundle_path);
    expect(catalog.get(global.session.id)?.location.bundle_path).toBe(global.location.bundle_path);
    expect(catalog.list()).toHaveLength(2);
    await expect(stat(join(locator.sessionRoot({ kind: 'global' }), 'catalog.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    catalog.close();
  });

  it('refreshes a catalog projection after another writer updates the bundle', async () => {
    const { repository, locator } = await fixture();
    const created = await repository.createSession({
      kind: 'coder',
      scope: { kind: 'project', project_id: 1 },
    });
    const catalog = new SessionCatalog({ locator, repository });
    await catalog.refresh();
    expect(catalog.get(created.session.id)?.state?.status).toBe('idle');

    const workerRepository = new FileSessionRepository({
      locator,
      writerOwnerId: 'coder-worker:test-refresh',
    });
    try {
      await workerRepository.updateState(created.location, (state) => ({
        ...state,
        status: 'updated-by-worker',
      }));
      await workerRepository.closeSession(created.location);

      expect(catalog.get(created.session.id)?.state?.status).toBe('idle');
      repository.refreshSessionProjection(created.location);
      expect(catalog.get(created.session.id)?.state?.status).toBe(
        'updated-by-worker',
      );
    } finally {
      catalog.close();
      await workerRepository.close();
    }
  });

  it('shares one initial catalog scan across concurrent consumers', async () => {
    const { locator, repository } = await fixture();
    const catalog = new SessionCatalog({ locator, repository });
    const rootsScan = vi.spyOn(locator, 'allKnownSessionRoots');
    try {
      await Promise.all([
        catalog.ensureReady(),
        catalog.ensureReady(),
        catalog.ensureReady(),
      ]);
      await catalog.ensureReady();
      expect(rootsScan).toHaveBeenCalledTimes(1);

      await catalog.refresh();
      expect(rootsScan).toHaveBeenCalledTimes(2);
    } finally {
      catalog.close();
    }
  });

  it('quarantines a duplicated session UUID across roots until a full refresh resolves it', async () => {
    const { repository, locator } = await fixture();
    const first = await repository.createSession({
      kind: 'coder',
      scope: { kind: 'project', project_id: 1 },
    });
    await repository.createSession({
      id: first.session.id,
      kind: 'coder',
      scope: { kind: 'project', project_id: 2 },
    });
    const catalog = new SessionCatalog({ locator, repository });

    const scan = await catalog.refresh();
    expect(catalog.get(first.session.id)).toBeNull();
    expect(catalog.list()).toEqual([]);
    expect(
      scan.issues.filter((issue) => issue.code === 'DUPLICATE_SESSION_UUID'),
    ).toHaveLength(2);

    await repository.updateState(first.location, (current) => ({
      ...current,
      status: 'updated-but-still-quarantined',
    }));
    expect(catalog.get(first.session.id)).toBeNull();
    catalog.close();
  });
});

describe('writer ordering and fencing', () => {
  it('serializes concurrent commands in one session with a valid seq/hash chain', async () => {
    const { repository } = await fixture();
    const created = await repository.createSession({
      kind: 'coder',
      scope: { kind: 'project', project_id: 1 },
    });

    const committed = await Promise.all(
      Array.from({ length: 32 }, (_, index) =>
        repository.commitTurn(created.location, {
          operation_id: `turn-${index}`,
          payload: { index },
        }),
      ),
    );
    expect(new Set(committed.map((record) => record.seq)).size).toBe(32);

    const records = repository.readConversationSync(created.location);
    expect(records.map((record) => record.seq)).toEqual(Array.from({ length: 32 }, (_, index) => index + 1));
    expect(records[0].prev_hash).toBeNull();
    for (let index = 1; index < records.length; index += 1) {
      expect(records[index].prev_hash).toBe(records[index - 1].hash);
    }
  });

  it('keeps the published writer lease valid while an atomic refresh is pending', async () => {
    let holdRefresh = false;
    let refreshHeld = false;
    let signalRefreshHeld!: () => void;
    let releaseRefresh!: () => void;
    const refreshReached = new Promise<void>((resolve) => {
      signalRefreshHeld = resolve;
    });
    const refreshReleased = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const { repository } = await fixture({
      leaseTtlMs: 1_000,
      faultInjector: async (context) => {
        if (
          holdRefresh &&
          !refreshHeld &&
          context.point === 'atomic:after-temp-fsync-before-rename' &&
          context.path?.replaceAll('\\', '/').endsWith('/events/writer.lease')
        ) {
          refreshHeld = true;
          signalRefreshHeld();
          await refreshReleased;
        }
      },
    });
    const created = await repository.createSession({
      kind: 'coder',
      scope: { kind: 'project', project_id: 1 },
    });
    await repository.primeSession(created.location);
    holdRefresh = true;

    const update = repository.updateState(created.location, (current) => ({
      ...current,
      status: 'lease-refresh-tested',
    }));
    try {
      await Promise.race([
        refreshReached,
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error('Timed out waiting for the lease refresh')), 2_000);
        }),
      ]);

      const leasePath = join(
        created.location.bundle_path,
        'events',
        'writer.lease',
      );
      for (let index = 0; index < 32; index += 1) {
        const lease = JSON.parse(await readFile(leasePath, 'utf8')) as {
          token?: string;
          fence?: number;
          expires_at?: string;
        };
        expect(lease.token).toBeTypeOf('string');
        expect(lease.fence).toBeTypeOf('number');
        expect(Date.parse(lease.expires_at ?? '')).not.toBeNaN();
      }
    } finally {
      releaseRefresh();
    }

    await update;
    expect(refreshHeld).toBe(true);
  });

  it('lets different sessions reach append concurrently', async () => {
    let arrivals = 0;
    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const hook: SessionStorageFaultInjector = async ({ point }) => {
      if (point !== 'conversation:before-append') return;
      arrivals += 1;
      if (arrivals === 2) releaseBarrier();
      await barrier;
    };
    const { repository } = await fixture({ faultInjector: hook });
    const [first, second] = await Promise.all([
      repository.createSession({ kind: 'coder', scope: { kind: 'project', project_id: 1 } }),
      repository.createSession({ kind: 'coder', scope: { kind: 'project', project_id: 2 } }),
    ]);

    await Promise.all([
      repository.commitTurn(first.location, { operation_id: 'first', payload: { session: 1 } }),
      repository.commitTurn(second.location, { operation_id: 'second', payload: { session: 2 } }),
    ]);
    expect(arrivals).toBe(2);
  });

  it('commits dozens of project sessions without cross-session ordering', async () => {
    const { repository } = await fixture();
    const sessions = await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        repository.createSession({
          kind: 'coder',
          scope: {
            kind: 'project',
            project_id: index % 2 === 0 ? 1 : 2,
          },
        }),
      ),
    );

    const committed = await Promise.all(
      sessions.map((session, index) =>
        repository.commitTurn(session.location, {
          operation_id: `independent-${index}`,
          payload: { index },
        }),
      ),
    );

    expect(committed).toHaveLength(24);
    expect(committed.every((record) => record.seq === 1)).toBe(true);
  });

  it('rejects a duplicate live writer until the lease is released', async () => {
    const firstFixture = await fixture();
    const created = await firstFixture.repository.createSession({
      kind: 'coder',
      scope: { kind: 'project', project_id: 1 },
    });
    await firstFixture.repository.commitTurn(created.location, {
      operation_id: 'owner',
      payload: { writer: 1 },
    });

    const contender = new FileSessionRepository({ locator: firstFixture.locator });
    await expect(
      contender.commitTurn(created.location, {
        operation_id: 'contender',
        payload: { writer: 2 },
      }),
    ).rejects.toBeInstanceOf(SessionLeaseHeldError);

    await firstFixture.repository.closeSession(created.location);
    await expect(
      contender.commitTurn(created.location, {
        operation_id: 'contender',
        payload: { writer: 2 },
      }),
    ).resolves.toMatchObject({ seq: 2 });
    await contender.close();
  });

  it('does not steal an expired lease from a live writer and rechecks the fence immediately before append', async () => {
    let appendReached!: () => void;
    let resumeAppend!: () => void;
    const reached = new Promise<void>((resolve) => {
      appendReached = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      resumeAppend = resolve;
    });
    const firstFixture = await fixture({
      leaseTtlMs: 1_000,
      faultInjector: async (context) => {
        if (
          context.point === 'conversation:before-append' &&
          context.operation_id === 'paused-owner'
        ) {
          appendReached();
          await resume;
        }
      },
    });
    const created = await firstFixture.repository.createSession({
      kind: 'coder',
      scope: { kind: 'project', project_id: 1 },
    });
    const ownerCommit = firstFixture.repository.commitTurn(created.location, {
      operation_id: 'paused-owner',
      payload: { writer: 'owner' },
    });
    await reached;

    const leasePath = join(
      created.location.bundle_path,
      'events',
      'writer.lease',
    );
    const lease = JSON.parse(await readFile(leasePath, 'utf8')) as {
      expires_at: string;
    };
    await writeFile(
      leasePath,
      `${JSON.stringify({
        ...lease,
        expires_at: new Date(Date.now() - 1_000).toISOString(),
      })}\n`,
    );

    const contender = new FileSessionRepository({
      locator: firstFixture.locator,
      leaseTtlMs: 1_000,
    });
    await expect(
      contender.commitTurn(created.location, {
        operation_id: 'contender-after-expiry',
        payload: { writer: 'contender' },
      }),
    ).rejects.toBeInstanceOf(SessionLeaseHeldError);

    resumeAppend();
    await expect(ownerCommit).rejects.toBeInstanceOf(SessionFenceLostError);
    expect(firstFixture.repository.readConversationSync(created.location)).toEqual([]);
    await contender.close();
  });

  it('fails closed instead of stealing an old lease whose owner cannot be validated', async () => {
    const { repository, locator } = await fixture({ leaseTtlMs: 1_000 });
    const created = await repository.createSession({
      kind: 'coder',
      scope: { kind: 'project', project_id: 1 },
    });
    await repository.closeSession(created.location);
    const leasePath = join(
      created.location.bundle_path,
      'events',
      'writer.lease',
    );
    await writeFile(leasePath, '{"corrupt":');
    const old = new Date(Date.now() - 60_000);
    await utimes(leasePath, old, old);

    const contender = new FileSessionRepository({
      locator,
      leaseTtlMs: 1_000,
      artifactRecoveryRegistry: new Set(),
    });
    await expect(
      contender.primeSession(created.location),
    ).rejects.toBeInstanceOf(SessionLeaseHeldError);
    await contender.close();
  });

  it('treats an isolate that exited before creating its events directory as having no lease', async () => {
    const { base } = await fixture();
    const bundlePath = join(base, 'unfinished');
    await mkdir(bundlePath);
    await expect(releaseSessionWriterLeaseForOwner({ bundlePath, ownerId: 'exited-before-open' })).resolves.toBe(false);
    expect(await readdir(bundlePath)).toEqual([]);
  });

  it('reclaims only the lease owned by the coordinator-confirmed dead isolate', async () => {
    const ownerId = 'coder-worker:test-owner';
    const { repository, locator } = await fixture({ writerOwnerId: ownerId });
    const created = await repository.createSession({
      kind: 'coder',
      scope: { kind: 'project', project_id: 1 },
    });
    await repository.commitTurn(created.location, {
      operation_id: 'dead-owner-turn',
      payload: { writer: 'dead-owner' },
    });
    const leasePath = join(
      created.location.bundle_path,
      'events',
      'writer.lease',
    );
    await expect(readFile(leasePath, 'utf8')).resolves.toContain(
      `"owner_id":"${ownerId}"`,
    );

    await expect(
      releaseSessionWriterLeaseForOwner({
        bundlePath: created.location.bundle_path,
        ownerId: 'coder-worker:different-owner',
      }),
    ).resolves.toBe(false);
    await expect(stat(leasePath)).resolves.toBeDefined();

    await expect(
      releaseSessionWriterLeaseForOwner({
        bundlePath: created.location.bundle_path,
        ownerId,
      }),
    ).resolves.toBe(true);
    await expect(stat(leasePath)).rejects.toMatchObject({ code: 'ENOENT' });

    const replacement = new FileSessionRepository({ locator });
    await expect(
      replacement.commitTurn(created.location, {
        operation_id: 'replacement-after-crash',
        payload: { writer: 'replacement' },
      }),
    ).resolves.toMatchObject({ seq: 2 });
    await replacement.close();
  });
});

describe('idempotency and crash recovery', () => {
  for (const point of [
    'conversation:before-append',
    'conversation:after-write-before-fsync',
    'conversation:after-append',
  ] as const) {
    it(`replays without duplication after ${point}`, async () => {
      let injected = false;
      const { repository } = await fixture({
        faultInjector: async (context) => {
          if (!injected && context.point === point) {
            injected = true;
            throw new Error(`injected ${point}`);
          }
        },
      });
      const created = await repository.createSession({
        kind: 'coder',
        scope: { kind: 'project', project_id: 1 },
      });
      const input = {
        operation_id: `fault-${point}`,
        payload: { point },
      } as const;

      await expect(repository.commitTurn(created.location, input))
        .rejects.toThrow(`injected ${point}`);
      expect(injected).toBe(true);

      const replay = await repository.commitTurn(created.location, input);
      expect(replay.seq).toBe(1);
      expect(repository.readConversationSync(created.location)).toHaveLength(1);
    });
  }

  for (const point of [
    'artifact:before-write',
    'artifact:after-write',
  ] as const) {
    it(`retries the artifact-before-journal protocol after ${point}`, async () => {
      let injected = false;
      const { repository } = await fixture({
        faultInjector: async (context) => {
          if (!injected && context.point === point) {
            injected = true;
            throw new Error(`injected ${point}`);
          }
        },
      });
      const created = await repository.createSession({
        kind: 'coder',
        scope: { kind: 'project', project_id: 1 },
      });
      const input = {
        operation_id: `artifact-fault-${point}`,
        payload: { role: 'user', content: [{ type: 'artifact_ref' }] },
        artifacts: [{
          kind: 'attachment' as const,
          data: Buffer.from('fault-safe artifact'),
          media_type: 'application/octet-stream',
          logical_name: 'fault.bin',
        }],
      };

      await expect(repository.commitTurn(created.location, input))
        .rejects.toThrow(`injected ${point}`);
      expect(injected).toBe(true);
      expect(repository.readConversationSync(created.location)).toEqual([]);

      const committed = await repository.commitTurn(created.location, input);
      expect(committed.seq).toBe(1);
      expect(committed.artifacts).toHaveLength(1);
      const artifacts = new ArtifactStore({
        bundlePath: created.location.bundle_path,
        sessionId: created.session.id,
      });
      expect(artifacts.read(committed.artifacts[0]))
        .toEqual(Buffer.from('fault-safe artifact'));
      await expect(artifacts.readAsync(committed.artifacts[0]))
        .resolves.toEqual(Buffer.from('fault-safe artifact'));
      expect(repository.readConversationSync(created.location)).toHaveLength(1);
    });
  }

  it('deduplicates operation_id and rejects reuse with different input', async () => {
    const { repository } = await fixture();
    const created = await repository.createSession({
      kind: 'coder',
      scope: { kind: 'project', project_id: 1 },
    });
    const input = { operation_id: 'same-operation', payload: { message: 'same' } } as const;

    const [first, replay] = await Promise.all([
      repository.commitTurn(created.location, input),
      repository.commitTurn(created.location, input),
    ]);
    expect(replay).toEqual(first);
    expect(repository.readConversationSync(created.location)).toHaveLength(1);
    await expect(
      repository.commitTurn(created.location, {
        operation_id: 'same-operation',
        payload: { message: 'different' },
      }),
    ).rejects.toBeInstanceOf(SessionOperationConflictError);
  });

  it('truncates only the uncommitted final JSONL fragment on reopen', async () => {
    const { repository, locator } = await fixture();
    const created = await repository.createSession({
      kind: 'coder',
      scope: { kind: 'project', project_id: 1 },
    });
    await repository.commitTurn(created.location, {
      operation_id: 'complete',
      payload: { complete: true },
    });
    await repository.closeSession(created.location);
    const conversationPath = join(created.location.bundle_path, 'journal.jsonl');
    await appendFile(conversationPath, '{"schema_version":1,"seq":2,"operation_id":"partial"');
    const committed = repository.readConversationSync(created.location);
    expect(committed).toHaveLength(1);
    expect(await repository.readConversation(created.location)).toEqual(committed);

    const reopened = new FileSessionRepository({ locator });
    const next = await reopened.commitTurn(created.location, {
      operation_id: 'after-recovery',
      payload: { recovered: true },
    });
    expect(next.seq).toBe(2);
    const bytes = await readFile(conversationPath, 'utf8');
    expect(bytes.endsWith('\n')).toBe(true);
    expect(bytes).not.toContain('"operation_id":"partial"');
    await reopened.close();
  });

  it('rejects a modified committed record on both asynchronous and synchronous reads', async () => {
    const { repository } = await fixture();
    const { location } = await repository.createSession({ kind: 'coder', scope: { kind: 'project', project_id: 1 } });
    await repository.commitTurn(location, { operation_id: 'record', payload: { text: 'original' } });
    await repository.closeSession(location);
    const path = join(location.bundle_path, 'journal.jsonl');
    const original = await readFile(path, 'utf8');
    await writeFile(path, original.replace('original', 'modified'));
    await expect(repository.readConversation(location)).rejects.toThrow('hash mismatch at seq 1');
    expect(() => repository.readConversationSync(location)).toThrow('hash mismatch at seq 1');
  });

  it('persists artifacts before exposing their conversation commit', async () => {
    let failAppend = true;
    let artifactPath: string | undefined;
    const events: string[] = [];
    const faultInjector = async (context: SessionStorageFaultContext): Promise<void> => {
      events.push(context.point);
      if (context.point === 'artifact:after-write') artifactPath = context.path;
      if (context.point === 'conversation:before-append' && failAppend) {
        failAppend = false;
        throw new Error('injected append failure');
      }
    };
    const { repository } = await fixture({ faultInjector });
    const created = await repository.createSession({
      kind: 'coder',
      scope: { kind: 'project', project_id: 1 },
    });
    const turn = {
      operation_id: 'artifact-turn',
      payload: { role: 'user', content: [{ type: 'artifact_ref' }] },
      artifacts: [
        {
          kind: 'attachment' as const,
          data: Buffer.from('attachment bytes'),
          media_type: 'application/octet-stream',
          logical_name: 'input.bin',
        },
      ],
    };

    await expect(repository.commitTurn(created.location, turn)).rejects.toThrow('injected append failure');
    expect(repository.readConversationSync(created.location)).toEqual([]);
    expect(artifactPath).toBeTruthy();
    await expect(readFile(artifactPath!)).resolves.toEqual(Buffer.from('attachment bytes'));
    expect(events.indexOf('artifact:after-write')).toBeLessThan(events.indexOf('conversation:before-append'));

    const committed = await repository.commitTurn(created.location, turn);
    expect(committed.seq).toBe(1);
    expect(committed.artifacts).toHaveLength(1);
    const store = new ArtifactStore({
      bundlePath: created.location.bundle_path,
      sessionId: created.session.id,
    });
    expect(store.read(committed.artifacts[0])).toEqual(Buffer.from('attachment bytes'));
  });

  it('hashes opaque tool call filenames and preserves payload media types', async () => {
    const { repository } = await fixture();
    const created = await repository.createSession({
      kind: 'coder',
      scope: { kind: 'project', project_id: 1 },
    });
    const callId = 'CON:provider/call-1';
    const record = await repository.writeToolOutput(created.location, {
      call_id: callId,
      raw: 'raw',
      shaped: '{"answer":true}',
      raw_media_type: 'text/plain; charset=utf-8',
      shaped_media_type: 'application/json',
    });

    expect(record.raw?.media_type).toBe('text/plain; charset=utf-8');
    expect(record.shaped?.media_type).toBe('application/json');
    expect(record.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    const metadataPath = join(
      created.location.bundle_path,
      'tools_outputs',
      'calls',
      toolOutputRecordFileName(callId),
    );
    expect(JSON.parse(await readFile(metadataPath, 'utf8'))).toMatchObject({
      call_id: callId,
    });

    const replay = await repository.writeToolOutput(created.location, {
      call_id: callId,
      raw: 'raw',
      shaped: '{"answer":true}',
      raw_media_type: 'text/plain; charset=utf-8',
      shaped_media_type: 'application/json',
    });
    expect(replay).toEqual(record);

    await expect(
      repository.writeToolOutput(created.location, {
        call_id: callId,
        raw: 'different raw bytes',
        shaped: '{"answer":true}',
        raw_media_type: 'text/plain; charset=utf-8',
        shaped_media_type: 'application/json',
      }),
    ).rejects.toBeInstanceOf(ToolOutputConflictError);
    expect(JSON.parse(await readFile(metadataPath, 'utf8'))).toEqual(record);
  });

  it('collects abandoned atomic temp files only after acquiring the session lease', async () => {
    const { repository } = await fixture();
    const created = await repository.createSession({
      kind: 'coder',
      scope: { kind: 'project', project_id: 1 },
    });
    const abandoned = join(
      created.location.bundle_path,
      '.state.json.tmp-999-11111111-1111-4111-8111-111111111111',
    );
    await writeFile(abandoned, 'uncommitted');

    await repository.commitTurn(created.location, {
      operation_id: 'collect-temp',
      payload: { safe: true },
    });
    await expect(stat(abandoned)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removes an attachment orphaned by a crash before the conversation commit', async () => {
    let orphanPath: string | undefined;
    let failCommit = true;
    const { repository, locator } = await fixture({
      faultInjector: async (context) => {
        if (context.point === 'artifact:after-write') {
          orphanPath = context.path;
        }
        if (context.point === 'conversation:before-append' && failCommit) {
          failCommit = false;
          throw new Error('simulated process crash before commit');
        }
      },
    });
    const created = await repository.createSession({
      kind: 'coder',
      scope: { kind: 'project', project_id: 1 },
    });
    await expect(
      repository.commitTurn(created.location, {
        operation_id: 'orphan-before-turn',
        payload: { type: 'test' },
        artifacts: [{
          kind: 'attachment',
          data: 'unreferenced after crash',
        }],
      }),
    ).rejects.toThrow('simulated process crash before commit');
    expect(orphanPath).toBeTruthy();
    await repository.closeSession(created.location);

    const restarted = new FileSessionRepository({
      locator,
      artifactRecoveryRegistry: new Set(),
    });
    await restarted.primeSession(created.location);
    await expect(stat(orphanPath!)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(restarted.readConversationSync(created.location)).toEqual([]);
    await restarted.close();
  });

  it('removes a tool blob orphaned before tool-call metadata is published', async () => {
    let orphanPath: string | undefined;
    let failWrite = true;
    const { repository, locator } = await fixture({
      faultInjector: async (context) => {
        if (context.point === 'artifact:after-write' && failWrite) {
          failWrite = false;
          orphanPath = context.path;
          throw new Error('simulated process crash before tool metadata');
        }
      },
    });
    const created = await repository.createSession({
      kind: 'coder',
      scope: { kind: 'project', project_id: 1 },
    });
    await expect(
      repository.writeToolOutput(created.location, {
        call_id: 'crashed-tool',
        raw: 'unreferenced raw output',
      }),
    ).rejects.toThrow('simulated process crash before tool metadata');
    expect(orphanPath).toBeTruthy();
    await repository.closeSession(created.location);

    const restarted = new FileSessionRepository({
      locator,
      artifactRecoveryRegistry: new Set(),
    });
    await restarted.primeSession(created.location);
    await expect(stat(orphanPath!)).rejects.toMatchObject({ code: 'ENOENT' });
    await restarted.close();
  });

  it('removes published tool metadata that never reached the conversation journal', async () => {
    const { repository, locator } = await fixture();
    const created = await repository.createSession({
      kind: 'coder',
      scope: { kind: 'project', project_id: 1 },
    });
    const record = await repository.writeToolOutput(created.location, {
      call_id: 'metadata-without-turn',
      raw: 'published but unreachable',
    });
    const metadataPath = join(
      created.location.bundle_path,
      'tools_outputs',
      'calls',
      toolOutputRecordFileName('metadata-without-turn'),
    );
    const blobPath = join(
      created.location.bundle_path,
      ...record.raw!.relative_path.split('/'),
    );
    await repository.closeSession(created.location);

    const restarted = new FileSessionRepository({
      locator,
      artifactRecoveryRegistry: new Set(),
    });
    await restarted.primeSession(created.location);
    await expect(stat(metadataPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(blobPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await restarted.close();
  });

  it('keeps explicitly standalone get_tool_output spills until session deletion', async () => {
    const { repository, locator } = await fixture();
    const created = await repository.createSession({
      kind: 'coder',
      scope: { kind: 'project', project_id: 1 },
    });
    const outputId = 'abcdef0123456789abcdef01';
    const record = await repository.writeToolOutput(created.location, {
      call_id: `spill:${outputId}`,
      raw: 'durable standalone spill',
      metadata: {
        purpose: 'truncated_tool_output',
        output_id: outputId,
      },
    });
    await repository.closeSession(created.location);

    const restarted = new FileSessionRepository({
      locator,
      artifactRecoveryRegistry: new Set(),
    });
    await restarted.primeSession(created.location);
    expect(
      new ArtifactStore({
        bundlePath: created.location.bundle_path,
        sessionId: created.session.id,
      }).read(record.raw!),
    ).toEqual(Buffer.from('durable standalone spill'));
    await restarted.close();
  });

  it('primes once before direct puts and preserves blobs referenced afterwards', async () => {
    const { repository, locator } = await fixture();
    const created = await repository.createSession({
      kind: 'design',
      scope: { kind: 'project', project_id: 1 },
      metadata: {
        design: {
          sourceZipRef: null,
        },
      },
    });
    const unsafePreCrashStore = new ArtifactStore({
      bundlePath: created.location.bundle_path,
      sessionId: created.session.id,
    });
    const oldOrphan = await unsafePreCrashStore.put({
      kind: 'attachment',
      data: 'old orphan',
    });
    const oldOrphanPath = join(
      created.location.bundle_path,
      ...oldOrphan.relative_path.split('/'),
    );
    await repository.closeSession(created.location);

    const restarted = new FileSessionRepository({
      locator,
      artifactRecoveryRegistry: new Set(),
    });
    const safeStore = await restarted.artifactStore(created.location);
    await expect(stat(oldOrphanPath)).rejects.toMatchObject({ code: 'ENOENT' });
    const referenced = await safeStore.put({
      kind: 'attachment',
      data: 'new source zip',
      media_type: 'application/zip',
    });
    await restarted.updateSession(created.location, (current) => ({
      ...current,
      metadata: {
        ...current.metadata,
        design: {
          sourceZipRef: referenced as unknown as JsonValue,
        },
      },
    }));
    await restarted.close();

    const secondRestart = new FileSessionRepository({
      locator,
      artifactRecoveryRegistry: new Set(),
    });
    await secondRestart.primeSession(created.location);
    expect(
      new ArtifactStore({
        bundlePath: created.location.bundle_path,
        sessionId: created.session.id,
      }).read(referenced),
    ).toEqual(Buffer.from('new source zip'));
    await secondRestart.close();
  });

  it('uses schema-owned paths for migrated refs and ignores arbitrary JSON fields', async () => {
    const { repository, locator } = await fixture();
    const created = await repository.createSession({
      kind: 'coder',
      scope: { kind: 'project', project_id: 1 },
    });
    const store = new ArtifactStore({
      bundlePath: created.location.bundle_path,
      sessionId: created.session.id,
    });
    const [spill, baseline, transcript, driveFile, orphan] = await Promise.all([
      store.put({ kind: 'tool_output_raw', data: 'legacy spill' }),
      store.put({ kind: 'snapshot_blob', data: 'legacy baseline' }),
      store.put({ kind: 'attachment', data: 'subagent transcript' }),
      store.put({ kind: 'attachment', data: 'company drive file' }),
      store.put({ kind: 'attachment', data: 'real orphan' }),
    ]);
    const toolOutput = await repository.writeToolOutput(created.location, {
      call_id: 'metadata-is-user-json',
      raw: 'referenced tool output',
      metadata: {
        artifact: 'ordinary label',
        raw_response: 'ordinary response',
        screenshot: { label: 'ordinary object' },
      },
    });
    await repository.commitTurn(created.location, {
      operation_id: 'reference-tool-metadata',
      payload: {
        type: 'coder.turn',
        messages: [],
        message_patches: [],
        tool_calls: [{
          args: {
            artifact: 'ordinary argument',
            screenshot: { label: 'ordinary object' },
          },
          output: toolOutput as unknown as JsonValue,
        }],
      },
    });
    const bundle = created.location.bundle_path;
    await Promise.all([
      mkdir(join(bundle, 'tools_outputs', 'legacy_spills'), { recursive: true }),
      mkdir(join(bundle, 'snapshots', 'session_file_baselines'), { recursive: true }),
      mkdir(join(bundle, 'snapshots', 'session_file_edits'), { recursive: true }),
      mkdir(join(bundle, 'snapshots', 'session_file_review_runs'), { recursive: true }),
      mkdir(join(bundle, 'company', 'drive-files'), { recursive: true }),
      // Historical migrated input; new bundles no longer create this surface.
      mkdir(join(bundle, 'sprite'), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        join(bundle, 'tools_outputs', 'legacy_spills', 'spill.json'),
        JSON.stringify({ schema_version: 1, output_id: 'spill', raw: spill }),
      ),
      writeFile(
        join(bundle, 'subagents', 'transcripts.json'),
        JSON.stringify({
          schema_version: 1,
          records: [{ source_name: 'agent.jsonl', artifact: transcript }],
        }),
      ),
      writeFile(
        join(bundle, 'snapshots', 'session_file_baselines', 'baseline.json'),
        JSON.stringify({
          schema_version: 1,
          kind: 'legacy.session_file_baselines',
          data: {
            _legacy_table: 'session_file_baselines',
            content_before: baseline,
            rollback_content: null,
            baseline_hash: 'this-remains-a-text-hash',
            artifacts: [baseline],
          },
        }),
      ),
      writeFile(
        join(bundle, 'snapshots', 'session_file_edits', 'edit.json'),
        JSON.stringify({
          schema_version: 1,
          kind: 'legacy.session_file_edits',
          data: {
            _legacy_table: 'session_file_edits',
            content_after_hash: 'also-a-text-hash',
          },
        }),
      ),
      writeFile(
        join(bundle, 'snapshots', 'session_file_review_runs', 'review.json'),
        JSON.stringify({
          schema_version: 1,
          kind: 'legacy.session_file_review_runs',
          data: {
            _legacy_table: 'session_file_review_runs',
            raw_response: '{"findings":[]}',
          },
        }),
      ),
      writeFile(
        join(bundle, 'company', 'drive-files', 'drive.json'),
        JSON.stringify({
          schemaVersion: 1,
          kind: 'company.workflowStep',
          data: {
            _legacy_table: 'company_drive_files',
            file: driveFile,
          },
        }),
      ),
      writeFile(
        join(bundle, 'sprite', 'settings.json'),
        JSON.stringify({
          artifact: 'ordinary label',
          raw_response: 'ordinary response',
          screenshot: { label: 'ordinary object' },
        }),
      ),
    ]);
    const orphanPath = join(bundle, ...orphan.relative_path.split('/'));
    await repository.closeSession(created.location);

    const restarted = new FileSessionRepository({
      locator,
      artifactRecoveryRegistry: new Set(),
    });
    await restarted.primeSession(created.location);
    const recoveredStore = new ArtifactStore({
      bundlePath: bundle,
      sessionId: created.session.id,
    });
    expect(recoveredStore.read(spill)).toEqual(Buffer.from('legacy spill'));
    expect(recoveredStore.read(baseline)).toEqual(Buffer.from('legacy baseline'));
    expect(recoveredStore.read(transcript)).toEqual(Buffer.from('subagent transcript'));
    expect(recoveredStore.read(driveFile)).toEqual(Buffer.from('company drive file'));
    expect(recoveredStore.read(toolOutput.raw!)).toEqual(
      Buffer.from('referenced tool output'),
    );
    await expect(stat(orphanPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await restarted.close();
  });

  it('fails closed on corrupt metadata before deleting any artifact', async () => {
    const { repository, locator } = await fixture();
    const created = await repository.createSession({
      kind: 'coder',
      scope: { kind: 'project', project_id: 1 },
    });
    const store = new ArtifactStore({
      bundlePath: created.location.bundle_path,
      sessionId: created.session.id,
    });
    const orphan = await store.put({
      kind: 'attachment',
      data: 'must survive failed recovery',
    });
    const orphanPath = join(
      created.location.bundle_path,
      ...orphan.relative_path.split('/'),
    );
    const calls = join(created.location.bundle_path, 'tools_outputs', 'calls');
    await mkdir(calls, { recursive: true });
    await writeFile(
      join(calls, 'corrupt.json'),
      JSON.stringify({
        schema_version: 1,
        call_id: 'corrupt',
        raw: 'not-an-artifact-ref',
        shaped: null,
      }),
    );
    await repository.closeSession(created.location);

    const restarted = new FileSessionRepository({
      locator,
      artifactRecoveryRegistry: new Set(),
    });
    await expect(
      restarted.primeSession(created.location),
    ).rejects.toBeInstanceOf(ArtifactRecoveryCorruptionError);
    await expect(stat(orphanPath)).resolves.toBeDefined();
    await restarted.close();
  });

  it('validates every referenced blob before deleting orphan candidates', async () => {
    const { repository, locator } = await fixture();
    const created = await repository.createSession({
      kind: 'coder',
      scope: { kind: 'project', project_id: 1 },
    });
    const store = new ArtifactStore({
      bundlePath: created.location.bundle_path,
      sessionId: created.session.id,
    });
    const orphan = await store.put({
      kind: 'attachment',
      data: 'candidate that must not be deleted',
    });
    const missing = store.describe({
      kind: 'tool_output_raw',
      data: 'described but never published',
    });
    const orphanPath = join(
      created.location.bundle_path,
      ...orphan.relative_path.split('/'),
    );
    const calls = join(created.location.bundle_path, 'tools_outputs', 'calls');
    await mkdir(calls, { recursive: true });
    const missingRecord = {
      schema_version: 1 as const,
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      call_id: 'missing-payload',
      created_at: new Date().toISOString(),
      raw: missing,
      shaped: null,
      metadata: {},
    };
    await writeFile(
      join(calls, toolOutputRecordFileName('missing-payload')),
      JSON.stringify(missingRecord),
    );
    await repository.commitTurn(created.location, {
      operation_id: 'reference-missing-payload',
      payload: {
        type: 'coder.turn',
        messages: [],
        message_patches: [],
        tool_calls: [{
          output: missingRecord as unknown as JsonValue,
        }],
      },
    });
    await repository.closeSession(created.location);

    const restarted = new FileSessionRepository({
      locator,
      artifactRecoveryRegistry: new Set(),
    });
    await expect(
      restarted.primeSession(created.location),
    ).rejects.toThrow(/Referenced artifact .* is missing/);
    await expect(stat(orphanPath)).resolves.toBeDefined();
    await restarted.close();
  });
});

describe('archive, trash, and path safety', () => {
  it('archives through state.json and deletes through same-volume trash as separate operations', async () => {
    const { repository } = await fixture();
    const created = await repository.createSession({
      kind: 'coder',
      scope: { kind: 'project', project_id: 1 },
    });
    await repository.archiveSession(created.location);
    expect(repository.readStateSync(created.location).archived_at).not.toBeNull();

    const trashed = await repository.trashSession(created.location);
    await expect(stat(created.location.bundle_path)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(trashed.trash_path)).resolves.toMatchObject({ size: expect.any(Number) });
    await expect(repository.listTrashedSessions(created.location.scope)).resolves.toEqual([
      expect.objectContaining({
        trash_name: trashed.trash_name,
        trashed_at: trashed.trashed_at,
        scope: created.location.scope,
        metadata: expect.objectContaining({
          id: created.session.id,
          kind: 'coder',
        }),
      }),
    ]);
    const restored = await repository.restoreTrashedSession(
      created.location.scope,
      trashed.trash_name,
    );
    expect(restored.session.id).toBe(created.session.id);
    await expect(stat(created.location.bundle_path)).resolves.toBeDefined();

    const trashedAgain = await repository.trashSession(created.location);
    await repository.purgeTrashedSession(
      created.location.scope,
      trashedAgain.trash_name,
    );
    await expect(stat(trashedAgain.trash_path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects traversal in per-entity and trash identifiers', async () => {
    const { repository } = await fixture();
    const created = await repository.createSession({
      kind: 'coder',
      scope: { kind: 'project', project_id: 1 },
    });
    await expect(
      repository.writeEntity(created.location, 'tasks', '../outside', { unsafe: true }),
    ).rejects.toBeInstanceOf(UnsafeSessionPathError);
    await expect(
      repository.purgeTrashedSession(created.location.scope, '../outside'),
    ).rejects.toBeInstanceOf(UnsafeSessionPathError);
    await expect(
      repository.restoreTrashedSession(created.location.scope, 'safe-but-not-a-trash-token'),
    ).rejects.toBeInstanceOf(UnsafeSessionPathError);
  });
});
