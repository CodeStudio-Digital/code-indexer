import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { FileSessionRepository } from './file-session-repository.js';
import { SessionLocator } from './session-locator.js';
import {
  asSessionId,
  isUuid,
  type CatalogEntry,
  type CatalogScanIssue,
  type CatalogScanResult,
  type SessionId,
  type SessionLocation,
  type SessionMetadata,
  type SessionRepositoryEvent,
  type SessionState,
  type SessionStorageScope,
} from './types.js';

export interface SessionCatalogOptions {
  readonly locator: SessionLocator;
  readonly repository?: FileSessionRepository;
}

function keyFor(id: SessionId): string {
  return String(id).toLowerCase();
}

function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException)?.code ?? (error as Error)?.name ?? 'UNKNOWN';
}

function compareEntries(left: CatalogEntry, right: CatalogEntry): number {
  const leftTime = Date.parse(left.session.updated_at);
  const rightTime = Date.parse(right.session.updated_at);
  if (leftTime !== rightTime) return rightTime - leftTime;
  return String(left.session.id).localeCompare(String(right.session.id));
}

export class SessionCatalog {
  readonly #locator: SessionLocator;
  readonly #repository?: FileSessionRepository;
  readonly #entries = new Map<string, CatalogEntry>();
  readonly #duplicateIds = new Set<string>();
  #issues: CatalogScanIssue[] = [];
  #unsubscribe: (() => void) | null = null;
  #ready = false;
  #refreshing: Promise<CatalogScanResult> | null = null;

