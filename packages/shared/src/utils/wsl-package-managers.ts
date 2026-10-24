/**
 * Per-project, per-WSL-distro package-manager preference (Node/Python) — fonte
 * ÚNICA de parsing/escrita. Persistido em
 * `project_runtime_config.wsl_package_managers` (JSON, migration 183). Espelha
 * `package-managers.ts` (host), com o eixo do distro WSL.
 *
 * Forma: `{ "<distro>": { "node": "npm", "python": "pip" } }`. Ausente/'auto' =
 * o runner detecta pelo lockfile/manifest. PHP é fixo (composer) → sem chave.
 * Sem deps de DB.
 */

export type WslPackageManagerKey = 'node' | 'python' | 'java';
type WslDistroManagers = Partial<Record<WslPackageManagerKey, string>>;
type WslPackageManagers = Record<string, WslDistroManagers>;

const KEYS: readonly WslPackageManagerKey[] = ['node', 'python', 'java'];

/** JSON → mapa por distro, tolerante a corrupção/shape inválido. */
export function parseWslPackageManagers(json: string | null | undefined): WslPackageManagers {
  if (!json) return {};
  try {
    const obj = JSON.parse(json) as unknown;
    if (!obj || typeof obj !== 'object') return {};
    const rec = obj as Record<string, unknown>;
    const out: WslPackageManagers = {};
    for (const [distro, raw] of Object.entries(rec)) {
      if (!raw || typeof raw !== 'object') continue;
      const inner = raw as Record<string, unknown>;
      const dm: WslDistroManagers = {};
      for (const k of KEYS) {
        const v = inner[k];
        if (typeof v === 'string' && v.length > 0) dm[k] = v;
      }
      if (Object.keys(dm).length > 0) out[distro] = dm;
    }
    return out;
  } catch {
    return {};
  }
}

/** Manager escolhido para `kind` no `distro`, ou undefined (= auto). */
export function readWslPackageManager(
  json: string | null | undefined,
  distro: string,
  kind: WslPackageManagerKey,
): string | undefined {
  return parseWslPackageManagers(json)[distro]?.[kind];
}

/**
 * Funde a escolha e devolve o JSON, preservando os outros distros/kinds. `id`
 * vazio/null/'auto' REMOVE a chave; um distro que fica sem kinds é podado.
 */
export function writeWslPackageManager(
  json: string | null | undefined,
  distro: string,
  kind: WslPackageManagerKey,
  id: string | null | undefined,
): string {
  const next = parseWslPackageManagers(json);
  const dm = { ...(next[distro] ?? {}) };
  if (!id || id === 'auto') delete dm[kind];
  else dm[kind] = id;
  if (Object.keys(dm).length > 0) next[distro] = dm;
  else delete next[distro];
  return JSON.stringify(next);
}
