import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { LegacyIdentity, UuidMapFile } from './model.js';
import { legacyIdentityKey, MIGRATION_FORMAT_VERSION } from './model.js';
import { atomicWriteJson, readJsonFile } from './fs-ops.js';

export class UuidRegistry {
  readonly #path: string | null;
  readonly #sourceFingerprint: string;
  readonly #identities = new Map<string, string>();
  readonly #createdAt: string;
  #dirty = false;

  constructor(path: string | null, sourceFingerprint: string) {
    this.#path = path;
    this.#sourceFingerprint = sourceFingerprint;
    if (path && existsSync(path)) {
      const file = readJsonFile<UuidMapFile>(path);
      if (file.format_version !== MIGRATION_FORMAT_VERSION) {
        throw new Error(`unsupported UUID map format at ${path}: ${file.format_version}`);
      }
      if (file.source_db_fingerprint !== sourceFingerprint) {
        throw new Error(
          `resume refused: UUID map belongs to a different source DB (${file.source_db_fingerprint})`,
        );
      }
      this.#createdAt = file.created_at;
      for (const [key, uuid] of Object.entries(file.identities)) {
        this.#identities.set(key, uuid);
      }
    } else {
      this.#createdAt = new Date().toISOString();
    }
  }

  forSession(identity: LegacyIdentity): string {
    return this.getOrCreate(legacyIdentityKey(identity));
  }

  getOrCreate(key: string): string {
    const existing = this.#identities.get(key);
    if (existing) return existing;
    const uuid = randomUUID();
    this.#identities.set(key, uuid);
    this.#dirty = true;
    return uuid;
  }

  get(key: string): string | undefined {
    return this.#identities.get(key);
  }

  alias(key: string, uuid: string): void {
    const existing = this.#identities.get(key);
    if (existing && existing !== uuid) {
      throw new Error(`UUID alias collision for ${key}: ${existing} != ${uuid}`);
    }
    if (!existing) {
      this.#identities.set(key, uuid);
      this.#dirty = true;
    }
  }

  save(): void {
    if (!this.#path) {
      this.#dirty = false;
      return;
    }
    if (!this.#dirty && existsSync(this.#path)) return;
    const identities = Object.fromEntries(
      [...this.#identities.entries()].sort(([left], [right]) => left.localeCompare(right)),
    );
    atomicWriteJson(this.#path, {
      format_version: MIGRATION_FORMAT_VERSION,
      source_db_fingerprint: this.#sourceFingerprint,
      created_at: this.#createdAt,
      identities,
    } satisfies UuidMapFile);
    this.#dirty = false;
  }
}
