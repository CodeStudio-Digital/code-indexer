import type { FileSessionRepository, SessionCatalog, SessionId } from '@mcp/session-storage';
import type { CodeIndexDB } from '@mcp/store/db.js';
import type { RunEndMemory } from '@mcp/services/memory/run-end.js';
import type { AgentMemoryService } from '@mcp/services/memory/agent-memory-service.js';
/**
 * Idle memory sweeper — the "session went quiet" distill moment.
 *
 * Candidate discovery, transcript boundaries, retry state and diagnostics are
 * filesystem-backed. Durable project memory itself remains an intentionally
 * shared project/global catalog.
 */
import { createCoderProvider } from '@mcp/services/providers/factory.js';
import { summarizeSpanV2 } from '@mcp/code-agent/core/summarizer.js';

export const DEFAULT_INTERVAL_MS = Number(process.env.MCP_MEMORY_SWEEP_INTERVAL_MS ?? 5 * 60 * 1000);

export const DEFAULT_IDLE_AFTER_MS = Number(process.env.MCP_MEMORY_IDLE_AFTER_MS ?? 10 * 60 * 1000);

export const DEFAULT_MAX_PER_SWEEP = Number(process.env.MCP_MEMORY_SWEEP_MAX_SESSIONS ?? 2);

export const DEFAULT_MAX_CANDIDATES_INSPECTED = Number(
  process.env.MCP_MEMORY_SWEEP_MAX_CANDIDATES_INSPECTED ?? 16,
);

export const MIN_SPAN_MESSAGES = 4;

export const STEP_TIMEOUT_MS = 60_000;

export const MAX_DISTILL_ATTEMPTS = 3;

export const MAX_UNCHANGED_SESSION_MARKERS = 1_024;

export interface MemorySweepCandidate {
  session_id: SessionId;
  project_id: number;
  provider: string;
  model: string;
  distilled_mark: number;
  attempts: number;
  updated_at_ms: number;
}

export function record(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function nonNegativeInteger(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? value as number
    : 0;
}

export function memorySweeperEnabled(): boolean {
  const raw = process.env.MCP_MEMORY_SWEEPER;
  if (raw == null || raw === '') return true;
  const value = raw.toLowerCase();
  return value !== '0' && value !== 'false' && value !== 'off';
}

export interface MemorySweeperHandle {
  stop(): void;
  runOnce(): Promise<number>;
  readonly intervalMs: number;
  readonly idleAfterMs: number;
}

export interface StartMemorySweeperArgs {
  sessionStore: MemorySweeperSessionStore;
  db: CodeIndexDB;
  runEndMemory: RunEndMemory;
  agentMemoryService?: AgentMemoryService;
  /** Live worker truth. Persisted session status can lag while a worker owns it. */
  isSessionActive?: (sessionId: SessionId) => boolean;
  /** Optional performance-journal activity hooks owned by the main process. */
  enterBackgroundActivity?: (label: string) => number;
  exitBackgroundActivity?: (token: number) => void;
  intervalMs?: number;
  idleAfterMs?: number;
  maxPerSweep?: number;
  /** Bound candidate metadata/tail checks per interval and rotate fairly. */
  maxCandidatesInspected?: number;
  providerFactory?: typeof createCoderProvider;
}

export interface MemorySweeperSessionStore {
  ensureCatalog(): Promise<void>;
  readonly catalog: Pick<SessionCatalog, 'list'>;
  readonly repository: Pick<FileSessionRepository, 'readStateSync'>;
  maxMessageSeq(sessionId: SessionId): Promise<number>;
  listMessagesAfter(
    sessionId: SessionId,
    afterSeq: number,
  ): Promise<{
    messages: Parameters<typeof summarizeSpanV2>[0];
    maxSeq: number;
  }>;
  getCommandTrail(
    sessionId: SessionId,
  ): Promise<Array<{ command: string; isError: boolean }>>;
  didRunSucceed(sessionId: SessionId): Promise<boolean>;
  listSessionMemory(sessionId: SessionId): Promise<Array<{
    title: string;
    body: string;
    kind: string;
    pinned: boolean;
  }>>;
  setMemoryDistilledBoundary(
    sessionId: SessionId,
    seq: number,
  ): Promise<void>;
  resetMemoryDistillAttempts(sessionId: SessionId): Promise<void>;
  bumpMemoryDistillAttempts(sessionId: SessionId): Promise<void>;
  appendSessionEvent(
    sessionId: SessionId,
    type: string,
    payload: unknown,
    operationId?: string,
  ): Promise<unknown>;
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}
