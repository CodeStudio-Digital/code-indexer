/**
 * AppToolBinding — resolve a qual AppStudioSession uma chamada de tool
 * pertence, sem acoplar as tools ao runtime que as hospeda. Host único:
 * sessão single de chat sobre um projeto-workspace `kind:'app'` (a sessão
 * App Studio é a vinculada ao projeto — UNIQUE project_id).
 */
import type { AppStudioSession, AppStudioStore } from '@mcp/store/app-studio-store.js';

export interface AppToolBinding {
  /** Resolve the App Studio session for this tool call (null = none bound). */
  resolveAppSession(store: AppStudioStore): AppStudioSession | null;
  /** Short label for error messages, e.g. `project_id=12`. */
  describeBinding(): string;
}

export function appStudioBinding(projectId: number): AppToolBinding {
  return {
    resolveAppSession: (store) => store.getSessionByProjectId(projectId),
    describeBinding: () => `project_id=${projectId}`,
  };
}
