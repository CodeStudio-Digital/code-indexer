/**
 * AppToolBinding — resolve a qual AppStudioSession uma chamada de tool
 * pertence, sem acoplar as tools ao runtime que as hospeda. App Studio v6
 * aceita somente o binding explícito da equipe Company persistente.
 */
import type { AppStudioSession, AppStudioStore } from '@mcp/store/app-studio-store.js';
import type { SessionId } from '@mcp/session-storage';

export interface AppToolBinding {
  /** Resolve the App Studio session for this tool call (null = none bound). */
  resolveAppSession(store: AppStudioStore): Promise<AppStudioSession | null>;
  /** Short label for error messages, e.g. `project_id=12`. */
  describeBinding(): string;
}

export function appStudioSessionBinding(appSessionId: SessionId): AppToolBinding {
  return {
    resolveAppSession: (store) => store.getSession(appSessionId),
    describeBinding: () => `app_session_id=${appSessionId}`,
  };
}
