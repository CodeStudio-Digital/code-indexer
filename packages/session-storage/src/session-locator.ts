import { lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  asSessionId,
  type ProjectId,
  type ProjectRootRecord,
  type ProjectRootResolver,
  type SessionId,
  type SessionLocation,
  type SessionStorageScope,
} from './types.js';
import {
  assertContainedPath,
  assertExistingDirectory,
  assertPathHasNoLinks,
  ensureDirectoryTreeNoLinks,
  UnsafeSessionPathError,
} from './path-safety.js';

export interface SessionLocatorOptions {
  readonly dataDir: string;
  readonly projectRootResolver: ProjectRootResolver;
}

export class SessionRootUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionRootUnavailableError';
  }
}

export class SessionLocator {
  readonly #dataDir: string;
  readonly #projectRoots: ProjectRootResolver;

  constructor(options: SessionLocatorOptions) {
    if (options.dataDir.trim().length === 0) {
      throw new SessionRootUnavailableError(
        'MCP data directory cannot be empty',
      );
    }
    this.#dataDir = resolve(options.dataDir);
    this.#projectRoots = options.projectRootResolver;
  }

  get dataDir(): string {
    return this.#dataDir;
  }

  listProjectRoots(): readonly ProjectRootRecord[] {
    return this.#projectRoots
      .listProjectRoots()
      .filter((entry) => entry.root_path.trim().length > 0)
      .map((entry) => ({
        project_id: entry.project_id,
        root_path: resolve(entry.root_path),
      }));
  }

  resolveProjectRoot(projectId: ProjectId): string {
    const root = this.#projectRoots.resolveProjectRoot(projectId);
    if (!root || root.trim().length === 0) {
      throw new SessionRootUnavailableError(`No project root is registered for project ${String(projectId)}`);
    }
    return resolve(root);
  }

  sessionRoot(scope: SessionStorageScope): string {
    if (scope.kind === 'global') {
      return join(this.#dataDir, 'sessions', 'global');
    }
    return join(this.resolveProjectRoot(scope.project_id), '.mcp-indexer', 'session');
  }

  locate(scope: SessionStorageScope, id: SessionId | string): SessionLocation {
    const sessionId = asSessionId(String(id));
    const sessionRoot = this.sessionRoot(scope);
    const bundlePath = join(sessionRoot, sessionId);
    assertContainedPath(sessionRoot, bundlePath);
    return {
      session_id: sessionId,
      scope,
      session_root: sessionRoot,
      bundle_path: bundlePath,
    };
  }

  allKnownSessionRoots(): ReadonlyArray<{ scope: SessionStorageScope; session_root: string }> {
    const seen = new Set<string>();
    const roots: Array<{ scope: SessionStorageScope; session_root: string }> = [];
    const add = (scope: SessionStorageScope, sessionRoot: string): void => {
      const key = process.platform === 'win32' ? resolve(sessionRoot).toLowerCase() : resolve(sessionRoot);
      if (seen.has(key)) return;
      seen.add(key);
      roots.push({ scope, session_root: resolve(sessionRoot) });
    };

    add({ kind: 'global' }, this.sessionRoot({ kind: 'global' }));
    for (const project of this.listProjectRoots()) {
      add(
        { kind: 'project', project_id: project.project_id },
        join(project.root_path, '.mcp-indexer', 'session'),
      );
    }
    return roots;
  }

  /**
   * Fail-closed preparation. The owning project/data root must already exist
   * and be writable; only the `.mcp-indexer/session` descendants are created.
   */
  async ensureSessionRoot(scope: SessionStorageScope): Promise<string> {
    const ownerRoot = scope.kind === 'global' ? this.#dataDir : this.resolveProjectRoot(scope.project_id);
    let canonicalOwner: string;
    try {
      canonicalOwner = await assertExistingDirectory(
        ownerRoot,
        scope.kind === 'global' ? 'MCP data directory' : `project root ${String(scope.project_id)}`,
      );
    } catch (error) {
      throw new SessionRootUnavailableError((error as Error).message);
    }

    const expectedRoot =
      scope.kind === 'global'
        ? join(canonicalOwner, 'sessions', 'global')
        : join(canonicalOwner, '.mcp-indexer', 'session');
    await ensureDirectoryTreeNoLinks(canonicalOwner, expectedRoot);
    await assertExistingDirectory(expectedRoot, 'session root');
    return expectedRoot;
  }

  async assertSafeLocation(location: SessionLocation, options: { readonly mustExist?: boolean } = {}): Promise<void> {
    const expected = this.locate(location.scope, location.session_id);
    const expectedBundle = resolve(expected.bundle_path);
    if (expectedBundle !== resolve(location.bundle_path)) {
      throw new UnsafeSessionPathError(`Session location does not match its scope: ${location.bundle_path}`);
    }
    assertContainedPath(expected.session_root, expectedBundle);
    await assertPathHasNoLinks(expected.session_root, expected.session_root);

    if (options.mustExist) {
      const stat = await lstat(expectedBundle);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new UnsafeSessionPathError(`Session bundle is not a safe directory: ${expectedBundle}`);
      }
      await assertPathHasNoLinks(expected.session_root, expectedBundle);
    }
  }
}
