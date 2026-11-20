import type { ApiContext, AsyncStream } from './common.js';

/**
 * Company = multi-agent orchestration (master + subordinates), kanban,
 * sandboxes, services, QA, drive, inbox, etc.
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
  id: string;
  root_id: string;
  front_id: string | null;
  title: string;
  status: 'active' | 'paused' | 'archived' | 'interrupted';
  config_json: string;
  created_at: string;
  updated_at: string;
}

export interface CompanyApi {
  sessions: {
    list(input: { rootOnly?: boolean; archived?: boolean }, ctx: ApiContext): Promise<CompanySession[]>;
    get(input: { id: string }, ctx: ApiContext): Promise<CompanySession>;
    create(input: { title: string; config?: unknown; rootId?: string }, ctx: ApiContext): Promise<CompanySession>;
    update(input: { id: string; title?: string; config?: unknown }, ctx: ApiContext): Promise<CompanySession>;
    delete(input: { id: string }, ctx: ApiContext): Promise<void>;
    archive(input: { id: string; archived: boolean }, ctx: ApiContext): Promise<void>;
    children(input: { rootId: string }, ctx: ApiContext): Promise<CompanySession[]>;
    archives(input: void, ctx: ApiContext): Promise<CompanySession[]>;
  };

  /**
   * Real-time stream of company events (agent status, kanban changes,
   * sandbox events, etc.). In Electron this is a MessagePort; on
   * the HTTP API it's WebSocket (`/api/company/ws`) or SSE fallback.
   */
  stream(input: { sessionId: string; since?: number }, ctx: ApiContext): AsyncStream<{ event: string; data: unknown }>;

  kanban: {
    board(input: { sessionId: string }, ctx: ApiContext): Promise<unknown>;
    cards: {
      list(input: { sessionId: string; column?: string }, ctx: ApiContext): Promise<unknown[]>;
      create(input: { sessionId: string; column: string; title: string; body?: string }, ctx: ApiContext): Promise<unknown>;
      update(input: { cardId: string; title?: string; body?: string; column?: string }, ctx: ApiContext): Promise<unknown>;
      delete(input: { cardId: string }, ctx: ApiContext): Promise<void>;
      move(input: { cardId: string; toColumn: string; position?: number }, ctx: ApiContext): Promise<void>;
    };
  };

  board: {
    get(input: { sessionId: string }, ctx: ApiContext): Promise<unknown>;
    set(input: { sessionId: string; board: unknown }, ctx: ApiContext): Promise<void>;
  };

  inbox: {
    list(input: { sessionId: string }, ctx: ApiContext): Promise<unknown[]>;
    enqueue(input: { sessionId: string; message: unknown }, ctx: ApiContext): Promise<void>;
  };

  drive: {
    list(input: { sessionId: string; path?: string }, ctx: ApiContext): Promise<unknown[]>;
    read(input: { sessionId: string; path: string }, ctx: ApiContext): Promise<{ content: string }>;
    write(input: { sessionId: string; path: string; content: string }, ctx: ApiContext): Promise<void>;
    delete(input: { sessionId: string; path: string }, ctx: ApiContext): Promise<void>;
  };

  sandbox: {
    status(input: { sessionId: string }, ctx: ApiContext): Promise<unknown>;
    provision(input: { sessionId: string; image?: string }, ctx: ApiContext): Promise<unknown>;
    destroy(input: { sessionId: string }, ctx: ApiContext): Promise<void>;
    services: {
      list(input: { sessionId: string }, ctx: ApiContext): Promise<unknown[]>;
      create(input: { sessionId: string; kind: string; config: unknown }, ctx: ApiContext): Promise<unknown>;
      delete(input: { sessionId: string; id: string }, ctx: ApiContext): Promise<void>;
      runtime: {
        start(input: { sessionId: string; id: string }, ctx: ApiContext): Promise<void>;
        stop(input: { sessionId: string; id: string }, ctx: ApiContext): Promise<void>;
        status(input: { sessionId: string; id: string }, ctx: ApiContext): Promise<unknown>;
      };
    };
  };

  envs: {
    get(input: { sessionId: string }, ctx: ApiContext): Promise<Record<string, string>>;
    set(input: { sessionId: string; vars: Record<string, string> }, ctx: ApiContext): Promise<void>;
  };

  databases: {
    list(input: { sessionId: string }, ctx: ApiContext): Promise<unknown[]>;
    create(input: { sessionId: string; kind: 'postgres' | 'mysql' | 'sqlite'; config: unknown }, ctx: ApiContext): Promise<unknown>;
    delete(input: { sessionId: string; id: string }, ctx: ApiContext): Promise<void>;
  };

  docs: {
    list(input: { sessionId: string }, ctx: ApiContext): Promise<unknown[]>;
    attach(input: { sessionId: string; collectionId: number }, ctx: ApiContext): Promise<void>;
    detach(input: { sessionId: string; collectionId: number }, ctx: ApiContext): Promise<void>;
  };

  qa: {
    runs: {
      list(input: { sessionId: string }, ctx: ApiContext): Promise<unknown[]>;
      create(input: { sessionId: string; plan: unknown }, ctx: ApiContext): Promise<unknown>;
      get(input: { runId: string }, ctx: ApiContext): Promise<unknown>;
    };
    artifacts: {
      list(input: { runId: string }, ctx: ApiContext): Promise<unknown[]>;
      get(input: { runId: string; path: string }, ctx: ApiContext): Promise<{ content: string }>;
    };
    diagnostics(input: { sessionId: string }, ctx: ApiContext): Promise<unknown>;
    restoreConfig(input: { sessionId: string }, ctx: ApiContext): Promise<void>;
  };

  templates: {
    list(input: void, ctx: ApiContext): Promise<unknown[]>;
    get(input: { id: string }, ctx: ApiContext): Promise<unknown>;
  };

  recommendations(input: { sessionId: string }, ctx: ApiContext): Promise<unknown[]>;

  localProject: {
    status(input: { sessionId: string }, ctx: ApiContext): Promise<unknown>;
    start(input: { sessionId: string; command: string; cwd?: string }, ctx: ApiContext): Promise<{ pid: number }>;
    stop(input: { sessionId: string }, ctx: ApiContext): Promise<void>;
  };

  openapi(input: { sessionId: string; serviceId: string }, ctx: ApiContext): Promise<unknown>;
}
