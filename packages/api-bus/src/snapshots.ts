import type { ApiContext } from './common.js';

/**
 * Project snapshots — curated notes attached to projects. Route source:
 * apps/http-api/server/routes/snapshots.ts.
 */

export type SnapshotCategory = 'note' | 'requirement' | 'decision' | 'context' | string;

export interface Snapshot {
  id: number;
  project_id: number;
  title: string;
  category: SnapshotCategory;
  content: string;
  tags: string[];
  created_at: string;
  updated_at: string;
}

export interface SnapshotsApi {
  list(input: { projectId: number; category?: SnapshotCategory }, ctx: ApiContext): Promise<Snapshot[]>;
  create(
    input: { projectId: number; title: string; category: SnapshotCategory; content: string; tags?: string[] },
    ctx: ApiContext,
  ): Promise<Snapshot & { embed_error: string | null }>;
  update(
    input: {
      id: number;
      title?: string;
      category?: SnapshotCategory;
      content?: string;
      tags?: string[];
      /** 0..1 retrieval salience — the Memory tab "pin" boost. */
      importance?: number;
    },
    ctx: ApiContext,
  ): Promise<{ ok: true; embed_error: string | null }>;
  delete(input: { id: number }, ctx: ApiContext): Promise<{ ok: true }>;

  /** Concatenated text for use as model context. */
  getForContext(input: { projectId: number }, ctx: ApiContext): Promise<string>;
  history(input: { id: number }, ctx: ApiContext): Promise<Snapshot[]>;
}
