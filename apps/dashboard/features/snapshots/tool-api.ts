import type { SessionScope, SnapshotFileDiff, ToolSnapshotFileSummary } from './types.js';

function base(scope: SessionScope, sessionId: string, toolUseId: string) {
  return `/api/${scope}/sessions/${encodeURIComponent(sessionId)}/snapshot/tool/${encodeURIComponent(toolUseId)}`;
}

export async function fetchToolSnapshots(scope: SessionScope, sessionId: string, toolUseId: string, signal: AbortSignal) {
  const response = await fetch(base(scope, sessionId, toolUseId), { signal });
  if (!response.ok) throw new Error(`Could not load edit snapshot: ${response.status}`);
  return await response.json() as { files: ToolSnapshotFileSummary[] };
}

export async function fetchToolFileDiff(scope: SessionScope, sessionId: string, toolUseId: string, fileIndex: number,
  contextBefore: number, contextAfter: number): Promise<SnapshotFileDiff> {
  const response = await fetch(`${base(scope, sessionId, toolUseId)}/file/${fileIndex}/diff?contextBefore=${contextBefore}&contextAfter=${contextAfter}`);
  if (!response.ok) throw new Error(`Could not load edit diff: ${response.status}`);
  return await response.json() as SnapshotFileDiff;
}
