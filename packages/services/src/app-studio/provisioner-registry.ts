/**
 * Registry dos provisioners de banco do App Studio. MVP: só 'd1'.
 * Postgres/MySQL (fase 2, via podman-core) implementam a mesma interface
 * e entram AQUI — os call sites (tool app_provision_db + launch chain)
 * não mudam.
 */
import type { AppDbEngine, DatabaseProvisioner } from '@mcp/app-studio/provisioner/types.js';
import { d1Provisioner } from './d1-provisioner.js';

export function getDatabaseProvisioner(engine: AppDbEngine): DatabaseProvisioner {
  if (engine === 'd1') return d1Provisioner;
  throw new Error(
    `Database engine '${engine}' is not available yet — the MVP ships D1; postgres/mysql via Podman land in phase 2.`,
  );
}
