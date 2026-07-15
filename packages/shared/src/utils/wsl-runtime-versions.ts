/**
 * Per-project, per-WSL-distro runtime selection — fonte ÚNICA de parsing/escrita.
 * Persistido em `project_runtime_config.wsl_runtime_versions` (JSON, migration
 * 182). Espelha `runtime-versions.ts`, mas com um eixo a mais: o distro WSL.
 *
 * Forma: `{ "<distro>": { "node": "managed:20.11.0", "python": "managed:3.12.3" } }`.
 * O valor é o id de runtime GERENCIADO escolhido para aquele distro (resolvido em
 * spawn-time para `$HOME/.mcp/runtimes/<kind>/<ver>/bin`). Ausente/'system' =
 * default do distro (sem injeção de PATH). Sem deps de DB — reusado pela UI e
 * pelo resolver de PATH.
 */

export type WslRuntimeKind = 'node' | 'php' | 'python' | 'java' | 'dotnet';
export type WslDistroVersions = Partial<Record<WslRuntimeKind, string>>;
export type WslRuntimeVersions = Record<string, WslDistroVersions>;

const KINDS: readonly WslRuntimeKind[] = ['node', 'php', 'python', 'java', 'dotnet'];

/** JSON → mapa por distro, tolerante a corrupção/shape inválido. */
export function parseWslRuntimeVersions(json: string | null | undefined): WslRuntimeVersions {
  if (!json) return {};
  try {
    const obj = JSON.parse(json) as unknown;
    if (!obj || typeof obj !== 'object') return {};
    const rec = obj as Record<string, unknown>;
    const out: WslRuntimeVersions = {};
    for (const [distro, raw] of Object.entries(rec)) {
      if (!raw || typeof raw !== 'object') continue;
      const inner = raw as Record<string, unknown>;
      const dv: WslDistroVersions = {};
      for (const k of KINDS) {
        const v = inner[k];
        if (typeof v === 'string' && v.length > 0) dv[k] = v;
      }
      if (Object.keys(dv).length > 0) out[distro] = dv;
    }
    return out;
  } catch {
    return {};
  }
}

/** Id de runtime escolhido para `kind` no `distro`, ou undefined (= default). */
export function readWslRuntimeVersion(
  json: string | null | undefined,
  distro: string,
  kind: WslRuntimeKind,
): string | undefined {
  return parseWslRuntimeVersions(json)[distro]?.[kind];
}

/**
 * Funde a escolha e devolve o JSON atualizado, preservando os outros distros/kinds.
 * `id` vazio/null/'system' REMOVE a chave (volta ao default do distro); um distro
 * que fica sem kinds é podado.
 */
export function writeWslRuntimeVersion(
  json: string | null | undefined,
  distro: string,
  kind: WslRuntimeKind,
  id: string | null | undefined,
): string {
  const next = parseWslRuntimeVersions(json);
  const dv = { ...(next[distro] ?? {}) };
  if (!id || id === 'system') delete dv[kind];
  else dv[kind] = id;
  if (Object.keys(dv).length > 0) next[distro] = dv;
  else delete next[distro];
  return JSON.stringify(next);
}
