import type { ApiContext, AsyncStream } from './common.js';
import type { EditorSettingsOverride } from './editor.js';

/**
 * Projects = root unit of work. Each project is bound to a `root_path` on
 * the user's filesystem and owns sessions, files, snapshots, runs.
 *
 * Routes mapped: apps/http-api/server/routes/projects.ts +
 *                apps/http-api/server/routes/stats.ts (per-project stats).
 */

export interface Project {
  id: number;
  name: string;
  root_path: string;
  created_at: string;
  index_ignore_patterns?: string | null;
  /** Owner — added by the Freemium gating layer (migration 104). */
  user_id?: string;
  /** Per-project agent-memory toggle (migration 115; default 1 = on). */
  memory_enabled?: number;
  /**
   * Frontend framework inferred from package.json at read time (not persisted).
   * Drives the preview element-selector mode. Set by the `get` handler.
   */
  framework?: 'next' | 'react' | 'vue' | 'angular' | null;
  editor_settings?: EditorSettingsOverride | null;
}

export interface ProjectStats {
  file_count: number;
  symbol_count: number;
  languages: Record<string, number>;
  total_lines: number;
  total_size: number;
  last_indexed: string | null;
  /** Last structural-only (tree-sitter) pass — migration 139. */
  structural_indexed_at: string | null;
  /** Files whose LLM/embedding layer lags current content. */
  semantic_stale_count: number;
  run_count: number;
}

// ─── Structural auto-index status (IntelliJ-style dumb→smart) ──────

export type ProjectIndexPhase =
  | 'none'
  | 'scanning'
  | 'structural_indexing'
  | 'structural_ready'
  | 'semantic_indexing'
  | 'semantic_ready'
  | 'too_large'
  | 'error';

/** The single in-flight index pass (mirrors services/project-index types). */
export interface ActiveIndexRun {
  kind: 'structural' | 'semantic' | 'embeddings';
  current: number;
  total: number;
  currentFile?: string;
  startedAt: number;
  costUsd?: number;
}

export interface ScheduledIndexRun {
  reason: 'activation' | 'open' | 'scaffold' | 'session' | 'manual' | 'branch' | 'workspace' | 'poll';
  dueAt: number;
}

export interface ProjectIndexStatus {
  projectId: number;
  phase: ProjectIndexPhase;
  watcherActive: boolean;
  watcherMode?: 'live' | 'polling' | 'off';
  dirtyPending: number;
  fileCount: number;
  symbolCount: number;
  semanticStaleCount: number;
  /** The live pass — undefined when idle. Survives renderer remounts. */
  activeRun?: ActiveIndexRun;
  /** Deferred structural reconciliation; it is not consuming CPU yet. */
  scheduledRun?: ScheduledIndexRun;
  /** @deprecated Use {@link activeRun}. Kept in sync for the StatusBar chip. */
  progress?: { current: number; total: number };
  lastStructuralAt: string | null;
  lastCheckedAt: string | null;
  lastSemanticAt: string | null;
  error?: string;
}

/** Live filesystem change (project-relative path) — feeds the file tree + tab reload. */
export interface FsEventWire {
  path: string;
  kind: 'upsert' | 'delete';
  isDir: boolean;
}

export interface FsEventsFrame {
  events: FsEventWire[];
}

/** Live git-metadata change — branch switch / ref update / sequencer state. */
export interface GitMetaFrame {
  /** Current branch name, or null when HEAD is detached / unreadable. */
  branch: string | null;
  detached: boolean;
  /** Distinct kinds of `.git` change observed in this coalesced batch. */
  changed: Array<'head' | 'ref' | 'sequencer'>;
}

export interface CreateProjectInput {
  name: string;
  root_path: string;
  description?: string;
  /** Register as a LOOSE ad-hoc global-session folder (mig 176): hidden from
   *  the "Projetos" grid, idempotent on an existing path. See CreateProjectService. */
  loose?: boolean;
}

export interface UpdateProjectInput {
  name?: string;
  root_path?: string;
  node_version?: string | null;
  runner_shell?: string | null;
  index_ignore_patterns?: string | null;
  /** Per-project agent-memory toggle (Mem C write-back + retrieval). */
  memory_enabled?: boolean;
  /** Persisted in the routed project DB, not in repository files. */
  editor_settings?: EditorSettingsOverride | null;
}

/**
 * Stacks the New Project wizard can scaffold on the host (under
 * `~/.mcp-code-indexer/projects/<slug>`). Kept as a string union mirroring the
 * host-scaffold registry; api-handlers validates the concrete value.
 */
export type ScaffoldTemplateId =
  | 'react-vite'
  | 'vue'
  | 'angular'
  | 'vite-api'
  | 'cf-worker'
  | 'nextjs'
  | 'opennext-cf'
  | 'vite-react-cf'
  | 'git-clone'
  | 'empty';

