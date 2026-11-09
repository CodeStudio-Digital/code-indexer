import {
  CompanySessionFileCollection,
  type CompanyOperationalSessionStore,
} from './company-session-file-collection.js';
import { normalizeServiceScope, scopeIncludesService } from './env-scope.js';

export type CompanySessionEnvSource = 'user' | 'imported' | 'auto' | 'agent';

export interface CompanySessionEnvRow {
  id: string;
  seq: number;
  session_id: string;
  key: string;
  value: string;
  is_secret: 0 | 1;
  source: CompanySessionEnvSource;
  service_scope: string | null;
  created_at: string;
  updated_at: string;
}

export interface UpsertOptions {
  source?: CompanySessionEnvSource;
  onlyIfAbsent?: boolean;
  serviceScope?: string | null;
}

export interface CompanyEnvSecretCodec {
  encrypt(plaintext: string): string | Promise<string>;
  decrypt(ciphertext: string): string | Promise<string>;
}

interface EncryptedEnvValue {
  kind: 'encrypted-company-secret';
  version: 1;
  algorithm: 'os-keychain';
  ciphertext: string;
}

interface CompanyEnvironmentFileData {
  [key: string]: unknown;
  name: string;
  variables: {
    is_secret: boolean;
    value: string | null;
    source: CompanySessionEnvSource;
    service_scope: string | null;
  };
  secrets: Record<string, EncryptedEnvValue>;
}

function isPromise<T>(value: T | Promise<T>): value is Promise<T> {
  return (
    value != null &&
    typeof value === 'object' &&
    typeof (value as Promise<T>).then === 'function'
  );
}

function assertCiphertext(value: string): string {
  if (!value.startsWith('enc:') || value.length <= 4) {
    throw new Error(
      'Company env secret encryption is unavailable; refusing plaintext/non-keychain persistence',
    );
  }
  return value;
}

export class CompanySessionEnvStore {
  private readonly files: CompanySessionFileCollection<CompanyEnvironmentFileData>;
  private readonly plaintextCache = new Map<string, string>();

  constructor(
    sessions: CompanyOperationalSessionStore,
    private readonly secretCodec?: CompanyEnvSecretCodec,
  ) {
    this.files = new CompanySessionFileCollection(
      sessions,
      'environments',
      'company.environment',
    );
  }

  /**
   * Worker startup hydrates keychain-backed values before sync sandbox helpers
   * begin reading them. Failure is fatal: no empty-string/plaintext fallback.
   */
  async initialize(): Promise<void> {
    if (!this.secretCodec) return;
    for (const { sessionId, record } of this.files.listAcrossSessions()) {
      if (!record.data.variables.is_secret) continue;
      const envelope = record.data.secrets.value;
      if (!envelope) {
        throw new Error(
          `Secret Company env ${sessionId}:${record.data.name} has no encrypted envelope`,
        );
      }
      const plaintext = await this.secretCodec.decrypt(envelope.ciphertext);
      this.plaintextCache.set(this.cacheKey(sessionId, record.id, envelope.ciphertext), plaintext);
    }
  }

  /** Read one consistent file snapshot and hydrate changed/new secrets across processes. */
  async listAsync(sessionId: string): Promise<CompanySessionEnvRow[]> {
    const records = this.files.list(sessionId);
    const rows: CompanySessionEnvRow[] = [];
    for (const record of records) {
      if (!record.data.variables.is_secret) { rows.push(this.mapRow(sessionId, record)); continue; }
      const envelope = record.data.secrets.value;
      if (!envelope || !this.secretCodec) throw new Error('Company secret codec/envelope unavailable');
      const key = this.cacheKey(sessionId, record.id, envelope.ciphertext);
      if (!this.plaintextCache.has(key)) {
        const value = await this.secretCodec.decrypt(envelope.ciphertext);
        this.evictEntity(sessionId, record.id);
        this.plaintextCache.set(key, value);
      }
      rows.push(this.mapRow(sessionId, record));
    }
    return rows.sort((a, b) => a.key.localeCompare(b.key));
  }
  /** Metadata discovery never decrypts values or injects secrets into a prompt. */
  listMetadata(sessionId: string): CompanySessionEnvRow[] {
    return this.files.list(sessionId).map((record) => ({
      id: record.id, seq: record.seq, session_id: sessionId, key: record.data.name,
      value: '', is_secret: record.data.variables.is_secret ? 1 as const : 0 as const,
      source: record.data.variables.source, service_scope: record.data.variables.service_scope,
      created_at: record.createdAt, updated_at: record.updatedAt,
    })).sort((a, b) => a.key.localeCompare(b.key));
  }
  async getAsync(sessionId: string, key: string): Promise<CompanySessionEnvRow | null> {
    return (await this.listAsync(sessionId)).find((row) => row.key === key) ?? null;
  }

  list(sessionId: string): CompanySessionEnvRow[] {
    return this.files
      .list(sessionId)
      .map((record) => this.mapRow(sessionId, record))
      .sort((left, right) => left.key.localeCompare(right.key));
  }