  constructor(options: SessionCatalogOptions) {
    this.#locator = options.locator;
    this.#repository = options.repository;
    if (this.#repository) {
      this.#unsubscribe = this.#repository.subscribe((event) => {
        this.#handleRepositoryEvent(event);
      });
    }
  }

  list(): readonly CatalogEntry[] {
    return [...this.#entries.values()].sort(compareEntries);
  }

  /** Stable membership for bounded/cooperative queries that rank their own
   * result window without synchronously sorting the entire catalog first. */
  entriesSnapshot(): readonly CatalogEntry[] {
    return [...this.#entries.values()];
  }

  get(id: SessionId | string): CatalogEntry | null {
    if (!isUuid(id)) return null;
    return this.#entries.get(keyFor(asSessionId(id))) ?? null;
  }

  get issues(): readonly CatalogScanIssue[] {
    return this.#issues.slice();
  }

  /**
   * Prime the shared catalog once. Multiple host services receive the same
   * SessionCatalog instance, so readiness belongs here rather than in each
   * consumer; otherwise the first Coder, Company and App Studio requests each
   * repeat the full cross-project filesystem scan.
   */
  async ensureReady(): Promise<void> {
    if (this.#ready) return;
    await this.refresh();
  }

  async refresh(options: { readonly strict?: boolean } = {}): Promise<CatalogScanResult> {
    const pending =
      this.#refreshing ??
      (this.#refreshing = this.#scan().then((result) => {
        this.#ready = true;
        return result;
      }));
    let result: CatalogScanResult;
    try {
      result = await pending;
    } finally {
      if (this.#refreshing === pending) this.#refreshing = null;
    }

    if (options.strict && result.issues.length > 0) {
      throw new AggregateError(
        result.issues.map((issue) => new Error(`${issue.root_path}: ${issue.message}`)),
        'One or more session roots could not be scanned',
      );
    }
    return result;
  }

  async #scan(): Promise<CatalogScanResult> {
    const entries = new Map<string, CatalogEntry>();
    const duplicateIds = new Set<string>();
    const issues: CatalogScanIssue[] = [];
    for (const root of this.#locator.allKnownSessionRoots()) {
      await this.#scanRoot(
        root.scope,
        root.session_root,
        entries,
        duplicateIds,
        issues,
      );
    }
    this.#entries.clear();
    for (const [key, entry] of entries) this.#entries.set(key, entry);
    this.#duplicateIds.clear();
    for (const key of duplicateIds) this.#duplicateIds.add(key);
    this.#issues = issues;
    return { entries: this.list(), issues: this.issues };
  }

  async #scanRoot(
    scope: SessionStorageScope,
    sessionRoot: string,
    output: Map<string, CatalogEntry>,
    duplicateIds: Set<string>,
    issues: CatalogScanIssue[],
  ): Promise<void> {
    let children;
    try {
      const rootStat = await lstat(sessionRoot);
      if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
        throw new Error('Session root is not a safe directory');
      }
      children = await readdir(sessionRoot, { withFileTypes: true });
    } catch (error) {
      issues.push({
        root_path: sessionRoot,
        code: errorCode(error),
        message: (error as Error).message,
      });
      return;
    }

    for (const child of children) {
      if (child.name.startsWith('.') || !child.isDirectory() || child.isSymbolicLink() || !isUuid(child.name)) {
        continue;
      }
      const id = asSessionId(child.name);
      const location: SessionLocation = {
        session_id: id,
        scope,
        session_root: resolve(sessionRoot),
        bundle_path: join(resolve(sessionRoot), id),
      };
      try {
        const bundleStat = await lstat(location.bundle_path);
        if (bundleStat.isSymbolicLink() || !bundleStat.isDirectory()) {
          throw new Error('Session bundle is not a safe directory');
        }
        const sessionPath = join(location.bundle_path, 'session.json');
        const statePath = join(location.bundle_path, 'state.json');
        const [sessionStat, stateStat, sessionText, stateText] = await Promise.all([
          lstat(sessionPath),
          lstat(statePath),
          readFile(sessionPath, 'utf8'),
          readFile(statePath, 'utf8'),
        ]);
        if (sessionStat.isSymbolicLink() || stateStat.isSymbolicLink()) {
          throw new Error('Session projection files cannot be symbolic links');
        }
        const session = JSON.parse(sessionText) as SessionMetadata;
        const state = JSON.parse(stateText) as SessionState;
        if (session.id !== id) throw new Error('session.json id does not match directory');
        if (session.schema_version !== 1 || state.schema_version !== 1) {
          throw new Error('Unsupported filesystem session schema');
        }
        if (
          session.storage_scope.kind !== scope.kind ||
          (scope.kind === 'project' &&
            (session.storage_scope.kind !== 'project' ||
              String(session.storage_scope.project_id) !== String(scope.project_id)))
        ) {
          throw new Error('session.json storage scope does not match directory root');
        }
        const key = keyFor(id);
        if (duplicateIds.has(key)) {
          throw Object.assign(
            new Error(`Duplicate session UUID ${id} found in multiple roots`),
            { code: 'DUPLICATE_SESSION_UUID' },
          );
        }
        const previous = output.get(key);
        if (previous) {
          output.delete(key);
          duplicateIds.add(key);
          issues.push({
            root_path: previous.location.bundle_path,
            code: 'DUPLICATE_SESSION_UUID',
            message: `Duplicate session UUID ${id} found in multiple roots`,
          });
          throw Object.assign(
            new Error(`Duplicate session UUID ${id} found in multiple roots`),
            { code: 'DUPLICATE_SESSION_UUID' },
          );
        }
        output.set(key, { location, session, state });
      } catch (error) {
        issues.push({
          root_path: location.bundle_path,
          code: errorCode(error),
          message: (error as Error).message,
        });
      }
    }
  }

  #handleRepositoryEvent(event: SessionRepositoryEvent): void {
    const key = keyFor(event.location.session_id);
    if (this.#duplicateIds.has(key)) {
      this.#entries.delete(key);
      return;
    }
    if (event.type === 'trashed') {
      this.#entries.delete(key);
      return;
    }
    if (!this.#repository) return;
    try {
      const session = event.projection?.session ?? this.#repository.readSessionSync(event.location);
      const state = event.projection?.state ?? this.#repository.readStateSync(event.location);
      this.#entries.set(key, { location: event.location, session, state });
    } catch {
      // A refresh reports detailed root issues. Repository events must not make
      // a successful mutation fail because a catalog projection is stale.
      this.#entries.delete(key);
    }
  }

  close(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#entries.clear();
    this.#duplicateIds.clear();
    this.#issues = [];
    this.#ready = false;
    this.#refreshing = null;
  }
}
