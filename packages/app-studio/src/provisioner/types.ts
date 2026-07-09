/**
 * Contrato do provisioner de banco do App Studio — interface pura (as
 * implementações vivem em @mcp/services, que pode importar este pacote;
 * nunca o inverso).
 *
 * MVP: engine 'd1' (Cloudflare D1 — dev local via miniflare, prod criado
 * na launch chain). Fase 2: 'postgres'/'mysql' via Podman implementam a
 * MESMA interface (ensureLocal sobe o container + aplica migrations;
 * provisionRemote orienta Hyperdrive/banco hospedado).
 *
 * Fronteira de segurança: `ensureLocal` é agent-callable (tool
 * app_provision_db); `provisionRemote`/`applyRemoteMigrations` tocam a
 * conta Cloudflare do USUÁRIO e são exclusivos da launch chain iniciada
 * pelo usuário na UI.
 */
import type { AppDbStatusFile } from '../status-files.js';

export type AppDbEngine = 'd1' | 'postgres' | 'mysql';

export interface ProvisionCtx {
  /** Raiz do workspace (contém wrangler.jsonc e migrations/). */
  workspaceDir: string;
  /** Worker name / prefixo dos recursos remotos. */
  appSlug: string;
  /** Nome do binding D1 no wrangler.jsonc (o template fixa 'DB'). */
  bindingName: 'DB';
  onLog?: (stream: 'stdout' | 'stderr', chunk: string) => void;
  signal?: AbortSignal;
  /** Overrides p/ os spawns (ex: CLOUDFLARE_API_TOKEN no caminho avançado). */
  env?: Record<string, string>;
}

export interface ProvisionOutcome {
  ok: boolean;
  /** Migrations aplicadas nesta execução (nomes de arquivo). */
  applied: string[];
  error?: string;
}

export interface DatabaseProvisioner {
  readonly engine: AppDbEngine;
  /** Aplica migrations + carrega seeds/seed.sql no banco LOCAL e grava .app-studio/db.json. */
  ensureLocal(ctx: ProvisionCtx): Promise<ProvisionOutcome>;
  /**
   * Cria o banco remoto e ESCREVE o database_id no wrangler.jsonc.
   * `created` = true quando o banco foi criado AGORA (false = reuso de id
   * já presente); a launch chain só semeia o remoto numa criação nova.
   */
  provisionRemote(ctx: ProvisionCtx): Promise<{ databaseId: string; created: boolean }>;
  /** Aplica migrations no banco remoto (pós provisionRemote). */
  applyRemoteMigrations(ctx: ProvisionCtx): Promise<ProvisionOutcome>;
  /** Carrega seeds/seed.sql no banco REMOTO (só na 1ª criação — dados de exemplo). */
  applyRemoteSeed(ctx: ProvisionCtx): Promise<ProvisionOutcome>;
  /** Estado corrente do db.json (null = nunca provisionado). */
  status(ctx: ProvisionCtx): Promise<AppDbStatusFile | null>;
}