  get(sessionId: string, key: string): CompanySessionEnvRow | null {
    const record = this.files
      .list(sessionId)
      .find((candidate) => candidate.data.name === key);
    return record ? this.mapRow(sessionId, record) : null;
  }

  async upsert(
    sessionId: string,
    key: string,
    value: string,
    isSecret: boolean,
    opts: UpsertOptions = {},
  ): Promise<void> {
    const existing = this.files
      .list(sessionId)
      .find((candidate) => candidate.data.name === key);
    if (existing && opts.onlyIfAbsent) return;
    const serviceScope =
      opts.serviceScope === undefined
        ? existing?.data.variables.service_scope ?? null
        : normalizeServiceScope(opts.serviceScope);
    let envelope: EncryptedEnvValue | null = null;
    if (isSecret) {
      if (!this.secretCodec) {
        throw new Error(
          `Cannot persist secret Company env ${key}: OS keychain codec unavailable`,
        );
      }
      const ciphertext = assertCiphertext(
        await this.secretCodec.encrypt(value),
      );
      envelope = {
        kind: 'encrypted-company-secret',
        version: 1,
        algorithm: 'os-keychain',
        ciphertext,
      };
    }
    const data: CompanyEnvironmentFileData = {
      name: key,
      variables: {
        is_secret: isSecret,
        value: isSecret ? null : value,
        source: opts.source ?? 'user',
        service_scope: serviceScope,
      },
      secrets: envelope ? { value: envelope } : {},
    };
    // Encryption is asynchronous. Re-read under the shared entity lock after
    // it finishes, so concurrent processes cannot create duplicate keys or
    // overwrite a scope changed while keychain I/O was pending.
    let committed = true;
    const record = this.files.upsertFirst(
      sessionId,
      (candidate) => candidate.data.name === key,
      () => ({ data }),
      (current) => {
        if (opts.onlyIfAbsent) { committed = false; return current.data; }
        return { ...data, variables: { ...data.variables,
          service_scope: opts.serviceScope === undefined ? current.data.variables.service_scope : serviceScope,
        } };
      },
    );
    if (!committed) return;
    const cacheKey = this.cacheKey(sessionId, record.id, envelope?.ciphertext);
    this.evictEntity(sessionId, record.id);
    if (isSecret) this.plaintextCache.set(cacheKey, value);
    else this.plaintextCache.delete(cacheKey);
  }

  delete(sessionId: string, key: string): void {
    const existing = this.files
      .list(sessionId)
      .find((candidate) => candidate.data.name === key);
    if (!existing) return;
    this.files.moveToTrash(sessionId, existing.id);
    this.evictEntity(sessionId, existing.id);
  }

  asRecord(sessionId: string): Record<string, string> {
    return Object.fromEntries(
      this.list(sessionId).map((row) => [row.key, row.value]),
    );
  }

  asRecordForService(
    sessionId: string,
    serviceId: string,
  ): Record<string, string> {
    return Object.fromEntries(
      this.list(sessionId)
        .filter((row) => scopeIncludesService(row.service_scope, serviceId))
        .map((row) => [row.key, row.value]),
    );
  }

  private mapRow(
    sessionId: string,
    record: ReturnType<CompanySessionFileCollection<CompanyEnvironmentFileData>['list']>[number],
  ): CompanySessionEnvRow {
    const variables = record.data.variables;
    let value = variables.value ?? '';
    if (variables.is_secret) {
      const envelope = record.data.secrets.value;
      if (!envelope || envelope.kind !== 'encrypted-company-secret') {
        throw new Error(
          `Secret Company env ${sessionId}:${record.data.name} has no encrypted envelope`,
        );
      }
      const cacheKey = this.cacheKey(sessionId, record.id, envelope.ciphertext);
      const cached = this.plaintextCache.get(cacheKey);
      if (cached !== undefined) {
        value = cached;
      } else {
        if (!this.secretCodec) {
          throw new Error(
            `Cannot decrypt secret Company env ${record.data.name}: OS keychain codec unavailable`,
          );
        }
        const decrypted = this.secretCodec.decrypt(envelope.ciphertext);
        if (isPromise(decrypted)) {
          throw new Error(
            `Secret Company env ${record.data.name} was not hydrated before synchronous access`,
          );
        }
        value = decrypted;
        this.plaintextCache.set(cacheKey, decrypted);
      }
    }
    return {
      id: record.id,
      seq: record.seq,
      session_id: sessionId,
      key: record.data.name,
      value,
      is_secret: variables.is_secret ? 1 : 0,
      source: variables.source,
      service_scope: variables.service_scope,
      created_at: record.createdAt,
      updated_at: record.updatedAt,
    };
  }

  private cacheKey(sessionId: string, entityId: string, ciphertext?: string): string {
    return sessionId.toLowerCase() + ':' + entityId.toLowerCase() + ':' + (ciphertext ?? '');
  }
  private evictEntity(sessionId: string, entityId: string): void {
    const prefix = this.cacheKey(sessionId, entityId);
    for (const key of this.plaintextCache.keys()) if (key.startsWith(prefix)) this.plaintextCache.delete(key);
  }
}
