import type { ApiContext } from './common.js';

/**
 * Workspace = the sandbox filesystem + git facade the agent uses to make
 * edits. Distinct from the `files.ts` namespace (which is read/write of
 * the user's local project files) — `workspace.*` operates inside the
 * sandbox container of a company session.
 *
 * Source: apps/http-api/server/routes/workspace/{auth,file,tree,git,guards}.ts
 *
 * Gated by `guardWorkspaceRequest` (already exists) which validates the
 * caller has rights to the underlying company session.
 */

export interface WorkspaceTreeNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size?: number;
  children?: WorkspaceTreeNode[];
}

export interface WorkspaceApi {
  /** Resolve a short-lived workspace auth token tied to a session. */
  auth: {
    issue(input: { sessionId: number; scope?: 'read' | 'write' }, ctx: ApiContext): Promise<{ token: string; expires_at: number }>;
  };

  tree(input: { sessionId: number; root?: string; maxDepth?: number }, ctx: ApiContext): Promise<WorkspaceTreeNode>;

  file: {
    read(input: { sessionId: number; path: string }, ctx: ApiContext): Promise<{ content: string; encoding: 'utf8' | 'base64'; size: number }>;
    write(input: { sessionId: number; path: string; content: string; encoding?: 'utf8' | 'base64' }, ctx: ApiContext): Promise<{ ok: true }>;
    delete(input: { sessionId: number; path: string }, ctx: ApiContext): Promise<{ ok: true }>;
    rename(input: { sessionId: number; from: string; to: string }, ctx: ApiContext): Promise<{ ok: true }>;
  };

  git: {
    status(input: { sessionId: number }, ctx: ApiContext): Promise<unknown>;
    log(input: { sessionId: number; limit?: number; path?: string }, ctx: ApiContext): Promise<unknown[]>;
    diff(input: { sessionId: number; ref?: string; path?: string }, ctx: ApiContext): Promise<{ patch: string }>;
    branch: {
      list(input: { sessionId: number }, ctx: ApiContext): Promise<string[]>;
      current(input: { sessionId: number }, ctx: ApiContext): Promise<string>;
      checkout(input: { sessionId: number; name: string; create?: boolean }, ctx: ApiContext): Promise<void>;
    };
    commit(input: { sessionId: number; message: string; paths?: string[] }, ctx: ApiContext): Promise<{ sha: string }>;
    stash: {
      save(input: { sessionId: number; message?: string }, ctx: ApiContext): Promise<void>;
      pop(input: { sessionId: number }, ctx: ApiContext): Promise<void>;
    };
  };

  /** Resolve absolute filesystem paths inside the sandbox (debug). */
  paths(input: { sessionId: number; rel: string }, ctx: ApiContext): Promise<{ absolute: string; exists: boolean }>;
}
