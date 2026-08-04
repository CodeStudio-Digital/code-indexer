import { describe, expect, it } from 'vitest';
import {
  SESSION_WORKBENCH_EVENT_LIMIT_DEFAULT,
  SESSION_WORKBENCH_EVENT_LIMIT_MAX,
  SESSION_WORKBENCH_PAGE_LIMIT_DEFAULT,
  SESSION_WORKBENCH_PAGE_LIMIT_MAX,
  parseSessionWorkbenchConfigurationQuery,
  parseSessionWorkbenchCommand,
  parseSessionWorkbenchCommandBatch,
  parseSessionWorkbenchContextQuery,
  parseSessionWorkbenchEventQuery,
  parseSessionWorkbenchExecutionQuery,
  parseSessionWorkbenchInsightsQuery,
  parseSessionWorkbenchListQuery,
  type SessionWorkbenchBadgeState,
} from '../coder-session-workbench.js';
import {
  validateSessionWorkbenchEventPage,
  validateSessionWorkbenchExecutionResource,
} from '../coder-session-workbench-validation.js';

describe('SessionWorkbenchBadgeState', () => {
  it('distinguishes measured zero from a projection that has not loaded', () => {
    const badges = {
      unreadNotifications: { availability: 'pending', reason: 'event_projection_pending' },
      executionErrors: { availability: 'pending', reason: 'event_projection_pending' },
      executionWarnings: { availability: 'pending', reason: 'event_projection_pending' },
      activeSubagents: { availability: 'pending', reason: 'subagent_projection_pending' },
      chapters: { availability: 'available', value: 0 },
      pendingSnapshots: { availability: 'pending', reason: 'snapshot_projection_pending' },
      invalidConfiguration: { availability: 'pending', reason: 'configuration_projection_pending' },
      highestSeverity: { availability: 'pending', reason: 'event_projection_pending' },
    } satisfies SessionWorkbenchBadgeState;

    expect(badges.chapters).toEqual({ availability: 'available', value: 0 });
    expect(badges.unreadNotifications.availability).toBe('pending');
  });
});

describe('Session Workbench response validation', () => {
  it('validates nested process items and rejects presentation text from the backend', () => {
    const resource = {
      sessionId: '11111111-1111-4111-8111-111111111111',
      revision: 2,
      view: 'processes',
      run: {
        active: true,
        waitingForInput: false,
        startedAt: '2026-08-01T10:00:00.000Z',
        lastEventAt: null,
      },
      processes: [{
        id: 'run-1',
        labelKey: 'execution.process.automatic',
        status: 'running',
        startedAt: '2026-08-01T10:00:00.000Z',
      }],
      pageInfo: { totalCount: 1, nextCursor: null },
    };

    expect(validateSessionWorkbenchExecutionResource(resource)).toBe(resource);
    expect(() => validateSessionWorkbenchExecutionResource({
      ...resource,
      processes: [{
        id: 'run-1',
        label: 'Automatic task run',
        status: 'running',
        startedAt: null,
      }],
    })).toThrow('$.processes[0].labelKey must be one of');
  });

  it('validates the event discriminant and permits an honestly unknown total', () => {
    const page = {
      contractVersion: 1,
      sessionId: '11111111-1111-4111-8111-111111111111',
      revision: 5,
      events: [{
        sessionId: '11111111-1111-4111-8111-111111111111',
        busId: 'bus-1',
        seq: 2,
        revision: 5,
        occurredAt: '2026-08-01T10:00:00.000Z',
        type: 'execution.event',
        resource: 'execution',
        data: {
          id: 'event-1',
          seq: 2,
          occurredAt: '2026-08-01T10:00:00.000Z',
          category: 'worker',
          severity: 'warning',
          operationId: null,
          title: 'agent_progress',
          message: 'timed_out',
          durationMs: null,
          retryable: false,
        },
      }],
      nextCursor: null,
      totalCount: null,
      replayGap: false,
    };

    expect(validateSessionWorkbenchEventPage(page)).toBe(page);
    expect(() => validateSessionWorkbenchEventPage({
      ...page,
      events: [{ ...page.events[0], resource: 'summary' }],
    })).toThrow('$.events[0].resource must be one of execution');
  });
});

describe('Session Workbench lazy resource queries', () => {
  it('applies one independent bounded cursor per discriminated view', () => {
    expect(parseSessionWorkbenchContextQuery({ view: 'chapters', cursor: ' c-1 ', limit: '500' }))
      .toEqual({ view: 'chapters', cursor: 'c-1', limit: SESSION_WORKBENCH_PAGE_LIMIT_MAX });
    expect(parseSessionWorkbenchExecutionQuery({ view: 'subagents' }))
      .toEqual({ view: 'subagents', limit: SESSION_WORKBENCH_PAGE_LIMIT_DEFAULT });
    expect(parseSessionWorkbenchInsightsQuery({ view: 'tools' }))
      .toEqual({ view: 'tools', limit: SESSION_WORKBENCH_PAGE_LIMIT_DEFAULT });
    expect(parseSessionWorkbenchConfigurationQuery({ view: 'tools' }))
      .toEqual({ view: 'tools', limit: SESSION_WORKBENCH_PAGE_LIMIT_DEFAULT });
  });

  it.each([
    [() => parseSessionWorkbenchContextQuery({ view: 'all' }), 'view is not supported'],
    [() => parseSessionWorkbenchExecutionQuery({ limit: '0' }), 'limit must be a positive integer'],
    [() => parseSessionWorkbenchInsightsQuery({ view: 'raw' }), 'view is not supported'],
    [() => parseSessionWorkbenchConfigurationQuery({ view: 'providers' }), 'view is not supported'],
  ])('rejects malformed resource queries %#', (parse, message) => {
    expect(parse).toThrow(message);
  });
});

