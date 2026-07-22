import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { relToAbsCanonical } from '@mcp/shared/utils/fs-canonical.js';
import { LspServerHandle } from './lsp-server-handle.js';
import { inLspFailureWindow, LSP_BACKOFF_MS } from './lsp-instance-policy.js';
import type {
  LspInstanceState,
  LspManagerDeps,
  LspManagerEntry,
  LspReplayDocument,
} from './lsp-server-manager-types.js';
import {
  installDirFor,
  spawnSpecFor,
  type LspRuntimeResolution,
  type LspServerDef,
  type LspSpawnCommand,
} from './server-registry.js';

export interface LspSpawnLifecycle {
  emit: (entry: LspManagerEntry, state: LspInstanceState, reason?: string) => void;
  touch: (entry: LspManagerEntry) => void;
  replayDocs: (entry: LspManagerEntry) => {
    projectRoot: string;
    docs: LspReplayDocument[];
  } | null;
  resolveServerNode: (
    projectId: number,
    def: LspServerDef,
  ) => { command: string; env?: Record<string, string> };
  acceptDiagnostics: (entry: LspManagerEntry) => boolean;
}

export async function spawnLspEntry(
  deps: LspManagerDeps,
  lifecycle: LspSpawnLifecycle,
  entry: LspManagerEntry,
  baseDir: string,
  projectRoot: string,
  workspaceRoot: string,
  languageId: string,
  runtime?: LspRuntimeResolution,
): Promise<LspServerHandle | null> {
  const { def, projectId } = entry;
  lifecycle.emit(entry, 'starting');
  const recent = entry.crashTimes.length;
  if (recent > 0) {
    await new Promise((resolve) => setTimeout(
      resolve,
      LSP_BACKOFF_MS[Math.min(recent, LSP_BACKOFF_MS.length) - 1],
    ));
  }

  const installDir = installDirFor(baseDir, def);
  let spawnSpec: LspSpawnCommand;
  try {
    spawnSpec = spawnSpecFor(
      def,
      installDir,
      () => lifecycle.resolveServerNode(projectId, def),
      languageId,
      {
        baseDir,
        projectId,
        projectRoot: workspaceRoot,
        runtime,
        registeredProjectRoots: deps.listProjectRoots?.(),
      },
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    entry.spawning = null;
    entry.blockedReason = reason;
    lifecycle.emit(entry, 'failed', reason);
    return null;
  }
  if (!existsSync(spawnSpec.checkPath)) {
    deps.log?.(`[lsp] entry missing for ${def.id}: ${spawnSpec.checkPath}`);
    entry.spawning = null;
    lifecycle.emit(entry, 'failed', `server entry missing: ${spawnSpec.checkPath}`);
    return null;
  }
  entry.workspaceMode = spawnSpec.workspaceMode;
  entry.workspaceReason = spawnSpec.workspaceReason;

  let handle: LspServerHandle | null = null;
  try {
    const languageLevel = deps.resolveLanguageLevel?.(projectId, def.id);
    handle = new LspServerHandle(
      {
        command: spawnSpec.command,
        args: spawnSpec.args,
        cwd: spawnSpec.cwd ?? workspaceRoot,
        rootPath: spawnSpec.rootPath ?? workspaceRoot,
        env: spawnSpec.env,
        priority: spawnSpec.priority,
        initializationOptions: def.initializationOptions?.({
          cacheDir: join(baseDir, '.cache'),
          languageLevel,
        }),
        workspaceFolders: def.workspaceFolders,
        initializeTimeoutMs: def.id === 'omnisharp' ? 120_000 : undefined,
        resolveConfig: (section) => deps.resolveLspConfig?.(projectId, def.id, section) ?? null,
      },
      {
        onDiagnostics: (absPath, diagnostics) => {
          if (!lifecycle.acceptDiagnostics(entry)) return;
          deps.onDiagnostics(projectId, absPath, def.id, diagnostics, entry.route?.routeId);
        },
        onExit: () => {
          entry.crashTimes.push(Date.now());
          entry.handle = null;
          entry.spawning = null;
          const tail = handle?.stderrTail.trim().slice(-400);
          deps.log?.(
            `[lsp] ${def.id} (project ${projectId}) exited unexpectedly (${entry.crashTimes.length} recent)`
              + (tail ? ` — stderr: ${tail}` : ''),
          );
          const reason = tail || 'server exited unexpectedly';
          lifecycle.emit(entry, inLspFailureWindow(entry) ? 'failed' : 'idle', reason);
        },
        log: (msg) => deps.log?.(`[lsp:${def.id}] ${msg}`),
      },
    );
    await handle.whenReady();
    entry.handle = handle;
    entry.spawning = null;
    lifecycle.touch(entry);
    const replay = lifecycle.replayDocs(entry);
    for (const doc of replay?.docs ?? []) {
      handle.didOpen(relToAbsCanonical(projectRoot, doc.file), doc.languageId, doc.version, doc.content);
    }
    deps.log?.(`[lsp] ${def.id} ready for project ${projectId}`);
    lifecycle.emit(entry, 'ready');
    return handle;
  } catch (error) {
    entry.crashTimes.push(Date.now());
    entry.spawning = null;
    const tail = handle?.stderrTail.trim().slice(-400);
    const message = error instanceof Error ? error.message : String(error);
    deps.log?.(`[lsp] ${def.id} failed to start: ${message}${tail ? ` — stderr: ${tail}` : ''}`);
    const reason = /timed out/i.test(message) ? 'initialization timed out (30s)' : (tail || message);
    lifecycle.emit(entry, inLspFailureWindow(entry) ? 'failed' : 'idle', reason);
    return null;
  }
}
