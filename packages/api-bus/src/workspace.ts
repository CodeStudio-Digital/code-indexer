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
    issue(input: { sessionId: string; scope?: 'read' | 'write' }, ctx: ApiContext): Promise<{ token: string; expires_at: number }>;
  };

  tree(input: { sessionId: string; root?: string; maxDepth?: number }, ctx: ApiContext): Promise<WorkspaceTreeNode>;

  file: {
    read(input: { sessionId: string; path: string }, ctx: ApiContext): Promise<{ content: string; encoding: 'utf8' | 'base64'; size: number }>;
    write(input: { sessionId: string; path: string; content: string; encoding?: 'utf8' | 'base64' }, ctx: ApiContext): Promise<{ ok: true }>;
    delete(input: { sessionId: string; path: string }, ctx: ApiContext): Promise<{ ok: true }>;
    rename(input: { sessionId: string; from: string; to: string }, ctx: ApiContext): Promise<{ ok: true }>;
  };

  git: {
    status(input: { sessionId: string }, ctx: ApiContext): Promise<unknown>;
    log(input: { sessionId: string; limit?: number; path?: string }, ctx: ApiContext): Promise<unknown[]>;
    diff(input: { sessionId: string; ref?: string; path?: string }, ctx: ApiContext): Promise<{ patch: string }>;
    branch: {
      list(input: { sessionId: string }, ctx: ApiContext): Promise<string[]>;
      current(input: { sessionId: string }, ctx: ApiContext): Promise<string>;
      checkout(input: { sessionId: string; name: string; create?: boolean }, ctx: ApiContext): Promise<void>;
    };
    commit(input: { sessionId: string; message: string; paths?: string[] }, ctx: ApiContext): Promise<{ sha: string }>;
    stash: {
      save(input: { sessionId: string; message?: string }, ctx: ApiContext): Promise<void>;
      pop(input: { sessionId: string }, ctx: ApiContext): Promise<void>;
    };
  };

  /** Resolve absolute filesystem paths inside the sandbox (debug). */
  paths(input: { sessionId: string; rel: string }, ctx: ApiContext): Promise<{ absolute: string; exists: boolean }>;
}
