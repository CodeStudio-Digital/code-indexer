import { asSessionId } from '@mcp/session-storage';
import type { FsCoderSession } from '@mcp/session-storage/fs-store/types.js';
import type { SkillSummaryPage } from '@mcp/store/skill-store.js';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { ServerDeps } from '../../../../deps.js';
import { mountSessionWorkbenchRoutes } from '../routes.js';
import { SessionWorkbenchResourceService } from '../resource-service.js';

const SESSION_ID = asSessionId('11111111-1111-4111-8111-111111111111');

function session(): FsCoderSession {
  return {
    id: SESSION_ID,
    project_id: 7,
    is_global: false,
    title: 'Workbench fixture',
    provider: 'openai',
    model: 'gpt-test',
    status: 'idle',
    is_archived: false,
    is_favorite: false,
    group_id: null,
    linked_projects: [{
      project_id: 7,
      name: 'Fixture',
      root_path: 'D:/fixture',
      is_primary: true,
      label: null,
    }],
    state: {
      schema_version: 1,
      status: 'idle',
      updated_at: '2026-01-01T00:00:10.000Z',
      archived_at: null,
      goal: null,
      todos: [],
      permissions: {},
      tools: { active_skills: ['skill-a'] },
      compaction: {},
      cursors: {},
      extra: {},
    },
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:10.000Z',
    tool_permission_mode: 'ask',
  } as unknown as FsCoderSession;
}

function skillPage(input: { offset: number; limit: number }): SkillSummaryPage {
  const all = [
    { id: 'skill-a', name: 'Skill A', scope: 'global', enabled: true, source: 'builtin' as const, updated_at: '2026-01-01T00:00:02.000Z' },
    { id: 'skill-b', name: 'Skill B', scope: '7', enabled: false, source: 'user' as const, updated_at: '2026-01-01T00:00:03.000Z' },
  ];
  const items = all.slice(input.offset, input.offset + input.limit);
  const next = input.offset + items.length;
  return {
    items,
    totalCount: all.length,
    nextOffset: next < all.length ? next : null,
    revision: Date.parse('2026-01-01T00:00:03.000Z'),
  };
}