describe('parseSessionWorkbenchListQuery', () => {
  it('normalizes a project query with bounded defaults', () => {
    expect(parseSessionWorkbenchListQuery({ scope: 'project', project_id: '42' })).toEqual({
      scope: 'project',
      projectId: 42,
      limit: SESSION_WORKBENCH_PAGE_LIMIT_DEFAULT,
      groupBy: 'group',
    });
  });

  it('normalizes filters and clamps limits independently of the caller', () => {
    expect(parseSessionWorkbenchListQuery({
      scope: 'global',
      cursor: ' next-page ',
      limit: '5000',
      query: ' worker failure ',
      archived: 'false',
      favorite: 'true',
      status: ' running ',
      provider: ' openai ',
    })).toEqual({
      scope: 'global',
      cursor: 'next-page',
      limit: SESSION_WORKBENCH_PAGE_LIMIT_MAX,
      query: 'worker failure',
      archived: false,
      favorite: true,
      status: 'running',
      provider: 'openai',
      groupBy: 'workspace',
    });
  });

  it.each([
    [{}, 'scope must be project or global'],
    [{ scope: 'project' }, 'project_id is required for project scope'],
    [{ scope: 'project', project_id: '0' }, 'project_id must be a positive integer'],
    [{ scope: 'global', archived: 'yes' }, 'archived must be true or false'],
    [{ scope: 'global', group_by: 'folder' }, 'group_by must be group or workspace'],
  ])('rejects malformed query %#', (raw, message) => {
    expect(() => parseSessionWorkbenchListQuery(raw)).toThrow(message);
  });
});

describe('parseSessionWorkbenchEventQuery', () => {
  it('applies a bounded default without inventing filters', () => {
    expect(parseSessionWorkbenchEventQuery({})).toEqual({
      limit: SESSION_WORKBENCH_EVENT_LIMIT_DEFAULT,
    });
  });

  it('normalizes supported filters and clamps the page size', () => {
    expect(parseSessionWorkbenchEventQuery({
      cursor: ' event-100 ',
      limit: '9999',
      category: 'worker',
      level: 'warning',
      query: ' retry ',
    })).toEqual({
      cursor: 'event-100',
      limit: SESSION_WORKBENCH_EVENT_LIMIT_MAX,
      category: 'worker',
      level: 'warning',
      query: 'retry',
    });
  });

  it.each([
    [{ limit: '-1' }, 'limit must be a positive integer'],
    [{ category: 'debug' }, 'category is not supported'],
    [{ level: 'fatal' }, 'level is not supported'],
  ])('rejects malformed event query %#', (raw, message) => {
    expect(() => parseSessionWorkbenchEventQuery(raw)).toThrow(message);
  });
});

describe('Session Workbench command boundary', () => {
  const base = {
    commandId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    sessionId: '11111111-1111-4111-8111-111111111111',
  };

  it('parses discriminated commands and bounded batches', () => {
    expect(parseSessionWorkbenchCommand({
      ...base,
      type: 'rename',
      title: '  New title  ',
      expectedRevision: 12,
    })).toEqual({ ...base, type: 'rename', title: 'New title', expectedRevision: 12 });
    expect(parseSessionWorkbenchCommandBatch({ commands: [
      { ...base, type: 'set_favorite', favorite: true },
    ] })).toEqual([{ ...base, type: 'set_favorite', favorite: true }]);
  });

  it.each([
    [{ ...base, commandId: 'retry-1', type: 'set_favorite', favorite: true }, 'commandId must be a canonical UUID'],
    [{ ...base, type: 'rename', title: ' ' }, 'title must be a non-empty string'],
    [{ ...base, type: 'move' }, 'groupId must be a canonical UUID or null'],
    [{ ...base, type: 'set_tool_enabled', toolId: 'read_file', enabled: 'yes' }, 'enabled must be a boolean'],
    [{ ...base, type: 'unknown' }, 'command type is not supported'],
  ])('rejects an invalid command %#', (command, message) => {
    expect(() => parseSessionWorkbenchCommand(command)).toThrow(message);
  });

  it('rejects empty and oversized batches', () => {
    expect(() => parseSessionWorkbenchCommandBatch({ commands: [] }))
      .toThrow('commands must contain between 1 and 100 items');
    expect(() => parseSessionWorkbenchCommandBatch({
      commands: Array.from({ length: 101 }, () => ({ ...base, type: 'set_archived', archived: true })),
    })).toThrow('commands must contain between 1 and 100 items');
  });
});
