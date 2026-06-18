/**
 * Namespacing de URI do modelo Monaco por projectId (W1b do overhaul do editor).
 *
 * Sem namespacing, dois projetos com o MESMO path relativo (ex.: `src/index.ts`)
 * colidem num único modelo Monaco (URI = `file:///src/index.ts`) — editar B mostra o
 * buffer de A. Prefixar a URI com `p<projectId>/` os separa.
 *
 * GARANTIA-CHAVE: o feed de path do LSP NÃO muda. `parseModelPath` extrai o relpath
 * LIMPO (`src/index.ts`) tanto com namespacing ON quanto OFF, então `relOf`/`relPath`
 * (que derivam o `file` enviado ao backend) continuam produzindo exatamente o mesmo
 * valor de antes. Isso é o que torna a mudança segura sem verificação no device.
 *
 * Rollback (renderer, runtime): `localStorage['mcp-ide:ns-model-uris'] = '0'` + reload
 * → URIs bare (comportamento antigo). Trocar a flag exige reload (modelos já criados
 * mantêm o esquema com que nasceram).
 */

const FLAG = 'mcp-ide:ns-model-uris';

/** Default ON. `'0'` no localStorage desliga (rollback). */
export function nsModelUrisEnabled(): boolean {
  try {
    return typeof localStorage === 'undefined' || localStorage.getItem(FLAG) !== '0';
  } catch {
    return true;
  }
}

/** project-relative path → chave do path do modelo (namespaced quando a flag está ON). */
export function modelPathFor(projectId: number, relPath: string): string {
  return nsModelUrisEnabled() ? `p${projectId}/${relPath}` : relPath;
}

/**
 * model.uri.path → { projectId, relPath }. `projectId` é null para modelos não
 * namespaced (modo OFF, modelos legados, ou schemes não-file como o merge `inmemory`).
 * `relPath` é SEMPRE o path relativo limpo que o backend espera.
 */
export function parseModelPath(uriPath: string): { projectId: number | null; relPath: string } {
  const stripped = uriPath.replace(/^\//, '');
  if (!nsModelUrisEnabled()) return { projectId: null, relPath: stripped };
  const m = /^p(\d+)\/(.*)$/.exec(stripped);
  if (m) return { projectId: Number(m[1]), relPath: m[2] };
  return { projectId: null, relPath: stripped };
}
