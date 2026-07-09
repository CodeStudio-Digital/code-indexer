/**
 * Arquivos de status machine-managed em `<workspace>/.app-studio/` —
 * escritos pelo provisioner (db.json) e pela launch chain (deploy.json),
 * LIDOS pelos gates (que nunca spawnam wrangler). O diretório é gitignored
 * pelo template e reservado (o agente não edita).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const APP_STUDIO_DIRNAME = '.app-studio';

export interface AppDbStatusFile {
  engine: 'd1' | 'postgres' | 'mysql';
  local_ready: boolean;
  /** Nomes de arquivo de migrations/ já aplicadas localmente. */
  applied: string[];
  /** true = seeds/seed.sql foi carregado no banco local. */
  seeded?: boolean;
  last_apply_at: string;
}

export interface AppDeployStatusFile {
  url: string | null;
  health_ok: boolean;
  database_id?: string | null;
  account?: string | null;
  deployed_at?: string | null;
}

function readJson<T>(path: string): T | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

function writeJson(workspaceDir: string, filename: string, value: unknown): void {
  const dir = join(workspaceDir, APP_STUDIO_DIRNAME);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), JSON.stringify(value, null, 2), 'utf8');
}

export function readDbStatus(workspaceDir: string): AppDbStatusFile | null {
  return readJson<AppDbStatusFile>(join(workspaceDir, APP_STUDIO_DIRNAME, 'db.json'));
}

export function writeDbStatus(workspaceDir: string, status: AppDbStatusFile): void {
  writeJson(workspaceDir, 'db.json', status);
}

export function readDeployStatus(workspaceDir: string): AppDeployStatusFile | null {
  return readJson<AppDeployStatusFile>(join(workspaceDir, APP_STUDIO_DIRNAME, 'deploy.json'));
}

export function writeDeployStatus(workspaceDir: string, status: AppDeployStatusFile): void {
  writeJson(workspaceDir, 'deploy.json', status);
}
