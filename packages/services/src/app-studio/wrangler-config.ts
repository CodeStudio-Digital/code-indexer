/**
 * Leitura/escrita cirúrgica do wrangler.jsonc do App Studio. O template é
 * NOSSO (determinístico), então `writeDatabaseId` faz replace textual do
 * campo `database_id` dentro do stanza do binding "DB" — preserva
 * comentários e formatação (um parse+reserialize os destruiria).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseJsonc } from '@mcp/app-studio/jsonc.js';

export interface WranglerD1Binding {
  binding?: string;
  database_name?: string;
  database_id?: string;
  migrations_dir?: string;
}

export interface WranglerConfig {
  name?: string;
  main?: string;
  d1_databases?: WranglerD1Binding[];
}

export const DATABASE_ID_PLACEHOLDER = 'APP-STUDIO-PLACEHOLDER';

export function readWranglerConfig(workspaceDir: string): WranglerConfig | null {
  const path = join(workspaceDir, 'wrangler.jsonc');
  if (!existsSync(path)) return null;
  return parseJsonc<WranglerConfig>(readFileSync(path, 'utf8'));
}

/** database_id corrente do binding DB (null = sem binding/placeholder). */
export function currentDatabaseId(workspaceDir: string): string | null {
  const config = readWranglerConfig(workspaceDir);
  const db = (config?.d1_databases ?? []).find((b) => b.binding === 'DB');
  if (!db?.database_id || db.database_id === DATABASE_ID_PLACEHOLDER) return null;
  return db.database_id;
}

/**
 * Substitui o valor de `database_id` no stanza que contém `"binding": "DB"`.
 * Regex tolerante a whitespace/ordem-de-campos dentro do stanza; lança se
 * o padrão não casar (wrangler.jsonc adulterado — melhor falhar alto do
 * que deployar apontando para o placeholder).
 */
export function writeDatabaseId(workspaceDir: string, databaseId: string): void {
  const path = join(workspaceDir, 'wrangler.jsonc');
  const raw = readFileSync(path, 'utf8');
  const re = /("binding"\s*:\s*"DB"[\s\S]{0,400}?"database_id"\s*:\s*")([^"]*)(")/;
  if (!re.test(raw)) {
    throw new Error(
      'wrangler.jsonc: could not locate the "database_id" field of the "DB" binding — the managed d1_databases stanza was altered.',
    );
  }
  writeFileSync(path, raw.replace(re, `$1${databaseId}$3`), 'utf8');
}
