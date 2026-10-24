import { isAbsolute, relative } from 'node:path';

import { type DirtyEvent } from './types.js';

export type EnsureFreshReason = 'open' | 'scaffold' | 'session' | 'manual' | 'branch' | 'workspace' | 'poll';

export interface SemanticCatchupHooks {
  noteDelta(
    projectId: number,
    events: readonly DirtyEvent[],
    previousItemKeys?: readonly string[],
  ): void;
  ensureProject(projectId: number): Promise<void>;
  /** Open-project lifecycle hand-off after an integral structural baseline exists. */
  projectReady?(projectId: number): void | Promise<void>;
  /** Final view/lease release; semantic backfill may pause after its current batch. */
  projectInactive?(projectId: number): void | Promise<void>;
}

export const DRAIN_BATCH = 200;
export const PROGRESS_MIN_INTERVAL_MS = 150;
export const LARGE_PROJECT_FILE_COUNT = 5_000;

export function envDelay(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Chokidar absolute path → index-form relative path; null when outside the root (or cross-drive). */
export function toRelPath(root: string, absPath: string): string | null {
  const rel = relative(root, absPath);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel.replace(/\\/g, '/');
}
