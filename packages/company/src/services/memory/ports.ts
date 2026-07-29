import type { SessionId } from '@mcp/session-storage';

/**
 * Project-memory ports for company sessions (Mem C).
 *
 * Company spawns run inside the company-worker (worker_thread), where the
 * canonical MemoryRetriever/RunEndMemory instances from the main process
 * are unreachable. The worker boot calls `setCompanyMemoryPorts()` with the
 * bridge-backed shims (`apps/http-api/workers/memory-shims.ts`), and
 * spawn/resume read them via `getCompanyMemoryPorts()` to (a) build the
 * PROJECT MEMORY prompt block and (b) hand `memoryRetriever`/`runEndMemory`
 * to `runCoder` for per-turn injection + run-end distillation.
 *
 * Module-global setter mirrors `setEnvToolStore` (tools/env-tools.ts):
 * worker_threads don't share module state, so the worker MUST set this in
 * its own module graph at boot. Null (tests, unwired hosts) degrades to
 * "no memory" — never an error.
 *
 * Shapes are structural mirrors of `RunCoderOptions.memoryRetriever` /
 * `.runEndMemory` so the same object plugs into runCoder unchanged.
 */

export interface CompanyMemoryItem {
  id: string;
  title: string;
  content: string;
  importance?: number;
  staleNote?: string;
}

export interface CompanyRunEndInput {
  primaryRequest?: string;
  summary?: string;
  filesTouched?: string[];
  errorsAndFixes?: string[];
  toolTrail?: string[];
  succeeded?: boolean;
  /** Distill moment for the diagnostics log (mirrors RunCoderOptions). */
  trigger?: string;
  sessionId?: SessionId;
  sessionNotes?: Array<{ title: string; body: string; kind: string; pinned: boolean }>;
}

export interface CompanyMemoryPorts {
  memoryRetriever: {
    retrieve(
      projectId: number,
      projectName: string,
      taskText: string,
    ): Promise<ReadonlyArray<CompanyMemoryItem>>;
  };
  runEndMemory: {
    extractAndPersist(
      projectId: number,
      projectName: string,
      input: CompanyRunEndInput,
    ): Promise<{ created: number; merged: number; skipped: number } | void>;
    isConfigured(): Promise<boolean>;
  };
}

let ports: CompanyMemoryPorts | null = null;

export function setCompanyMemoryPorts(next: CompanyMemoryPorts | null): void {
  ports = next;
}

export function getCompanyMemoryPorts(): CompanyMemoryPorts | null {
  return ports;
}
