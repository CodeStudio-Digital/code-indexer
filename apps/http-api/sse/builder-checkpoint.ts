/**
 * Auto-checkpoint for Builder projects — fire-and-forget at every run end
 * (both the in-process stream path and the worker pool's `bus.end` mirror
 * call into here). When the session's project is a Builder project and
 * the tree is dirty, the run becomes a real git commit + a
 * `builder_checkpoints` row, and (Electron only) an offscreen thumbnail
 * of the dev server is attached best-effort.
 *
 * Never throws and never blocks the caller: every failure is swallowed
 * after a console.warn — checkpoints are augmentation, not a gate.
 */
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { mcpDataDir } from '@mcp/shared/utils/config.js';
import { trackProcessTree } from '@mcp/shared/utils/process-tree.js';
import {
  createBuilderCheckpoint,
  setBuilderCheckpointScreenshot,
} from '@mcp/store/db/builder-checkpoints.js';
import { getGlobalPreviewDevtools } from '@mcp/code-agent/tools/preview/index.js';
import type { ServerDeps } from '../server/deps.js';

const GIT_TIMEOUT_MS = 15_000;

function git(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      'git',
      args,
      {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      },
      (err, stdout) => {
        untrack();
        resolve({ ok: !err, stdout: String(stdout ?? '') });
      },
    );
    const untrack = trackProcessTree(child.pid);
  });
}

/** First non-empty line of the latest user prompt — the checkpoint label. */
function labelFor(deps: Pick<ServerDeps, 'db'>, sessionId: number): string {
  try {
    const row = deps.db
      .raw()
      .prepare(
        `SELECT content FROM coder_messages
         WHERE session_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1`,
      )
      .get(sessionId) as { content?: string } | undefined;
    const first = (row?.content ?? '').split('\n').find((l) => l.trim());
    return (first ?? '').trim().slice(0, 120) || `Run ${new Date().toISOString().slice(0, 16)}`;
  } catch {
    return `Run ${new Date().toISOString().slice(0, 16)}`;
  }
}

export interface BuilderCheckpointDeps {
  db: ServerDeps['db'];
}

// Module-global wiring (same pattern as setGlobalPreviewDevtools): the
// server boot installs deps once; the two run-end chokepoints (worker
// pool `bus.end` mirror + in-process stream finally) just notify.
let globalDeps: BuilderCheckpointDeps | null = null;

export function setBuilderCheckpointDeps(deps: BuilderCheckpointDeps | null): void {
  globalDeps = deps;
}

/** Run-end notification — no-op until deps are wired (tests, early boot). */
export function notifyBuilderRunEnded(sessionId: number): void {
  if (globalDeps) maybeBuilderCheckpoint(globalDeps, sessionId);
}

/** Run-end hook. Synchronous wrapper — the async work is detached. */
export function maybeBuilderCheckpoint(deps: BuilderCheckpointDeps, sessionId: number): void {
  void runCheckpoint(deps, sessionId).catch((e) => {
    console.warn(`[builder-checkpoint] session ${sessionId}:`, e instanceof Error ? e.message : e);
  });
}

async function runCheckpoint(deps: BuilderCheckpointDeps, sessionId: number): Promise<void> {
  const session = deps.db
    .raw()
    .prepare('SELECT project_id FROM coder_sessions WHERE id = ?')
    .get(sessionId) as { project_id?: number } | undefined;
  if (!session?.project_id) return;

  const project = deps.db.getProject(session.project_id);
  if (!project?.builder_json || !project.root_path) return;

  const status = await git(project.root_path, ['status', '--porcelain']);
  if (!status.ok || !status.stdout.trim()) return; // not a repo / clean tree

  const label = labelFor(deps, sessionId);
  const add = await git(project.root_path, ['add', '-A']);
  if (!add.ok) return;
  const commit = await git(project.root_path, ['commit', '-m', `checkpoint: ${label}`]);
  if (!commit.ok) return;
  const head = await git(project.root_path, ['rev-parse', 'HEAD']);
  if (!head.ok) return;

  // builder_checkpoints is FEATURE-class — write to the project DB when routed
  // (mirrors the list/restore/diff handlers), else central. The reads above
  // (coder_sessions/coder_messages) correctly stay central via raw().
  const row = createBuilderCheckpoint(deps.db.projectScopedDb(project.id), {
    project_id: project.id,
    session_id: sessionId,
    commit_sha: head.stdout.trim(),
    label,
    kind: 'auto',
  });

  await attachThumbnail(deps, row.id, project.id, project.builder_json);
}

/** Electron-only, best-effort: dev-server screenshot for the timeline card. */
export async function attachThumbnail(
  deps: BuilderCheckpointDeps,
  checkpointId: number,
  projectId: number,
  builderJson: string,
): Promise<void> {
  const backend = getGlobalPreviewDevtools();
  if (!backend) return; // headless / browser dashboard → placeholder card
  let port: number | null = null;
  try {
    const cfg = JSON.parse(builderJson) as { port?: number };
    port = typeof cfg.port === 'number' ? cfg.port : null;
  } catch {
    return;
  }
  if (!port) return;
  const outPath = join(mcpDataDir(), 'builder-thumbs', `p${projectId}-c${checkpointId}.jpg`);
  try {
    const res = (await backend.invoke({
      key: `thumb:${projectId}`,
      method: 'thumbnail',
      args: { url: `http://127.0.0.1:${port}/`, outPath },
    })) as { ok?: boolean; path?: string };
    if (res?.ok && res.path) {
      // Same routed DB as the checkpoint row above — else the screenshot path
      // lands in central while the row + thumbnail route read the project DB.
      setBuilderCheckpointScreenshot(deps.db.projectScopedDb(projectId), checkpointId, res.path);
    }
  } catch {
    /* dev server down / capture failed — keep null */
  }
}
