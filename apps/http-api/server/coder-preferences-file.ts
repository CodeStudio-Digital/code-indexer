import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { atomicWriteJson } from '@mcp/session-storage';

export interface CoderSelectedModel {
  provider: string;
  model: string;
}

interface CoderPreferencesDocument {
  schema_version: 1;
  last_selected_model: {
    provider: string;
    model: string;
    updated_at: string;
  } | null;
}

export const CODER_PREFERENCES_RELATIVE_PATH = join(
  'preferences',
  'coder.json',
);

function parseSelectedModel(value: unknown): CoderSelectedModel | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const document = value as Record<string, unknown>;
  if (document.schema_version !== 1) return null;
  const selected = document.last_selected_model;
  if (!selected || typeof selected !== 'object' || Array.isArray(selected)) {
    return null;
  }
  const record = selected as Record<string, unknown>;
  const provider =
    typeof record.provider === 'string' ? record.provider.trim() : '';
  const model = typeof record.model === 'string' ? record.model.trim() : '';
  return provider && model ? { provider, model } : null;
}

/**
 * Small process-wide preferences file for coder UI/runtime choices.
 *
 * Session history stays in filesystem bundles. This file only stores the
 * latest provider/model selection needed to open the next conversation
 * without scanning or hydrating those bundles.
 */
export class CoderPreferencesFile {
  readonly path: string;
  #loaded = false;
  #lastSelectedModel: CoderSelectedModel | null = null;
  #operations: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.path = path;
  }

  static fromDataDir(dataDir: string): CoderPreferencesFile {
    return new CoderPreferencesFile(
      join(dataDir, CODER_PREFERENCES_RELATIVE_PATH),
    );
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operations.then(operation, operation);
    this.#operations = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  getLastSelectedModel(): Promise<CoderSelectedModel | null> {
    if (this.#loaded) {
      return Promise.resolve(
        this.#lastSelectedModel
          ? { ...this.#lastSelectedModel }
          : null,
      );
    }
    return this.#enqueue(async () => {
      if (!this.#loaded) {
        try {
          this.#lastSelectedModel = parseSelectedModel(
            JSON.parse(await readFile(this.path, 'utf8')),
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            console.warn(
              `[coder-preferences] ignoring unreadable ${this.path}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
          this.#lastSelectedModel = null;
        }
        this.#loaded = true;
      }
      return this.#lastSelectedModel
        ? { ...this.#lastSelectedModel }
        : null;
    });
  }

  setLastSelectedModel(provider: string, model: string): Promise<void> {
    const selected = {
      provider: provider.trim(),
      model: model.trim(),
    };
    if (!selected.provider || !selected.model) {
      return Promise.reject(
        new TypeError('coder provider and model must be non-empty'),
      );
    }
    return this.#enqueue(async () => {
      const document: CoderPreferencesDocument = {
        schema_version: 1,
        last_selected_model: {
          ...selected,
          updated_at: new Date().toISOString(),
        },
      };
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      await atomicWriteJson(this.path, document);
      this.#lastSelectedModel = selected;
      this.#loaded = true;
    });
  }
}
