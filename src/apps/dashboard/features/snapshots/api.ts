import { apiPost } from '../../hooks/useApi.js';
import type { SessionScope, SnapshotFileDiff, SnapshotFileSummary } from './types.js';

/**
 * The same handlers work for `/coder/sessions/...` and `/company/sessions/...`
 * because the route shapes are mirrored on the server. The `scope` arg picks
 * the prefix.
 */
function base(scope: SessionScope, sessionId: number): string {
  return `/${scope}/sessions/${sessionId}/snapshot`;
}

export async function fetchSnapshotList(
  scope: SessionScope,
  sessionId: number,
  opts: { includeClosed?: boolean } = {},
): Promise<{ files: SnapshotFileSummary[] }> {
  const qs = opts.includeClosed ? '?includeClosed=1' : '';
  const r = await fetch(`/api${base(scope, sessionId)}${qs}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as { files: SnapshotFileSummary[] };
}

export async function fetchFileDiff(
  scope: SessionScope,
  sessionId: number,
  baselineId: number,
): Promise<SnapshotFileDiff> {
  const r = await fetch(`/api${base(scope, sessionId)}/file/${baselineId}/diff`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as SnapshotFileDiff;
}

export const acceptHunk = (
  scope: SessionScope,
  sessionId: number,
  baselineId: number,
  fingerprint: string,
) =>
  apiPost<{ ok: boolean; closed: boolean; reason?: string }>(
    `${base(scope, sessionId)}/file/${baselineId}/accept-hunk`,
    { fingerprint },
  );

export const revertHunk = (
  scope: SessionScope,
  sessionId: number,
  baselineId: number,
  fingerprint: string,
) =>
  apiPost<{ ok: boolean; closed: boolean; reason?: string }>(
    `${base(scope, sessionId)}/file/${baselineId}/revert-hunk`,
    { fingerprint },
  );

export const acceptFile = (scope: SessionScope, sessionId: number, baselineId: number) =>
  apiPost<{ ok: boolean }>(`${base(scope, sessionId)}/file/${baselineId}/accept`, {});

export const revertFile = (scope: SessionScope, sessionId: number, baselineId: number) =>
  apiPost<{ ok: boolean; reason?: string }>(`${base(scope, sessionId)}/file/${baselineId}/revert`, {});

export const acceptAll = (scope: SessionScope, sessionId: number) =>
  apiPost<{ closed: number }>(`${base(scope, sessionId)}/accept-all`, {});

export const revertAll = (scope: SessionScope, sessionId: number) =>
  apiPost<{ closed: number }>(`${base(scope, sessionId)}/revert-all`, { confirm: true });
