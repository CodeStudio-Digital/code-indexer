import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, realpath, stat, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { atomicWriteJson } from '@mcp/session-storage/atomic-file.js';
import { mcpRuntimeCoordinationDir } from '@mcp/shared/utils/config.js';
import { resolveToolMetadata } from '../core/policy.js';
import type { CoderTool, ToolResult } from '../core/tool.js';
import { HostEffectScope } from './host-effect-scope.js';
import { workspaceRuntimeConflict } from './workspace-runtime-error.js';

type Generation = 'legacy_ts' | 'rust_v1';
interface Claim { id: string; sessionId: string; generation: Generation; roots: string[]; reconciliation?: string }
interface State { version: 1; claims: Claim[] }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const normalized = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path;
function contains(root: string, path: string) {
  const rel = relative(root, path);
  return !rel || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`));
}

/** Cross-generation admission barrier shared by Coder, CLI and Company. Same
 * generation concurrency remains governed by its existing workspace policy.
 * Claims have no expiry: a crashed or uncertain writer needs reconciliation. */
export class WorkspaceRuntimeCohortStore {
  constructor(private readonly directory: string) {}

  async acquire(sessionId: string, generation: Generation, roots: readonly string[]): Promise<Claim> {
    const canonical = [...new Set(await Promise.all(roots.map(async root => normalized(await realpath(root)))))].sort();
    if (!sessionId || !['legacy_ts', 'rust_v1'].includes(generation)
      || !canonical.length || canonical.length > 256) throw new Error('Invalid runtime workspace scope');
    const claim: Claim = { id: randomUUID(), sessionId, generation, roots: canonical };
    return this.mutate(state => {
      if (state.claims.some(current => current.generation !== generation
        && current.roots.some(root => canonical.some(path => contains(root, path) || contains(path, root))))) {
        throw workspaceRuntimeConflict('Workspace belongs to another runtime generation; wait for its owned work to finish or reconcile its retained effects');
      }
      if (state.claims.length >= 4096) throw new Error('Runtime workspace claims require reconciliation before further admission');
      state.claims.push(claim);
      return claim;
    });
  }

  async retain(claim: Claim, reason: string): Promise<void> {
    await this.mutate(state => { this.current(state, claim).reconciliation ??= reason.slice(0, 256); });
  }

  async extend(claim: Claim, root: string): Promise<Claim> {
    const canonical = normalized(await realpath(root));
    return this.mutate(state => {
      const current = this.current(state, claim);
      if (current.roots.some(root => contains(root, canonical))) return current;
      if (current.roots.length >= 256 || state.claims.some(other => other.generation !== claim.generation
        && other.roots.some(root => contains(root, canonical) || contains(canonical, root)))) {
        throw workspaceRuntimeConflict('Additional workspace root conflicts with runtime ownership');
      }
      current.roots = [...current.roots, canonical].sort();
      return current;
    });
  }

  async release(claim: Claim, proveQuiescent: () => Promise<void>): Promise<void> {
    await proveQuiescent();
    await this.mutate(state => {
      if (this.current(state, claim).reconciliation) return;
      state.claims = state.claims.filter(current => current.id !== claim.id);
    });
  }

  private current(state: State, claim: Claim): Claim {
    const current = state.claims.find(item => item.id === claim.id);
    if (!current || current.sessionId !== claim.sessionId || current.generation !== claim.generation
      || JSON.stringify(current.roots) !== JSON.stringify(claim.roots)) throw new Error('Runtime workspace ownership changed');
    return current;
  }

  private async mutate<T>(operation: (state: State) => T): Promise<T> {
    await mkdir(this.directory, { recursive: true });
    const lockPath = join(this.directory, 'transaction.lock');
    let lock: Awaited<ReturnType<typeof open>> | undefined;
    for (let retry = 0; retry < 100; retry++) {
      try { lock = await open(lockPath, 'wx', 0o600); break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; await delay(10); }
    }
    if (!lock) throw new Error('Runtime workspace transaction is busy or requires crash reconciliation');
    try {
      let state: State;
      let file: Awaited<ReturnType<typeof open>> | undefined;
      try { file = await open(join(this.directory, 'claims.json'), 'r'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        // A deleted ledger must not silently erase outstanding effect owners.
        const marker = await open(join(this.directory, 'initialized'), 'wx', 0o600);
        try { await marker.writeFile('runtime-workspace-cohorts-v1\n'); await marker.sync(); } finally { await marker.close(); }
      }
      if (file) {
        try {
          const size = (await file.stat()).size;
          if (size > 8 * 1024 * 1024) throw new Error('Runtime workspace authority exceeds its bound');
          const bytes = Buffer.alloc(size + 1);
          let offset = 0;
          while (offset < bytes.length) { const read = await file.read(bytes, offset, bytes.length - offset, offset); if (!read.bytesRead) break; offset += read.bytesRead; }
          if (offset !== size) throw new Error('Runtime workspace authority changed during read');
          const record = JSON.parse(bytes.subarray(0, size).toString('utf8')) as { state: State; sha256: string };
          state = record.state;
          if (state?.version !== 1 || !Array.isArray(state.claims) || state.claims.length > 4096 || hash(state) !== record.sha256
            || state.claims.some(claim => !claim.id || !claim.sessionId || !['legacy_ts', 'rust_v1'].includes(claim.generation)
              || !Array.isArray(claim.roots) || !claim.roots.length || claim.roots.length > 256 || claim.roots.some(root => !isAbsolute(root)))
            || new Set(state.claims.map(claim => claim.id)).size !== state.claims.length) throw new Error('Corrupt runtime workspace authority');
        } finally { await file.close(); }
      } else state = { version: 1, claims: [] };
      const result = operation(state);
      if (Buffer.byteLength(JSON.stringify(state)) > 8 * 1024 * 1024 - 1024) throw new Error('Runtime workspace authority capacity exceeded');
      await atomicWriteJson(join(this.directory, 'claims.json'), { state, sha256: hash(state) });
      return structuredClone(result);
    } finally { await lock.close(); await unlink(lockPath); }
  }
}

export class WorkspaceRuntimeScope {
  private readonly owners: Array<{ store: WorkspaceRuntimeCohortStore; claim: Claim }> = [];
  private readonly effects = new HostEffectScope();
  private retained = false;
  private closed = false;
  private extending: Promise<void> = Promise.resolve();
  constructor(private readonly generation: Generation) {}

  async enter(dbPath: string, sessionId: string, roots: readonly string[]) {
    if (this.owners.length || this.closed) throw new Error('Runtime workspace scope already admitted or closed');
    const directory = join(dirname(resolve(dbPath)), 'runtime-workspace-cohorts');
    const sharedDirectory = join(mcpRuntimeCoordinationDir(), 'workspace-cohorts');
    // Keep the profile ledger during migration: an older worker may still own
    // it. The shared ledger also fences different profiles and later legacy
    // processes, even when their development flag is disabled.
    if (process.env.CODESTUDIO_NATIVE_CODER_DEV !== '1' && process.env.CODESTUDIO_RUNTIME_COHORT_GUARD !== '1') {
      const present = await Promise.all([directory, sharedDirectory].map(async path => {
        try { await stat(path); return true; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return false; }
      }));
      if (!present.some(Boolean)) {
        if (this.generation === 'rust_v1') throw new Error('Rust workspace cohort must be enabled before execution');
        return;
      }
    }
    try {
      for (const path of [...new Set([sharedDirectory, directory])]) {
        const store = new WorkspaceRuntimeCohortStore(path);
        this.owners.push({ store, claim: await store.acquire(sessionId, this.generation, roots) });
      }
    } catch (cause) {
      // Admission has not returned: no caller could have dispatched an effect.
      // Release only reservations actually acquired by this scope.
      for (const owner of [...this.owners].reverse()) await owner.store.release(owner.claim, async () => {});
      this.owners.length = 0;
      throw cause;
    }
  }

  extend(root: string): Promise<void> {
    const update = this.extending.then(async () => {
      if (this.closed) throw new Error('Runtime workspace scope is closed');
      for (const owner of this.owners) owner.claim = await owner.store.extend(owner.claim, root);
    });
    this.extending = update.catch(() => undefined);
    return update;
  }

  async invoke(tool: CoderTool, operation: () => Promise<ToolResult>): Promise<ToolResult> {
    if (this.closed) throw new Error('Runtime workspace scope is closed');
    if (!this.owners.length) return operation();
    return this.effects.track(async () => {
      const metadata = resolveToolMetadata(tool);
      // A legacy shell/plugin may intentionally outlive its returned result.
      // Completion of the JS promise is not physical descendant-reap evidence.
      if (this.generation === 'legacy_ts' && !(tool.source === 'native'
        && (tool.effectBoundary === 'filesystem' || tool.effectBoundary === 'database'
          || (tool.effectBoundary !== 'shell' && metadata.executionClass === 'read' && metadata.parallelSafe && !metadata.mutates)))) {
        await this.retain(`Uncontained legacy capability: ${tool.name}`);
      }
      const result = await operation();
      if (result.effectOutcome === 'unknown') await this.retain(`Uncertain capability result: ${tool.name}`);
      return result;
    });
  }

  private async retain(reason: string) {
    if (!this.retained && this.owners.length) {
      // Even a failed diagnostic update cannot turn an uncertain effect into
      // release permission. The original durable admission remains in place.
      this.retained = true;
      const retained = await Promise.allSettled(this.owners.map(owner => owner.store.retain(owner.claim, reason)));
      const failures = retained.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Workspace retention was not fully recorded');
    }
  }

  async close(completed: boolean): Promise<void> {
    await this.extending;
    if (!this.owners.length) return;
    if (!completed) { await this.retain('Execution or preparation cleanup was not confirmed'); return; }
    // An explicitly background legacy child can still use this inherited
    // context. Keep both its admission and invocation owner until reconciled.
    if (this.retained) return;
    this.closed = true;
    this.effects.seal();
    await this.effects.waitForIdle(AbortSignal.timeout(10_000));
    // Drop the shared admission last, after every compatibility ledger.
    for (const owner of [...this.owners].reverse()) await owner.store.release(owner.claim, async () => {});
    this.owners.length = 0;
  }
}
