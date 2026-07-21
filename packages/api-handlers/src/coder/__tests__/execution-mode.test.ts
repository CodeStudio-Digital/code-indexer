import { describe, expect, it, vi } from 'vitest';
import type {
  ApiContext,
  CreateSessionInput,
  ExecutionMode,
} from '@mcp/api-bus';
import type { HandlerDeps } from '../../types.js';
import { createCoderHandlers } from '../index.js';

interface FakeSessionRow {
  id: number;
  project_id: number;
  title: string;
  provider: string;
  model: string;
  model_mode?: string;
  execution_mode_override: ExecutionMode;
  reasoning_effort_override: string | null;
  status: string;
  total_input_tokens: number;
  total_output_tokens: number;
  is_archived: boolean;
  is_favorite: boolean;
  created_at: string;
  updated_at: string;
}

const ctx: ApiContext = {
  requestId: 'execution-mode-test',
  signal: new AbortController().signal,
};

function createHarness() {
  const rows = new Map<number, FakeSessionRow>();
  let nextId = 1;

  const sessionStore = {
    createSession: vi.fn((input: {
      project_id: number;
      title: string;
      provider: string;
      model: string;
    }) => {
      const row: FakeSessionRow = {
        id: nextId++,
        project_id: input.project_id,
        title: input.title,
        provider: input.provider,
        model: input.model,
        execution_mode_override: 'standard',
        reasoning_effort_override: null,
        status: 'idle',
        total_input_tokens: 0,
        total_output_tokens: 0,
        is_archived: false,
        is_favorite: false,
        created_at: '2026-07-18T00:00:00Z',
        updated_at: '2026-07-18T00:00:00Z',
      };
      rows.set(row.id, row);
      return row;
    }),
    getSession: vi.fn((id: number) => rows.get(id) ?? null),
    setSessionExecutionMode: vi.fn((id: number, mode: ExecutionMode) => {
      const row = rows.get(id);
      if (row) row.execution_mode_override = mode;
    }),
    setSessionReasoningEffort: vi.fn((id: number, effort: string | null) => {
      const row = rows.get(id);
      if (row) row.reasoning_effort_override = effort;
    }),
  };

  const providerStore = {
    listModels: vi.fn(() => [{
      model_id: 'reasoner',
      mode: '',
      supported_reasoning_levels: ['low', 'high'],
    }]),
  };

  const handlers = createCoderHandlers({ sessionStore, providerStore } as unknown as HandlerDeps);
  return { handlers, rows, sessionStore };
}

function createInput(patch: Partial<CreateSessionInput> = {}): CreateSessionInput {
  return {
    project_id: 7,
    title: 'Ultra contract',
    provider: 'openai',
    model: 'reasoner',
    ...patch,
  };
}

describe('coder api-bus execution mode', () => {
  it('creates, reads, and updates Ultra as a first-class execution mode', async () => {
    const { handlers, sessionStore } = createHarness();

    const created = await handlers.sessions.create(createInput({
      execution_mode: 'ultra',
      reasoning_effort: 'high',
    }), ctx);
    expect(created.execution_mode_override).toBe('ultra');
    expect(sessionStore.setSessionExecutionMode).toHaveBeenCalledWith(created.id, 'ultra');
    expect(sessionStore.setSessionReasoningEffort).toHaveBeenCalledWith(created.id, 'high');

    const read = await handlers.sessions.get({ id: created.id }, ctx);
    expect(read.session.execution_mode_override).toBe('ultra');

    const updated = await handlers.sessions.setExecutionMode({
      id: created.id,
      mode: 'standard',
    }, ctx);
    expect(updated.execution_mode_override).toBe('standard');
    expect(sessionStore.setSessionExecutionMode).toHaveBeenLastCalledWith(created.id, 'standard');
  });

  it('lets the first-class mode win while stripping a legacy Ultra sentinel', async () => {
    const { handlers, rows, sessionStore } = createHarness();

    const created = await handlers.sessions.create(createInput({
      execution_mode: 'standard',
      reasoning_effort: '  UlTrA  ',
    }), ctx);
    const row = rows.get(created.id);

    expect(created.execution_mode_override).toBe('standard');
    expect(row?.reasoning_effort_override).toBeNull();
    expect(sessionStore.setSessionReasoningEffort).not.toHaveBeenCalledWith(created.id, 'ultra');
    expect(sessionStore.setSessionReasoningEffort).not.toHaveBeenCalledWith(created.id, 'UlTrA');
  });

  it('converts a legacy Ultra pseudo-effort when no first-class mode is supplied', async () => {
    const { handlers, rows } = createHarness();

    const created = await handlers.sessions.create(createInput({
      reasoning_effort: 'ultra',
    }), ctx);

    expect(created.execution_mode_override).toBe('ultra');
    expect(rows.get(created.id)?.reasoning_effort_override).toBeNull();
  });

  it('lets legacy effort clients leave Ultra through a native effort or provider default', async () => {
    const { handlers, rows } = createHarness();
    const created = await handlers.sessions.create(createInput({ reasoning_effort: 'ultra' }), ctx);

    const native = await handlers.sessions.setReasoningEffort({ id: created.id, effort: 'high' }, ctx);
    expect(native.execution_mode_override).toBe('standard');
    expect(rows.get(created.id)?.reasoning_effort_override).toBe('high');

    await handlers.sessions.setReasoningEffort({ id: created.id, effort: 'ultra' }, ctx);
    const providerDefault = await handlers.sessions.setReasoningEffort({ id: created.id, effort: null }, ctx);
    expect(providerDefault.execution_mode_override).toBe('standard');
    expect(rows.get(created.id)?.reasoning_effort_override).toBeNull();
  });

  it('validates a native effort before leaving Ultra', async () => {
    const { handlers, rows } = createHarness();
    const created = await handlers.sessions.create(createInput({ reasoning_effort: 'ultra' }), ctx);

    await expect(handlers.sessions.setReasoningEffort({
      id: created.id,
      effort: 'impossible',
    }, ctx)).rejects.toMatchObject({ code: 'bad_input', status: 400 });
    expect(rows.get(created.id)).toMatchObject({
      execution_mode_override: 'ultra',
      reasoning_effort_override: null,
    });
  });
});
