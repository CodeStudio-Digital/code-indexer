/**
 * Pure helpers for the cloud project LIBRARY (no React/I/O). A project "pointer"
 * is the synced doc that lets another machine/teammate clone the repo + restore
 * its API workspace. It rides the existing `project` sync kind: its `clientDocId`
 * IS the project's `workspaceId` (the same key the API workspace uses), so importing
 * = clone the git remote + seed that workspaceId + sync. Secrets never travel
 * (a pointer is a remote URL + names); we also strip credentials from the URL.
 */
import type { SyncPullItem, SyncPushItem } from '@mcp/api-bus';

export interface ProjectPointer {
  name: string;
  gitRemote: string;
  description?: string;
  defaultBranch?: string | null;
  /** The project's API-workspace id — also the pointer's clientDocId. */
  workspaceId: string;
}

/** Drop embedded credentials (`https://user:tok@host/…`) so a synced pointer never
 *  leaks a token. SSH (`git@host:…`) and clean https pass through unchanged. */
export function sanitizeGitRemote(url: string): string {
  try {
    const u = new URL(url);
    if (u.username || u.password) {
      u.username = '';
      u.password = '';
      return u.toString();
    }
    return url;
  } catch {
    return url; // non-URL (e.g. scp-style git@host:org/repo.git) — no creds to strip
  }
}

/** One push item for a project pointer (clientDocId = workspaceId). */
export function projectPointerToPush(pointer: ProjectPointer, baseVersion: number, nowMs: number): SyncPushItem {
  return {
    kind: 'project',
    clientDocId: pointer.workspaceId,
    baseVersion,
    updatedAtMs: nowMs,
    body: {
      name: pointer.name,
      gitRemote: sanitizeGitRemote(pointer.gitRemote),
      description: pointer.description ?? '',
      defaultBranch: pointer.defaultBranch ?? null,
    },
  };
}

export interface ProjectApplyAction {
  clientDocId: string;
  version: number;
  deleted: boolean;
  pointer: ProjectPointer | null;
}

/** From a pull, the project pointers newer than what we have (tombstones → null). */
export function planProjectApply(pulled: SyncPullItem[], knownVersion: (clientDocId: string) => number): ProjectApplyAction[] {
  return pulled
    .filter((d) => d.kind === 'project' && d.version > knownVersion(d.clientDocId))
    .map((d) => {
      const b = (d.body ?? {}) as Partial<ProjectPointer>;
      return {
        clientDocId: d.clientDocId,
        version: d.version,
        deleted: d.deleted,
        pointer: d.deleted ? null : { name: b.name ?? '', gitRemote: b.gitRemote ?? '', description: b.description ?? '', defaultBranch: b.defaultBranch ?? null, workspaceId: d.clientDocId },
      };
    });
}
