/** One knowledge view for agents and HTTP. The drive is authoritative; a
 * sandbox is an optional working copy. Legacy sandbox-only docs remain readable. */
import { invalidateCompanyDoc } from './company-doc-corpus.js';
import { createHash } from 'node:crypto';
import type { SandboxBinding } from '../types.js';
import type { CompanyDriveStore, DriveOwnerRef } from './CompanyDriveStore.js';
import { checkRelativePath, DOCS_CONTENT_CAP_BYTES, DOCS_MIRROR_PREFIX } from '../tools/file-path-core.js';

export type DocOrigin = 'sandbox' | 'drive_mirror';
export interface CompanyDocEntry { path: string; service: string; origin: DocOrigin; mtime: string | null }
export interface CompanyDocContent { content: string; origin: DocOrigin; mtime: string | null; version: string }
export function normalizeDocServiceId(service?: string | null): string {
  const id = service || 'main';
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('invalid documentation service');
  return id;
}
export function validateDocPath(path: string): void {
  if (!checkRelativePath(path, { traversal: 'substring' }).ok || path.startsWith('.state/')) throw new Error('invalid documentation path');
}
export function docVersion(content: string): string { return createHash('sha256').update(content).digest('hex'); }
export function shellQuote(value: string): string { return `'${value.replace(/'/g, `'"'"'`)}'`; }

export class CompanyDocs {
  readonly service: string;
  constructor(private readonly drive: CompanyDriveStore, service: string | null | undefined,
    private readonly binding: SandboxBinding | null = null) { this.service = normalizeDocServiceId(service); }
  private key(path: string): string { return `${DOCS_MIRROR_PREFIX}${this.service}/${path}`; }
  private tombstone(path: string): string { return this.key(`.state/deleted/${path}`); }
  private durable(path: string) {
    const key = this.key(path);
    if (!this.drive.list(this.drive.resolveScopeKey(), { prefix: key }).some((row) => row.path === key)) return null;
    return this.drive.read(this.drive.resolveScopeKey(), key, { maxBytes: DOCS_CONTENT_CAP_BYTES });
  }
  private deleted(path: string): boolean {
    return this.drive.list(this.drive.resolveScopeKey(), { prefix: this.tombstone(path) }).some((row) => row.path === this.tombstone(path));
  }
  async list(): Promise<CompanyDocEntry[]> {
    const prefix = this.key('');
    const rows = this.drive.list(this.drive.resolveScopeKey(), { prefix });
    const deleted = new Set(rows.filter((r) => r.path.startsWith(this.key('.state/deleted/'))).map((r) => r.path.slice(this.key('.state/deleted/').length)));
    const entries = new Map<string, CompanyDocEntry>();
    for (const row of rows) {
      const path = row.path.slice(prefix.length);
      if (!path.startsWith('.state/') && !deleted.has(path)) entries.set(path, { path, service: this.service, origin: 'drive_mirror', mtime: row.updatedAt });
    }
    if (this.binding) {
      try {
        const { driver, containerId, workdir } = this.binding;
        const result = await driver.exec(containerId, `cd ${shellQuote(`${workdir}/docs`)} && find . -type f \\( -name '*.md' -o -name 'index.json' \\)`, { cwd: workdir, timeoutMs: 5_000 });
        if (result.exitCode === 0) for (const raw of result.stdout.split('\n')) {
          const path = raw.trim().replace(/^\.\//, '');
          if (!path || path.startsWith('.state/') || deleted.has(path) || entries.has(path) || !checkRelativePath(path, { traversal: 'substring' }).ok) continue;
          entries.set(path, { path, service: this.service, origin: 'sandbox', mtime: null });
        }
      } catch { /* Durable knowledge remains available while the sandbox is offline. */ }
    }
    return [...entries.values()].sort((a, b) => a.path.localeCompare(b.path));
  }
  async read(path: string): Promise<CompanyDocContent | null> {
    validateDocPath(path);
    if (this.deleted(path)) return null;
    const durable = this.durable(path);
    if (durable) return { content: durable.content, origin: 'drive_mirror', mtime: durable.meta.updatedAt, version: docVersion(durable.content) };
    if (!this.binding) return null;
    try {
      const content = await this.binding.driver.readFile(this.binding.containerId, `${this.binding.workdir}/docs/${path}`);
      return { content, origin: 'sandbox', mtime: null, version: docVersion(content) };
    } catch { return null; }
  }
  async write(path: string, content: string, owner: DriveOwnerRef = {}, expectedVersion?: string | null) {
    validateDocPath(path);
    if (Buffer.byteLength(content) > DOCS_CONTENT_CAP_BYTES) throw new Error(`content exceeds ${DOCS_CONTENT_CAP_BYTES} bytes`);
    // A durable failure must fail the operation, before changing the working copy.
    this.drive.write(this.drive.resolveScopeKey(), this.key(path), content, owner, expectedVersion);
    this.drive.delete(this.drive.resolveScopeKey(), this.tombstone(path));
    const rag = invalidateCompanyDoc(this.drive.resolveScopeKey(), this.service, path);
    let workingCopy: 'updated' | 'unavailable' | 'failed' = 'unavailable';
    if (this.binding) {
      try {
        await this.binding.driver.writeFile(this.binding.containerId, `${this.binding.workdir}/docs/${path}`, content, { recursive: true });
        workingCopy = 'updated';
      } catch { workingCopy = 'failed'; }
    }
    return { saved: true, version: docVersion(content), service: this.service, workingCopy, rag };
  }
  async delete(path: string) {
    validateDocPath(path);
    // Tombstones prevent an unavailable/stale container from resurrecting a deletion.
    this.drive.write(this.drive.resolveScopeKey(), this.tombstone(path), new Date().toISOString());
    this.drive.delete(this.drive.resolveScopeKey(), this.key(path));
    const rag = invalidateCompanyDoc(this.drive.resolveScopeKey(), this.service, path);
    let workingCopy = 'unavailable';
    if (this.binding) {
      try {
        const result = await this.binding.driver.exec(this.binding.containerId, `rm -f -- ${shellQuote(`${this.binding.workdir}/docs/${path}`)}`, { cwd: this.binding.workdir, timeoutMs: 5_000 });
        workingCopy = result.exitCode === 0 ? 'updated' : 'failed';
      } catch { workingCopy = 'failed'; }
    }
    return { deleted: true, service: this.service, workingCopy, rag };
  }
}
