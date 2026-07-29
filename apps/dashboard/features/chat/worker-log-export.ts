/**
 * Export helpers for the Worker Log panel. Prefers the server's authoritative
 * JSONL/summary endpoints (full run history) and falls back to the in-memory
 * entries the panel is currently holding. Kept out of the panel component so
 * the view file stays focused on rendering.
 */
import type { WorkerLogEntry } from '../../hooks/agent-stream/types.js';

export async function exportWorkerLogs(
  entries: readonly WorkerLogEntry[],
  sessionId: string | null,
  kind: 'coder' | 'company',
): Promise<void> {
  const backend = sessionId != null ? await fetchRuntimeLogs(kind, sessionId) : null;
  const jsonl = backend?.jsonl ?? entries.map((entry) => JSON.stringify(entry)).join('\n');
  const summary = backend?.summary ?? buildExportSummary(entries);
  downloadText(`worker-log-${Date.now()}.jsonl`, jsonl, 'application/x-ndjson');
  downloadText(`worker-log-summary-${Date.now()}.json`, JSON.stringify(summary, null, 2), 'application/json');
}

async function fetchRuntimeLogs(
  kind: 'coder' | 'company',
  sessionId: string,
): Promise<{ jsonl: string; summary: unknown } | null> {
  try {
    const base = `/api/${kind}/sessions/${sessionId}`;
    const [jsonlRes, summaryRes] = await Promise.all([
      fetch(`${base}/events.jsonl`),
      fetch(`${base}/events-summary`),
    ]);
    if (!jsonlRes.ok || !summaryRes.ok) return null;
    return { jsonl: await jsonlRes.text(), summary: await summaryRes.json() };
  } catch {
    return null;
  }
}

function buildExportSummary(entries: readonly WorkerLogEntry[]): Record<string, unknown> {
  const operations = new Map<string, WorkerLogEntry>();
  const agents = new Map<string, WorkerLogEntry>();
  for (const entry of entries) {
    const data = entry.data && typeof entry.data === 'object' ? entry.data as Record<string, unknown> : {};
    if (String(data.opId ?? '')) operations.set(String(data.opId), entry);
    if (data.groupId != null && data.agentIndex != null) {
      agents.set(`${String(data.groupId)}:${String(data.agentIndex)}`, entry);
    }
  }
  return {
    eventCount: entries.length,
    firstTs: entries[0]?.ts ?? null,
    lastTs: entries.at(-1)?.ts ?? null,
    lastEventByOperation: Object.fromEntries(operations),
    lastEventByAgent: Object.fromEntries(agents),
    timeouts: entries.filter((e) => {
      const raw = String(JSON.stringify(e.data) ?? '');
      return raw.includes('timed_out') || raw.includes('timeout');
    }),
  };
}

function downloadText(filename: string, text: string, type: string): void {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
