import type { ApiContext, AsyncStream } from './common.js';

/**
 * Company = multi-agent orchestration (master + subordinates), pipelines,
 * kanban, sandboxes, services, QA, drive, inbox, etc.
 *
 * This is the largest namespace by route count (~30+ files under
 * apps/http-api/server/routes/company/*). The interfaces below cover the
 * high-level operations the dashboard hits; shapes for nested objects
 * are loose — refined by handlers using @mcp/company canonical types.
 *
 * Tier gate: `requireTier('pro')` on all mutations + session creation
 * (Freemium plan).
 */

export interface CompanySession {
  id: number;
  root_id: number;
  front_id: number | null;
  title: string;
  status: 'active' | 'paused' | 'archived' | 'interrupted';
  config_json: string;
  created_at: string;
  updated_at: string;
}

export interface CompanyApi {
  sessions: {
    list(input: { rootOnly?: boolean; archived?: boolean }, ctx: ApiContext): Promise<CompanySession[]>;
    get(input: { id: number }, ctx: ApiContext): Promise<CompanySession>;
    create(input: { title: string; config?: unknown; rootId?: number }, ctx: ApiContext): Promise<CompanySession>;
    update(input: { id: number; title?: string; config?: unknown }, ctx: ApiContext): Promise<CompanySession>;
    delete(input: { id: number }, ctx: ApiContext): Promise<void>;
    archive(input: { id: number; archived: boolean }, ctx: ApiContext): Promise<void>;
    children(input: { rootId: number }, ctx: ApiContext): Promise<CompanySession[]>;
    archives(input: void, ctx: ApiContext): Promise<CompanySession[]>;
  };

  /**
   * Real-time stream of company events (agent status, kanban changes,
   * sandbox events, etc.). In Electron this is a MessagePort; on
   * Hono it's WebSocket (`/api/company/ws`) or SSE fallback.
   */
  stream(input: { sessionId: number; since?: number }, ctx: ApiContext): AsyncStream<{ event: string; data: unknown }>;

  kanban: {
    board(input: { sessionId: number }, ctx: ApiContext): Promise<unknown>;
    cards: {
      list(input: { sessionId: number; column?: string }, ctx: ApiContext): Promise<unknown[]>;
      create(input: { sessionId: number; column: string; title: string; body?: string }, ctx: ApiContext): Promise<unknown>;
      update(input: { cardId: number; title?: string; body?: string; column?: string }, ctx: ApiContext): Promise<unknown>;
      delete(input: { cardId: number }, ctx: ApiContext): Promise<void>;
      move(input: { cardId: number; toColumn: string; position?: number }, ctx: ApiContext): Promise<void>;
    };
  };

  board: {
    get(input: { sessionId: number }, ctx: ApiContext): Promise<unknown>;
    set(input: { sessionId: number; board: unknown }, ctx: ApiContext): Promise<void>;
  };

  inbox: {
    list(input: { sessionId: number }, ctx: ApiContext): Promise<unknown[]>;
    enqueue(input: { sessionId: number; message: unknown }, ctx: ApiContext): Promise<void>;
  };

  drive: {
    list(input: { sessionId: number; path?: string }, ctx: ApiContext): Promise<unknown[]>;
    read(input: { sessionId: number; path: string }, ctx: ApiContext): Promise<{ content: string }>;
    write(input: { sessionId: number; path: string; content: string }, ctx: ApiContext): Promise<void>;
    delete(input: { sessionId: number; path: string }, ctx: ApiContext): Promise<void>;
  };

  sandbox: {
    status(input: { sessionId: number }, ctx: ApiContext): Promise<unknown>;
    provision(input: { sessionId: number; image?: string }, ctx: ApiContext): Promise<unknown>;
    destroy(input: { sessionId: number }, ctx: ApiContext): Promise<void>;
    services: {
      list(input: { sessionId: number }, ctx: ApiContext): Promise<unknown[]>;
      create(input: { sessionId: number; kind: string; config: unknown }, ctx: ApiContext): Promise<unknown>;
      delete(input: { sessionId: number; id: string }, ctx: ApiContext): Promise<void>;
      runtime: {
        start(input: { sessionId: number; id: string }, ctx: ApiContext): Promise<void>;
        stop(input: { sessionId: number; id: string }, ctx: ApiContext): Promise<void>;
        status(input: { sessionId: number; id: string }, ctx: ApiContext): Promise<unknown>;
      };
    };
  };

  envs: {
    get(input: { sessionId: number }, ctx: ApiContext): Promise<Record<string, string>>;
    set(input: { sessionId: number; vars: Record<string, string> }, ctx: ApiContext): Promise<void>;
  };

  databases: {
    list(input: { sessionId: number }, ctx: ApiContext): Promise<unknown[]>;
    create(input: { sessionId: number; kind: 'postgres' | 'mysql' | 'sqlite'; config: unknown }, ctx: ApiContext): Promise<unknown>;
    delete(input: { sessionId: number; id: string }, ctx: ApiContext): Promise<void>;
  };

  docs: {
    list(input: { sessionId: number }, ctx: ApiContext): Promise<unknown[]>;
    attach(input: { sessionId: number; collectionId: number }, ctx: ApiContext): Promise<void>;
    detach(input: { sessionId: number; collectionId: number }, ctx: ApiContext): Promise<void>;
  };

  qa: {
    runs: {
      list(input: { sessionId: number }, ctx: ApiContext): Promise<unknown[]>;
      create(input: { sessionId: number; plan: unknown }, ctx: ApiContext): Promise<unknown>;
      get(input: { runId: number }, ctx: ApiContext): Promise<unknown>;
    };
    artifacts: {
      list(input: { runId: number }, ctx: ApiContext): Promise<unknown[]>;
      get(input: { runId: number; path: string }, ctx: ApiContext): Promise<{ content: string }>;
    };
    diagnostics(input: { sessionId: number }, ctx: ApiContext): Promise<unknown>;
    restoreConfig(input: { sessionId: number }, ctx: ApiContext): Promise<void>;
  };

  pipelines: {
    list(input: { sessionId: number }, ctx: ApiContext): Promise<unknown[]>;
    execute(input: { sessionId: number; pipelineId: string; params?: unknown }, ctx: ApiContext): Promise<unknown>;
    status(input: { sessionId: number; pipelineId: string }, ctx: ApiContext): Promise<unknown>;
  };

  templates: {
    list(input: void, ctx: ApiContext): Promise<unknown[]>;
    get(input: { id: string }, ctx: ApiContext): Promise<unknown>;
  };

  recommendations(input: { sessionId: number }, ctx: ApiContext): Promise<unknown[]>;

  localProject: {
    status(input: { sessionId: number }, ctx: ApiContext): Promise<unknown>;
    start(input: { sessionId: number; command: string; cwd?: string }, ctx: ApiContext): Promise<{ pid: number }>;
    stop(input: { sessionId: number }, ctx: ApiContext): Promise<void>;
  };

  openapi(input: { sessionId: number; serviceId: string }, ctx: ApiContext): Promise<unknown>;
}
