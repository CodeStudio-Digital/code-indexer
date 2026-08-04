import { Hono } from 'hono';
import { asSessionId } from '@mcp/session-storage';
import type { SessionWorkbenchCommand } from '@mcp/api-bus';
import type { FsSessionEvent } from '@mcp/code-agent/sessions/fs-store/operational-types.js';
import type { FsCoderSession } from '@mcp/code-agent/sessions/fs-store/types.js';
import { describe, expect, it, vi } from 'vitest';
import type { ServerDeps } from '../../../../deps.js';
import { SessionWorkbenchCommandService } from '../command-service.js';
import { mountSessionWorkbenchRoutes } from '../routes.js';

const SESSION_ID = asSessionId('11111111-1111-4111-8111-111111111111');
const COMMAND_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const INITIAL_UPDATED_AT = '2026-08-01T10:00:00.000Z';

function session(): FsCoderSession {
  return {
    id: SESSION_ID,
    title: 'Original',
    is_favorite: false,
    is_archived: false,
    group_id: null,
    updated_at: INITIAL_UPDATED_AT,
    linked_projects: [{ project_id: 7 }],
    state: { tools: { disabled: [], active_skills: ['skill-a'] } },
  } as unknown as FsCoderSession;
}

function fixture() {
  let current = session();
  let receiptSeq = 0;
  const receipts = new Map<string, FsSessionEvent>();
  const touch = () => {
    current = {
      ...current,
      updated_at: new Date(Date.parse(current.updated_at) + 1_000).toISOString(),
    };
  };
  const store = {
    getSession: vi.fn(async (id: string) => id === SESSION_ID ? current : null),
    setSessionTitle: vi.fn(async (_id: string, title: string) => { current = { ...current, title }; touch(); }),
    setSessionFavorite: vi.fn(async (_id: string, favorite: boolean) => { current = { ...current, is_favorite: favorite }; touch(); }),
    setSessionArchived: vi.fn(async (_id: string, archived: boolean) => { current = { ...current, is_archived: archived }; touch(); }),
    setSessionGroup: vi.fn(async (_id: string, groupId: string | null) => { current = { ...current, group_id: groupId }; touch(); }),
    duplicateSession: vi.fn(async (_id: string, options: { targetId: ReturnType<typeof asSessionId>; title?: string }) => ({
      ...current,
      id: options.targetId,
      title: options.title ?? `${current.title} (cópia)`,
    })),
    setSessionToolDisabled: vi.fn(async (_id: string, toolId: string, disabled: boolean) => {
      current = {
        ...current,
        state: { ...current.state, tools: { ...current.state.tools, disabled: disabled ? [toolId] : [] } },
      };
      touch();
    }),
    setSessionActiveSkills: vi.fn(async (_id: string, ids: readonly string[]) => {
      current = {
        ...current,
        state: { ...current.state, tools: { ...current.state.tools, active_skills: [...ids] } },
      };
      touch();
    }),
    appendSessionEvent: vi.fn(async (
      _id: string,
      type: string,
      payload: unknown,
      operationId?: string,
    ) => {
      const event: FsSessionEvent = {
        id: `event-${++receiptSeq}`,
        seq: receiptSeq,
        operation_id: operationId!,
        type,
        created_at: current.updated_at,
        payload: payload as FsSessionEvent['payload'],
      };
      receipts.set(operationId!, event);
      return event;
    }),
    getSessionEventByOperationId: vi.fn(async (
      _id: string,
      operationId: string,
      type?: string,
    ) => {
      const event = receipts.get(operationId) ?? null;
      return event && (type == null || event.type === type) ? event : null;
    }),
  };
  const publish = vi.fn();
  const service = new SessionWorkbenchCommandService(
    store as unknown as ConstructorParameters<typeof SessionWorkbenchCommandService>[0],
    async (value) => new Set(
      Array.isArray(value.state.tools.active_skills)
        ? value.state.tools.active_skills.filter((item): item is string => typeof item === 'string')
        : [],
    ),
    publish,
  );
  return { store, service, publish };
}

function rename(overrides: Partial<SessionWorkbenchCommand> = {}): SessionWorkbenchCommand {
  return {
    commandId: COMMAND_ID,
    sessionId: SESSION_ID,
    type: 'rename',
    title: 'Renamed',
    ...overrides,
  } as SessionWorkbenchCommand;
}