export interface ScaffoldProjectInput {
  template: ScaffoldTemplateId;
  /** Display name; slugified into the folder name. */
  name: string;
  description?: string;
  /** Required when template === 'git-clone'. */
  repoUrl?: string;
  /** `git init` an `empty` project. */
  gitInit?: boolean;
  /** Builder mode — scaffold a V0-style builder project (react-vite only):
   *  Tailwind + shadcn + element-selection instrumentation + builder flag. */
  builder?: boolean;
}

/**
 * Progress frames for a host scaffold. `done` carries the freshly
 * registered Project (so the UI can navigate straight to it); `error`
 * carries a message + optional stderr tail. Mirrors the SSE route in
 * apps/http-api/server/routes/projects-scaffold.ts.
 */
export type ScaffoldStreamEvent =
  | { event: 'start'; data: { template: string; slug: string; targetPath: string } }
  | { event: 'phase'; data: { phase: string; label: string } }
  | { event: 'log'; data: { stream: 'stdout' | 'stderr'; chunk: string } }
  | { event: 'done'; data: { project: Project } }
  | { event: 'error'; data: { message: string; stderrTail?: string } };

export interface ProjectsApi {
  list(input: void, ctx: ApiContext): Promise<Project[]>;
  /** Projects for the GLOBAL-session picker: real projects + loose ad-hoc
   *  folders (mig 176), minus the synthetic unions. Superset of `list`. */
  listForGlobalPicker(input: void, ctx: ApiContext): Promise<Project[]>;
  get(input: { id: number }, ctx: ApiContext): Promise<Project>;
  /** Project-view lifecycle. Unlike `get`, activation may schedule background work. */
  activate(
    input: { id: number; activationId: string; clientId: string },
    ctx: ApiContext,
  ): Promise<{ ok: true; scheduled: boolean; delayMs: number | null; largeProject: boolean }>;
  deactivate(
    input: { id: number; activationId: string; clientId: string },
    ctx: ApiContext,
  ): Promise<{ ok: true }>;
  create(input: CreateProjectInput, ctx: ApiContext): Promise<Project>;
  update(input: { id: number } & UpdateProjectInput, ctx: ApiContext): Promise<Project>;
  delete(
    input: { id: number },
    ctx: ApiContext,
  ): Promise<{ ok: true; vectors_known: number; vectors_deleted: number; vector_error: string | null }>;

  /**
   * Wipe ONE project's data (index, sessions, snapshots, runs, costs) and its
   * local vectors, KEEPING the project row so the user only re-indexes.
   */
  clearData(
    input: { id: number },
    ctx: ApiContext,
  ): Promise<{ ok: true; vectors_known: number; vectors_deleted: number; vector_error: string | null }>;

  /**
   * Wipe ALL projects' data (index, sessions, snapshots, runs, costs) and their
   * local vectors, KEEPING each project row so the user only re-indexes — not
   * re-creates. Per-project errors are collected, not fatal.
   */
  clearAllData(
    input: void,
    ctx: ApiContext,
  ): Promise<{
    ok: true;
    projects_cleared: number;
    vectors_deleted: number;
    errors: Array<{ project: string; error: string }>;
  }>;

  stats(input: { id: number }, ctx: ApiContext): Promise<ProjectStats>;

  /** Live structural-index status (phase, watcher, dirty queue, staleness). */
  indexStatus(input: { id: number }, ctx: ApiContext): Promise<ProjectIndexStatus>;

  /**
   * Streaming status — initial frame + one frame per transition (coalesced
   * ~150ms). The `Stream` suffix is load-bearing: handlers-mount auto-routes
   * it to a MessagePort on Electron; the Hono route adapts it to SSE.
   */
  indexStatusStream(input: { id: number }, ctx: ApiContext): AsyncStream<ProjectIndexStatus>;

  /**
   * Live filesystem events (watcher + editor mutations), coalesced ~200ms.
   * Subscribing arms the project watcher. Feeds the live file tree and
   * open-tab external-change handling.
   */
  fsEventsStream(input: { id: number }, ctx: ApiContext): AsyncStream<FsEventsFrame>;

  /**
   * Live git-metadata events (HEAD/refs watcher), coalesced ~250ms. Subscribing
   * arms the watcher. Fires on branch switch — in-app OR external `git checkout`
   * — so the branch chip / git window / file-tree colors refresh on screen.
   */
  gitMetaStream(input: { id: number }, ctx: ApiContext): AsyncStream<GitMetaFrame>;

  /**
   * Scaffold a brand-new project on the host (`~/.mcp-code-indexer/projects/<slug>`)
   * from a stack template / git clone / empty, then register it. Streams
   * progress; the terminal `done` event carries the registered Project.
   */
  scaffold(input: ScaffoldProjectInput, ctx: ApiContext): AsyncStream<ScaffoldStreamEvent>;
}
