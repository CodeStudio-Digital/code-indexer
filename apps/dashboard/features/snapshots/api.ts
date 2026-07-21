import { apiPatch, apiPost } from '../../hooks/useApi.js';
import type {
  SessionScope,
  SnapshotFileDiff,
  SnapshotFileSummary,
  SnapshotReviewComment,
  SnapshotReviewsResponse,
  RoundSnapshotFileSummary,
  RoundSnapshotReviewFinding,
} from './types.js';

/**
 * The same handlers work for `/coder/sessions/...` and `/company/sessions/...`
 * because the route shapes are mirrored on the server. The `scope` arg picks
 * the prefix.
 */
function base(scope: SessionScope, sessionId: number): string {
  return `/${scope}/sessions/${sessionId}/snapshot`;
}

async function readError(res: Response, fallback: string): Promise<Error> {
  try {
    const body = await res.json() as { error?: unknown };
    if (typeof body.error === 'string') return new Error(`HTTP ${res.status}: ${body.error}`);
  } catch {
    /* keep fallback */
  }
  return new Error(`HTTP ${res.status}: ${fallback}`);
}

export async function fetchSnapshotList(
  scope: SessionScope,
  sessionId: number,
  opts: { includeClosed?: boolean } = {},
): Promise<{ files: SnapshotFileSummary[] }> {
  const qs = opts.includeClosed ? '?includeClosed=1' : '';
  const r = await fetch(`/api${base(scope, sessionId)}${qs}`);
  if (!r.ok) throw await readError(r, 'Could not load snapshots');
  return (await r.json()) as { files: SnapshotFileSummary[] };
}

export async function fetchFileDiff(
  scope: SessionScope,
  sessionId: number,
  baselineId: number,
  opts: { context?: number; contextBefore?: number; contextAfter?: number } = {},
): Promise<SnapshotFileDiff> {
  const qs = new URLSearchParams();
  if (opts.context != null) qs.set('context', String(opts.context));
  if (opts.contextBefore != null) qs.set('contextBefore', String(opts.contextBefore));
  if (opts.contextAfter != null) qs.set('contextAfter', String(opts.contextAfter));
  const suffix = qs.size > 0 ? `?${qs.toString()}` : '';
  const r = await fetch(`/api${base(scope, sessionId)}/file/${baselineId}/diff${suffix}`);
  if (!r.ok) throw await readError(r, 'Could not load diff');
  return (await r.json()) as SnapshotFileDiff;
}

export async function fetchRoundSnapshotList(
  scope: SessionScope,
  sessionId: number,
  roundMessageId: number,
  signal?: AbortSignal,
): Promise<{
  roundMessageId: number;
  files: RoundSnapshotFileSummary[];
  reviews: RoundSnapshotReviewFinding[];
}> {
  const r = await fetch(`/api${base(scope, sessionId)}/round/${roundMessageId}`, { signal });
  if (!r.ok) throw await readError(r, 'Could not load round snapshots');
  return await r.json() as {
    roundMessageId: number;
    files: RoundSnapshotFileSummary[];
    reviews: RoundSnapshotReviewFinding[];
  };
}

export async function fetchRoundFileDiff(
  scope: SessionScope,
  sessionId: number,
  roundMessageId: number,
  roundSnapshotId: number,
  opts: { context?: number; contextBefore?: number; contextAfter?: number } = {},
): Promise<SnapshotFileDiff> {
  const qs = new URLSearchParams();
  if (opts.context != null) qs.set('context', String(opts.context));
  if (opts.contextBefore != null) qs.set('contextBefore', String(opts.contextBefore));
  if (opts.contextAfter != null) qs.set('contextAfter', String(opts.contextAfter));
  const suffix = qs.size > 0 ? `?${qs.toString()}` : '';
  const r = await fetch(
    `/api${base(scope, sessionId)}/round/${roundMessageId}/file/${roundSnapshotId}/diff${suffix}`,
  );
  if (!r.ok) throw await readError(r, 'Could not load round diff');
  return await r.json() as SnapshotFileDiff;
}

export const acceptRoundHunk = (
  scope: SessionScope,
  sessionId: number,
  roundMessageId: number,
  roundSnapshotId: number,
  fingerprint: string,
) => apiPost<{ ok: boolean; closed: boolean; reason?: string }>(
  `${base(scope, sessionId)}/round/${roundMessageId}/file/${roundSnapshotId}/accept-hunk`,
  { fingerprint },
);

export const revertRoundHunk = (
  scope: SessionScope,
  sessionId: number,
  roundMessageId: number,
  roundSnapshotId: number,
  fingerprint: string,
) => apiPost<{ ok: boolean; closed: boolean; reason?: string }>(
  `${base(scope, sessionId)}/round/${roundMessageId}/file/${roundSnapshotId}/revert-hunk`,
  { fingerprint },
);

export const revertRoundAll = (
  scope: SessionScope,
  sessionId: number,
  roundMessageId: number,
) => apiPost<{
  ok: boolean;
  reverted: number;
  conflicts: Array<{ filePath: string; reason: string }>;
}>(`${base(scope, sessionId)}/round/${roundMessageId}/revert-all`, { confirm: true });

export const runRoundAutoReview = (
  scope: SessionScope,
  sessionId: number,
  roundMessageId: number,
) => apiPost<{ reviews: RoundSnapshotReviewFinding[]; message?: string }>(
  `${base(scope, sessionId)}/round/${roundMessageId}/review`,
  {},
);

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

export async function fetchSnapshotReviews(
  scope: SessionScope,
  sessionId: number,
): Promise<SnapshotReviewsResponse> {
  const r = await fetch(`/api${base(scope, sessionId)}/reviews`);
  if (!r.ok) throw await readError(r, 'Could not load snapshot reviews');
  return (await r.json()) as SnapshotReviewsResponse;
}

export const createReviewComment = (
  scope: SessionScope,
  sessionId: number,
  body: {
    baselineId: number;
    filePath: string;
    hunkFingerprint?: string | null;
    oldLine?: number | null;
    newLine?: number | null;
    severity?: string | null;
    body: string;
    suggestedFix?: string | null;
    diffExcerpt?: string | null;
  },
) =>
  apiPost<{ comment: SnapshotReviewComment }>(`${base(scope, sessionId)}/reviews/comments`, body);

export const patchReviewComment = (
  scope: SessionScope,
  sessionId: number,
  commentId: number,
  body: Partial<Pick<SnapshotReviewComment, 'status' | 'body' | 'severity'>> & { suggestedFix?: string | null },
) =>
  apiPatch<{ comment: SnapshotReviewComment }>(
    `${base(scope, sessionId)}/reviews/comments/${commentId}`,
    body,
  );

export const runAutoReview = (scope: SessionScope, sessionId: number) =>
  apiPost<{ comments: SnapshotReviewComment[]; message?: string }>(`${base(scope, sessionId)}/reviews/auto`, {});

export const submitReviewComments = (
  scope: SessionScope,
  sessionId: number,
  commentIds: number[],
) =>
  apiPost<{
    message: string;
    comments: SnapshotReviewComment[];
    delivered?: boolean | null;
    pending?: string | null;
  }>(
    `${base(scope, sessionId)}/reviews/submit`,
    { commentIds },
  );