function fixture(
  listTimeline?: ConstructorParameters<typeof SessionWorkbenchResourceService>[5],
) {
  let currentSession = session();
  const store = {
    getSession: vi.fn(async () => currentSession),
    getSessionFileMap: vi.fn(async () => ({
      changed: ['src/b.ts', 'src/a.ts'],
      read: ['src/a.ts', 'README.md'],
    })),
    listConversationChapters: vi.fn(async () => ({
      items: [],
      next_cursor: null,
      total_count: 0,
      revision: 1,
    })),
    listPlans: vi.fn(async () => []),
    getDriveAggregate: vi.fn(async () => ({
      memory: [], investigations: [], fileMap: { read: [], changed: [] }, plans: [], tasks: null,
    })),
    listSubagentRuns: vi.fn(async (_id: string, offset: number, limit: number) => {
      const all = [{
        id: 'entity-1', seq: 1, revision: 1, session_id: SESSION_ID,
        run_id: '22222222-2222-4222-8222-222222222222', parent_run_id: null,
        parent_agent_run_id: null, spawn_id: 'spawn-1', profile: 'explore', label: 'Explore',
        task_preview: null, requested_provider: null, requested_model: null,
        requested_reasoning_effort: null, wait_mode: 'foreground' as const,
        effective_provider: null, effective_model: null, effective_reasoning_effort: null,
        effective_capabilities: [], environment_fingerprint: null, policy_mode: null,
        max_turns: 10, max_tool_calls: null, timeout_ms: null, stall_ms: null,
        research_depth: null, soft_tool_target: null, soft_time_target_ms: null,
        status: 'completed' as const, reason: 'completed', turns: 2, auto_continues: 0,
        tool_calls: 3, logical_operations: 3, productive_operations: 3, paginate_calls: 0,
        duplicate_calls: 0, error_calls: 0, refused_calls: 0, elapsed_ms: 10,
        input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0, has_summary: true, output_id: null,
        synthesis_nudged: false, started_at: '2026-01-01T00:00:04.000Z',
        heartbeat_at: '2026-01-01T00:00:05.000Z', completed_at: '2026-01-01T00:00:05.000Z',
        worker_instance_id: 'fixture', fence_token: 'fixture',
      }];
      return {
        items: all.slice(offset, offset + limit),
        totalCount: all.length,
        nextOffset: null,
        revision: Date.parse('2026-01-01T00:00:05.000Z'),
      };
    }),
    listTaskRunsPage: vi.fn(async () => ({
      items: [], totalCount: 0, nextOffset: null, revision: 1,
    })),
    getMetricsSummary: vi.fn(async () => ({
      schema_version: 1 as const,
      updated_at: '2026-01-01T00:00:06.000Z',
      turns: 3,
      tool_calls: 5,
      provider_attempts: 4,
      tokens: { input: 100, output: 40, cache_read: 80, cache_creation: 0 },
    })),
    listToolCallSummaries: vi.fn(async () => ({
      items: [], totalCount: 0, nextOffset: null, revision: 1,
    })),
    listSessionInputs: vi.fn(async () => []),
    getSessionDisabledTools: vi.fn(async () => new Set(['write_file'])),
  };
  const skills = { listSkillSummaries: vi.fn((input: { offset: number; limit: number }) => skillPage(input)) };
  const tools = vi.fn(() => [
    { name: 'read_file', tier: 'navigate', source: 'native' as const, description: '' },
    { name: 'write_file', tier: 'navigate', source: 'native' as const, description: '' },
  ]);
  const service = new SessionWorkbenchResourceService(
    store as unknown as ConstructorParameters<typeof SessionWorkbenchResourceService>[0],
    skills as unknown as ConstructorParameters<typeof SessionWorkbenchResourceService>[1],
    tools,
    (projectId) => projectId === 7,
    async () => ({ active: true, waitingForInput: false }),
    listTimeline,
  );
  return {
    service,
    store,
    skills,
    tools,
    updateSession: (value: FsCoderSession) => { currentSession = value; },
  };
}

