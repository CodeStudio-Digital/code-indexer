/**
 * Porta de entrada única para abrir uma surface pesada destacável. No Electron
 * abre uma janela própria (popout, redimensionável/maximizável) reusando
 * `openInNewWindow` → IPC `window:open` → createAppWindow. No navegador/dev (sem
 * `electronAPI`) cai no `fallback` do chamador (tipicamente a modal antiga).
 */
import { DETACHABLE_SURFACES, type SurfaceParams } from './registry.js';

export function openDetached(
  kind: string,
  params: SurfaceParams,
  fallback?: () => void,
): void {
  const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
  if (api?.openInNewWindow) {
    const qs = new URLSearchParams(params).toString();
    const title = DETACHABLE_SURFACES[kind]?.titleFor(params);
    void api.openInNewWindow(`/popout/${kind}?${qs}`, title);
    return;
  }
  fallback?.();
}
