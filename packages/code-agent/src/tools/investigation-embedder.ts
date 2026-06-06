/**
 * Investigation embedder — a process-global hook that lets the investigation
 * ledger compute semantic embeddings without threading a callback through
 * `runCoder`'s options + ToolContext.
 *
 * Set ONCE at http-api boot (in-process path; see `apps/http-api/server/deps.ts`)
 * from the admin-configured `EmbeddingService`. Worker-thread runs
 * (`MCP_CODER_WORKER=1`) and unit tests never set it, so
 * `getInvestigationEmbedder()` returns null and `recall_investigations` falls
 * back to keyword search — the same in-process-only posture as project-memory
 * (Mem C). Mirrors the existing `setGlobalToolSelectionFilter` /
 * `setGlobalMcpExternalPool` boot-time singletons.
 *
 * Returns null (rather than throwing) on failure so callers can degrade
 * gracefully to keyword recall.
 */
export type InvestigationEmbedder = (text: string) => Promise<Float32Array | null>;

let embedder: InvestigationEmbedder | null = null;

export function setInvestigationEmbedder(fn: InvestigationEmbedder | null): void {
  embedder = fn;
}

export function getInvestigationEmbedder(): InvestigationEmbedder | null {
  return embedder;
}