describe('SessionWorkbenchResourceService', () => {
  it('paginates one context view and rejects its cursor after revision drift', async () => {
    const { service, store, updateSession } = fixture();
    const first = await service.context(SESSION_ID, { view: 'files', limit: 2 });
    expect(first.view).toBe('files');
    expect(first.view === 'files' && first.files.map((file) => file.displayPath))
      .toEqual(['README.md', 'src/a.ts']);
    expect(first.pageInfo.totalCount).toBe(3);
    expect(first.pageInfo.nextCursor).toBeTypeOf('string');

    const current = await store.getSession();
    updateSession({ ...current!, updated_at: '2026-01-01T00:00:20.000Z' });
    await expect(service.context(SESSION_ID, {
      view: 'files',
      limit: 2,
      cursor: first.pageInfo.nextCursor!,
    })).rejects.toMatchObject({ code: 'stale_cursor', status: 409 });
  });

  it('keeps inactive insights and configuration catalogs lazy', async () => {
    const { service, store, skills, tools } = fixture();
    const overview = await service.insights(SESSION_ID, { view: 'overview', limit: 50 });
    expect(overview.metrics.map((metric) => metric.id)).toEqual(['turns', 'tool_calls', 'provider_attempts']);
    expect(store.listToolCallSummaries).not.toHaveBeenCalled();
    expect(store.listSessionInputs).not.toHaveBeenCalled();

    const skillConfig = await service.configuration(SESSION_ID, { view: 'skills', limit: 1 });
    expect(skillConfig.skills).toHaveLength(1);
    expect(skillConfig.pageInfo.nextCursor).toBeTypeOf('string');
    expect(skills.listSkillSummaries).toHaveBeenCalledTimes(1);
    expect(tools).not.toHaveBeenCalled();
    expect(store.getSessionDisabledTools).not.toHaveBeenCalled();
  });

  it('projects persisted subagents and per-session tool permissions', async () => {
    const { service } = fixture();
    const execution = await service.execution(SESSION_ID, { view: 'subagents', limit: 10 });
    expect(execution.view === 'subagents' && execution.subagents).toEqual([
      expect.objectContaining({ label: 'Explore', status: 'completed' }),
    ]);

    const configuration = await service.configuration(SESSION_ID, { view: 'tools', limit: 10 });
    expect(configuration.tools).toEqual([
      expect.objectContaining({ id: 'read_file', enabled: true, permission: 'ask' }),
      expect.objectContaining({ id: 'write_file', enabled: false, permission: 'deny' }),
    ]);
  });

  it('projects the canonical event page into the lazy execution timeline', async () => {
    const listTimeline = vi.fn(async () => ({
      contractVersion: 1 as const,
      sessionId: SESSION_ID,
      revision: 23,
      events: [{
        sessionId: SESSION_ID,
        busId: 'bus-1',
        seq: 4,
        revision: 23,
        occurredAt: '2026-01-01T00:00:07.000Z',
        type: 'execution.event' as const,
        resource: 'execution' as const,
        data: {
          id: 'event-1',
          seq: 4,
          occurredAt: '2026-01-01T00:00:07.000Z',
          category: 'tool' as const,
          severity: 'info' as const,
          operationId: 'op-1',
          title: 'tool_call_start',
          message: 'tool_call_start',
          durationMs: null,
          retryable: false,
        },
      }],
      nextCursor: 'next-events',
      totalCount: 11,
      replayGap: false,
    }));
    const { service } = fixture(listTimeline);

    const timeline = await service.execution(SESSION_ID, { view: 'timeline', limit: 5 });
    expect(timeline).toMatchObject({
      revision: 23,
      view: 'timeline',
      entries: { availability: 'available', items: [{ id: 'event-1', category: 'tool' }] },
      pageInfo: { totalCount: 11, nextCursor: 'next-events' },
    });
    expect(listTimeline).toHaveBeenCalledWith(SESSION_ID, { limit: 5 });
  });

  it('coalesces identical resource reads', async () => {
    const { service, store } = fixture();
    await Promise.all([
      service.context(SESSION_ID, { view: 'files', limit: 2 }),
      service.context(SESSION_ID, { view: 'files', limit: 2 }),
    ]);
    expect(store.getSession).toHaveBeenCalledTimes(1);
    expect(store.getSessionFileMap).toHaveBeenCalledTimes(1);
  });
});

describe('Session Workbench resource routes', () => {
  it('validates the view and supports conditional GET for a resource', async () => {
    const context = vi.fn(async () => ({
      sessionId: SESSION_ID,
      revision: 12,
      view: 'files' as const,
      files: [],
      pageInfo: { totalCount: 0, nextCursor: null },
    }));
    const app = new Hono();
    mountSessionWorkbenchRoutes(app, {} as ServerDeps, {
      service: { listSessions: vi.fn(), bootstrap: vi.fn() } as never,
      resources: {
        context,
        execution: vi.fn(),
        insights: vi.fn(),
        configuration: vi.fn(),
      } as never,
    });

    const invalid = await app.request(
      `/api/coder/session-workbench/sessions/${SESSION_ID}/context?view=everything`,
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ code: 'invalid_query' });

    const response = await app.request(
      `/api/coder/session-workbench/sessions/${SESSION_ID}/context?view=files&limit=999`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toBe(`"csw-${SESSION_ID}-context-files-12"`);
    expect(context).toHaveBeenCalledWith(SESSION_ID, { view: 'files', limit: 100 });

    const notModified = await app.request(
      `/api/coder/session-workbench/sessions/${SESSION_ID}/context?view=files`,
      { headers: { 'If-None-Match': `"csw-${SESSION_ID}-context-files-12"` } },
    );
    expect(notModified.status).toBe(304);
  });
});
