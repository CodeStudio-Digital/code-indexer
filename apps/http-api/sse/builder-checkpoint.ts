/**
 * Auto-checkpoint for Builder projects. The git commit still belongs to the
 * project, while every session-owned checkpoint record and thumbnail lives in
 * that session's filesystem bundle.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { trackProcessTree } from '@mcp/shared/utils/process-tree.js';
import {
  type SessionId,
} from '@mcp/session-storage';
import { getGlobalPreviewDevtools } from '@mcp/code-agent/tools/preview/index.js';
import {
  createBuilderCheckpointFile,
  setBuilderCheckpointScreenshot,
  type LocatedBuilderCheckpoint,
} from '../builder-checkpoint-files.js';
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

function fallbackLabel(): string {
  return `Run ${new Date().toISOString().slice(0, 16)}`;
}

/** First non-empty line of the latest user prompt — the checkpoint label. */
async function labelFor(
  deps: BuilderCheckpointDeps,
  sessionId: SessionId,
): Promise<string> {
  try {
    const content =
      await deps.sessionStore.getLatestNonMetaUserMessageText(sessionId);
    const first = (content ?? '').split('\n').find((line) => line.trim());
    return (first ?? '').trim().slice(0, 120) || fallbackLabel();
  } catch {
    return fallbackLabel();
  }
}

export interface BuilderCheckpointDeps {
  db: ServerDeps['db'];
  sessionStore: ServerDeps['sessionStore'];
}

// Module-global wiring (same pattern as setGlobalPreviewDevtools): the server
// installs the filesystem repository once; run-end chokepoints only notify.
let globalDeps: BuilderCheckpointDeps | null = null;

export function setBuilderCheckpointDeps(
  deps: BuilderCheckpointDeps | null,
): void {
  globalDeps = deps;
}

/** Run-end notification — no-op until deps are wired (tests, early boot). */
export function notifyBuilderRunEnded(sessionId: SessionId): void {
  if (globalDeps) maybeBuilderCheckpoint(globalDeps, sessionId);
}

/** Run-end hook. Synchronous wrapper — the async work is detached. */
export function maybeBuilderCheckpoint(
  deps: BuilderCheckpointDeps,
  sessionId: SessionId,
): void {
  void runCheckpoint(deps, sessionId).catch((error) => {
    console.warn(
      `[builder-checkpoint] session ${sessionId}:`,
      error instanceof Error ? error.message : error,
    );
  });
}

async function runCheckpoint(
  deps: BuilderCheckpointDeps,
  sessionId: SessionId,
): Promise<void> {
  const session = await deps.sessionStore.getSession(sessionId);
  if (!session?.project_id) return;
  const entry = deps.sessionStore.catalog.get(sessionId);
  if (!entry) {
    throw new Error(`filesystem bundle not found for session ${sessionId}`);
  }

  const project = deps.db.getProject(session.project_id);
  if (!project?.builder_json || !project.root_path) return;

  const status = await git(project.root_path, ['status', '--porcelain']);
  if (!status.ok || !status.stdout.trim()) return;

  const label = await labelFor(deps, sessionId);
  const add = await git(project.root_path, ['add', '-A']);
  if (!add.ok) return;
  const commit = await git(project.root_path, ['commit', '-m', `checkpoint: ${label}`]);
  if (!commit.ok) return;
  const head = await git(project.root_path, ['rev-parse', 'HEAD']);
  if (!head.ok) return;

  const checkpoint = await createBuilderCheckpointFile(
    deps.sessionStore,
    entry,
    {
      project_id: project.id,
      commit_sha: head.stdout.trim(),
      label,
      kind: 'auto',
    },
  );

  await attachThumbnail(
    deps,
    checkpoint,
    project.id,
    project.builder_json,
  );
}

/** Electron-only, best-effort: dev-server screenshot for the timeline card. */
export async function attachThumbnail(
  deps: BuilderCheckpointDeps,
  located: LocatedBuilderCheckpoint,
  projectId: number,
  builderJson: string,
): Promise<void> {
  const backend = getGlobalPreviewDevtools();
  if (!backend) return;
  let port: number | null = null;
  try {
    const cfg = JSON.parse(builderJson) as { port?: number };
    port = typeof cfg.port === 'number' ? cfg.port : null;
  } catch {
    return;
  }
  if (!port) return;

  const capturePath = join(
    located.entry.location.bundle_path,
    'checkpoints',
    `.thumbnail-${located.record.id}-${randomUUID()}.jpg`,
  );
  try {
    const result = (await backend.invoke({
      key: `thumb:${projectId}`,
      method: 'thumbnail',
      args: { url: `http://127.0.0.1:${port}/`, outPath: capturePath },
    })) as { ok?: boolean; path?: string };
    if (!result?.ok || result.path !== capturePath) return;
    const info = await lstat(capturePath);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error('preview thumbnail did not produce a safe regular file');
    }
    const artifacts = await deps.sessionStore.repository.artifactStore(
      located.entry.location,
    );
    const artifact = await artifacts.put({
      kind: 'snapshot_blob',
      data: await readFile(capturePath),
      media_type: 'image/jpeg',
      logical_name: `builder-checkpoint-${located.record.id}.jpg`,
    });
    await setBuilderCheckpointScreenshot(
      deps.sessionStore,
      located.entry,
      located.record.id,
      artifact,
    );
  } catch {
    // Dev server down / capture failed — checkpoint remains valid without it.
  } finally {
    await rm(capturePath, { force: true }).catch(() => undefined);
  }
}
