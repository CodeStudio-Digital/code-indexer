export interface TreeEntry {
  name: string;
  type: 'file' | 'dir';
  size: number | null;
}

export interface TreeResponse {
  path: string;
  entries: TreeEntry[];
}

export interface FileReadResponse {
  content: string;
  encoding: 'utf-8' | 'base64';
  truncated: boolean;
  size: number;
  isBinary: boolean;
}

export interface GitFileStatus {
  path: string;
  index: string;
  worktree: string;
}

export interface GitStatusResponse {
  isRepo: boolean;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitFileStatus[];
}

export interface GitDiffResponse {
  diff: string;
  truncated: boolean;
}

export interface GitLogEntry {
  hash: string;
  subject: string;
}

function base(sessionId: number, projectId: number): string {
  return `/api/company/sessions/${sessionId}/projects/${projectId}`;
}

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as T;
}

export interface ApiError extends Error {
  status: number;
  code?: string;
}

async function postJson<T>(url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method: 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) {
    let message = `HTTP ${r.status}`;
    let code: string | undefined;
    try {
      const j = (await r.json()) as { error?: string; code?: string };
      if (j?.error) message = j.error;
      if (j?.code) code = j.code;
    } catch {
      /* keep HTTP status as message */
    }
    const err = new Error(message) as ApiError;
    err.status = r.status;
    err.code = code;
    throw err;
  }
  return (await r.json()) as T;
}

export interface SuggestedCommitGroup {
  title: string;
  paths: string[];
  rationale: string;
}

export const workspaceApi = {
  tree: (sid: number, pid: number, path: string) =>
    getJson<TreeResponse>(`${base(sid, pid)}/tree?path=${encodeURIComponent(path)}`),
  file: (sid: number, pid: number, path: string) =>
    getJson<FileReadResponse>(`${base(sid, pid)}/file?path=${encodeURIComponent(path)}`),
  gitStatus: (sid: number, pid: number) =>
    getJson<GitStatusResponse>(`${base(sid, pid)}/git/status`),
  gitDiff: (sid: number, pid: number, path?: string, staged?: boolean) => {
    const q = new URLSearchParams();
    if (path) q.set('path', path);
    if (staged) q.set('staged', 'true');
    return getJson<GitDiffResponse>(`${base(sid, pid)}/git/diff?${q.toString()}`);
  },
  gitLog: (sid: number, pid: number, limit = 30) =>
    getJson<{ entries: GitLogEntry[] }>(`${base(sid, pid)}/git/log?limit=${limit}`),
  gitInit: (sid: number, pid: number) =>
    postJson<{ ok: boolean; status: GitStatusResponse }>(`${base(sid, pid)}/git/init`),
  gitAdd: (sid: number, pid: number, paths: string[]) =>
    postJson<{ ok: boolean; status: GitStatusResponse }>(`${base(sid, pid)}/git/add`, { paths }),
  gitReset: (sid: number, pid: number, paths: string[]) =>
    postJson<{ ok: boolean; status: GitStatusResponse }>(`${base(sid, pid)}/git/reset`, { paths }),
  gitDiscard: (sid: number, pid: number, paths: string[]) =>
    postJson<{ ok: boolean; status: GitStatusResponse }>(`${base(sid, pid)}/git/discard`, { paths }),
  gitCommit: (sid: number, pid: number, message: string) =>
    postJson<{ ok: boolean; hash: string | null; status: GitStatusResponse }>(
      `${base(sid, pid)}/git/commit`,
      { message },
    ),
  gitPush: (sid: number, pid: number) =>
    postJson<{ ok: boolean; message: string; setUpstream: boolean; status: GitStatusResponse }>(
      `${base(sid, pid)}/git/push`,
    ),
  suggestCommitMessage: (sid: number, pid: number) =>
    postJson<{ message: string }>(`${base(sid, pid)}/git/suggest-commit-message`),
  suggestStaging: (sid: number, pid: number) =>
    postJson<{ groups: SuggestedCommitGroup[] }>(`${base(sid, pid)}/git/suggest-staging`),
};
