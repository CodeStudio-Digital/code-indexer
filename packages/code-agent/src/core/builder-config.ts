/**
 * Parse seguro do `projects.builder_json` para o que o runner precisa
 * decidir em tempo de montagem: este projeto é um workspace de Design
 * System (DS Studio)? Ou um projeto builder que CONSOME um DS publicado?
 *
 * Shapes persistidos (campos aditivos sobre o builder comum):
 *   workspace DS Studio (o projeto É o design system):
 *     {"stack":"react-ts","port":5181,"kind":"ds","packageName":"@acme/ds"}
 *   consumidor (projeto builder vinculado a um DS publicado):
 *     {"stack":"react-ts","port":5181,
 *      "designSystem":{"sessionId":3,"packageName":"@acme/ui","semver":"1.2.0"}}
 *
 * `kind` ausente = builder comum (V0-style) ou projeto normal. As duas
 * variantes são mutuamente exclusivas: um workspace `kind:'ds'` nunca é
 * tratado como consumidor (parseDsConsumer retorna null nele).
 */

export type DsWorkspaceMode = 'fidelity' | 'creative';

export interface DsWorkspaceConfig {
  stack: string;
  port: number | null;
  packageName: string | null;
  /** Fixado no scaffold; null em workspaces criados antes do seletor de modo. */
  mode: DsWorkspaceMode | null;
}

export function parseDsWorkspace(builderJson: string | null | undefined): DsWorkspaceConfig | null {
  if (!builderJson) return null;
  try {
    const cfg = JSON.parse(builderJson) as {
      stack?: unknown;
      port?: unknown;
      kind?: unknown;
      packageName?: unknown;
      mode?: unknown;
    };
    if (cfg.kind !== 'ds') return null;
    return {
      stack: typeof cfg.stack === 'string' ? cfg.stack : 'react-ts',
      port: typeof cfg.port === 'number' ? cfg.port : null,
      packageName: typeof cfg.packageName === 'string' ? cfg.packageName : null,
      mode: cfg.mode === 'fidelity' || cfg.mode === 'creative' ? cfg.mode : null,
    };
  } catch {
    return null;
  }
}

export function isDsWorkspace(builderJson: string | null | undefined): boolean {
  return parseDsWorkspace(builderJson) !== null;
}

/** Vínculo de consumo: projeto builder apontando para um DS publicado. */
export interface DsConsumerConfig {
  sessionId: number;
  packageName: string;
  semver: string;
}

export function parseDsConsumer(builderJson: string | null | undefined): DsConsumerConfig | null {
  if (!builderJson) return null;
  try {
    const cfg = JSON.parse(builderJson) as { kind?: unknown; designSystem?: unknown };
    // Um workspace DS Studio nunca consome a si mesmo — as superfícies
    // (tools ds_* de autoria vs consulta) são mutuamente exclusivas.
    if (cfg.kind === 'ds') return null;
    const ds = cfg.designSystem as
      | { sessionId?: unknown; packageName?: unknown; semver?: unknown }
      | undefined;
    if (!ds || typeof ds !== 'object') return null;
    if (typeof ds.sessionId !== 'number' || !Number.isInteger(ds.sessionId) || ds.sessionId <= 0) return null;
    if (typeof ds.packageName !== 'string' || !ds.packageName) return null;
    if (typeof ds.semver !== 'string' || !ds.semver) return null;
    return { sessionId: ds.sessionId, packageName: ds.packageName, semver: ds.semver };
  } catch {
    return null;
  }
}