describe('SessionWorkbenchCommandService', () => {
  it('coalesces concurrent execution, persists a receipt and publishes after commit', async () => {
    const { service, store, publish } = fixture();
    const command = rename({ expectedRevision: Date.parse(INITIAL_UPDATED_AT) });
    const first = service.execute(command);
    const second = service.execute(command);
    expect(second).toBe(first);

    const [left, right] = await Promise.all([first, second]);
    expect(left).toEqual(right);
    expect(left).toMatchObject({ ok: true, commandId: COMMAND_ID, revision: Date.parse(INITIAL_UPDATED_AT) + 1_000 });
    expect(store.setSessionTitle).toHaveBeenCalledTimes(1);
    expect(store.appendSessionEvent).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      type: 'navigator.changed',
      data: expect.objectContaining({ titleChanged: true }),
    }));

    expect(await service.execute(command)).toEqual(left);
    expect(store.setSessionTitle).toHaveBeenCalledTimes(1);
  });

  it('rejects stale revisions and command-id reuse with different input', async () => {
    const { service } = fixture();
    await expect(service.execute(rename({ expectedRevision: 1 }))).resolves.toMatchObject({
      ok: false,
      error: { code: 'revision_conflict', retryable: true },
    });

    expect(await service.execute(rename())).toMatchObject({ ok: true });
    expect(await service.execute(rename({ title: 'Different' }))).toMatchObject({
      ok: false,
      error: { code: 'command_id_conflict', retryable: false },
    });
  });

  it('returns per-item batch results and derives deterministic duplicate identity', async () => {
    const { service, store } = fixture();
    const duplicate: SessionWorkbenchCommand = {
      commandId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      sessionId: SESSION_ID,
      type: 'duplicate',
      title: 'Deterministic copy',
    };
    const missing: SessionWorkbenchCommand = {
      commandId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      sessionId: asSessionId('22222222-2222-4222-8222-222222222222'),
      type: 'set_favorite',
      favorite: true,
    };

    const results = await service.batch([duplicate, missing]);
    expect(results).toEqual([
      expect.objectContaining({ ok: true, createdSessionId: duplicate.commandId }),
      expect.objectContaining({ ok: false, error: expect.objectContaining({ code: 'session_not_found' }) }),
    ]);
    expect(store.duplicateSession).toHaveBeenCalledWith(SESSION_ID, {
      targetId: duplicate.commandId,
      title: 'Deterministic copy',
    });
  });

  it('updates explicit skill and tool configuration as set operations', async () => {
    const { service, store } = fixture();
    expect(await service.execute({
      commandId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      sessionId: SESSION_ID,
      type: 'set_skill_enabled',
      skillId: 'skill-b',
      enabled: true,
    })).toMatchObject({ ok: true });
    expect(store.setSessionActiveSkills).toHaveBeenCalledWith(SESSION_ID, ['skill-a', 'skill-b']);

    expect(await service.execute({
      commandId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      sessionId: SESSION_ID,
      type: 'set_tool_enabled',
      toolId: 'write_file',
      enabled: false,
    })).toMatchObject({ ok: true });
    expect(store.setSessionToolDisabled).toHaveBeenCalledWith(SESSION_ID, 'write_file', true);
  });
});

describe('Session Workbench command routes', () => {
  it('validates JSON commands and preserves partial batch results', async () => {
    const execute = vi.fn(async (command: SessionWorkbenchCommand) => ({
      commandId: command.commandId,
      sessionId: command.sessionId,
      ok: true as const,
      revision: 2,
    }));
    const batch = vi.fn(async (commands: SessionWorkbenchCommand[]) => commands.map((command, index) => index === 0
      ? { commandId: command.commandId, sessionId: command.sessionId, ok: true as const, revision: 2 }
      : {
          commandId: command.commandId,
          sessionId: command.sessionId,
          ok: false as const,
          error: {
            code: 'conflict', message: 'conflict', retryable: false,
            sessionId: command.sessionId, resource: 'navigator' as const,
          },
        }));
    const app = new Hono();
    mountSessionWorkbenchRoutes(app, {} as ServerDeps, {
      service: { listSessions: vi.fn(), bootstrap: vi.fn() } as never,
      resources: { context: vi.fn(), execution: vi.fn(), insights: vi.fn(), configuration: vi.fn() } as never,
      events: { list: vi.fn() } as never,
      commands: { execute, batch },
    });

    const invalid = await app.request('/api/coder/session-workbench/commands', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'rename' }),
    });
    expect(invalid.status).toBe(400);

    const response = await app.request('/api/coder/session-workbench/commands/batch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commands: [
        { commandId: COMMAND_ID, sessionId: SESSION_ID, type: 'set_favorite', favorite: true },
        { commandId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', sessionId: SESSION_ID, type: 'set_archived', archived: true },
      ] }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      expect.objectContaining({ ok: true }),
      expect.objectContaining({ ok: false, error: expect.objectContaining({ code: 'conflict' }) }),
    ]);

    execute.mockResolvedValueOnce({
      commandId: COMMAND_ID,
      sessionId: SESSION_ID,
      ok: true,
    } as never);
    const invalidResponse = await app.request('/api/coder/session-workbench/commands', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        commandId: COMMAND_ID,
        sessionId: SESSION_ID,
        type: 'set_favorite',
        favorite: true,
      }),
    });
    expect(invalidResponse.status).toBe(500);
    expect(await invalidResponse.json()).toMatchObject({
      code: 'invalid_response',
      context: { path: '$.revision' },
    });
  });
});
