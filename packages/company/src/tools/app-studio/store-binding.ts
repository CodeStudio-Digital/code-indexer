/**
 * Module-level binding do AppStudioStore usado pelas tools app_*.
 *
 * Fiado no boot em server.ts (main) e nos workers coder/company —
 * worker_threads não compartilham module state, então cada processo fia a
 * sua instância (o store é dual-mode e lê tudo do DB). Getter devolve
 * null p/ a tool renderizar erro claro em vez de crashar.
 */
import type { AppStudioStore } from '@mcp/store/app-studio-store.js';

let store: AppStudioStore | null = null;

export function setAppStudioStore(s: AppStudioStore | null): void {
  store = s;
}

export function getAppStudioStore(): AppStudioStore | null {
  return store;
}
