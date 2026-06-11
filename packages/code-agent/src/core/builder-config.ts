/**
 * Parse seguro do `projects.builder_json` para o que o runner precisa
 * decidir em tempo de montagem: este projeto é um workspace de Design
 * System (DS Studio)?
 *
 * Shape persistido pelo scaffold (campos aditivos sobre o builder comum):
 *   {"stack":"react-ts","port":5181,"kind":"ds","packageName":"@acme/ds"}
 *
 * `kind` ausente = builder comum (V0-style) ou projeto normal — o DS
 * Studio é a única variante que registra tools `ds_*` e o bloco de
 * prompt próprio na sessão single.
 */

export interface DsWorkspaceConfig {
  stack: string;
  port: number | null;
  packageName: string | null;
}

export function parseDsWorkspace(builderJson: string | null | undefined): DsWorkspaceConfig | null {
  if (!builderJson) return null;
  try {
    const cfg = JSON.parse(builderJson) as {
      stack?: unknown;
      port?: unknown;
      kind?: unknown;
      packageName?: unknown;
    };
    if (cfg.kind !== 'ds') return null;
    return {
      stack: typeof cfg.stack === 'string' ? cfg.stack : 'react-ts',
      port: typeof cfg.port === 'number' ? cfg.port : null,
      packageName: typeof cfg.packageName === 'string' ? cfg.packageName : null,
    };
  } catch {
    return null;
  }
}

export function isDsWorkspace(builderJson: string | null | undefined): boolean {
  return parseDsWorkspace(builderJson) !== null;
}
