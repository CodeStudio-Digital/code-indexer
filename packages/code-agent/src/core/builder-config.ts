/**
 * Workspace App Studio (Code Studio para leigos): o projeto é um app
 * full-Cloudflare guiado por pipeline. Shape persistido no scaffold:
 *   {"stack":"cf-fullstack","port":5183,"kind":"app",
 *    "appName":"Lanchonete da Ana","appSlug":"lanchonete-da-ana","dbEngine":"d1"}
 * Todos os valores são fixados no scaffold (o bloco de prompt deriva
 * daqui; cache-estável).
 */
export interface AppWorkspaceConfig {
  stack: string;
  port: number | null;
  appName: string | null;
  appSlug: string | null;
  dbEngine: 'd1' | 'postgres' | 'mysql';
}

export function parseAppWorkspace(builderJson: string | null | undefined): AppWorkspaceConfig | null {
  if (!builderJson) return null;
  try {
    const cfg = JSON.parse(builderJson) as {
      stack?: unknown;
      port?: unknown;
      kind?: unknown;
      appName?: unknown;
      appSlug?: unknown;
      dbEngine?: unknown;
    };
    if (cfg.kind !== 'app') return null;
    return {
      stack: typeof cfg.stack === 'string' ? cfg.stack : 'cf-fullstack',
      port: typeof cfg.port === 'number' ? cfg.port : null,
      appName: typeof cfg.appName === 'string' ? cfg.appName : null,
      appSlug: typeof cfg.appSlug === 'string' ? cfg.appSlug : null,
      dbEngine: cfg.dbEngine === 'postgres' || cfg.dbEngine === 'mysql' ? cfg.dbEngine : 'd1',
    };
  } catch {
    return null;
  }
}
