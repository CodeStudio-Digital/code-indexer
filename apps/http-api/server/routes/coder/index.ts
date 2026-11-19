import { mountChatCollaborationRoutes } from './chat-collaboration.js';
import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { createCoderRuntime } from './state.js';
import { mountConversationFormatGuard } from './conversation-format-guard.js';
import { mountCoderProvidersRoutes } from './providers.js';
import { mountCoderSessionsRoutes } from './sessions.js';
import { mountCoderSessionFilesRoutes } from './session-files.js';
import { mountCoderLinkedFileRoute } from './linked-file.js';
import { mountCoderWorktreeRoutes } from './worktrees.js';
import { mountCoderGroupsRoutes } from './groups.js';
import { mountCoderInteractionRoutes } from './interaction.js';
import { mountCoderSpecResponseRoute } from './spec-response.js';
import { mountCoderStreamRoutes } from './stream.js';
import { mountCoderSkillsRoutes } from './skills.js';
import { mountCoderProjectTreeRoutes } from './project-tree.routes.js';
import { mountCoderSnapshotRoutes } from './snapshot.js';
import { mountCoderDriveRoutes } from './drive.js';
import { mountCoderSummarizeClearRoute } from './summarize-clear.js';
import { mountCoderRollbackRoute } from './rollback.js';
import { mountCoderTranscribeRoutes } from './transcribe.js';
import { mountCoderChapterRoutes } from './chapters.js';
import { mountCoderSessionImportRoutes } from './session-imports.js';
import { mountCoderFilesystemRootRoutes } from './filesystem-roots.js';
import { mountSessionWorkbenchRoutes } from './session-workbench/routes.js';
import { rebuildConversationChapters } from './chapter-rebuild.js';
import { withSessionLock } from './sessionLock.js';
import { mountApiClientRoutes } from '../api-client/index.js';
import { mountSshRoutes } from '../ssh/index.js';
import { mountDbClientRoutes } from '../db-client/index.js';
import { mountCompanyRoutes } from '../company/index.js';

export function mountCoderRoutes(app: Hono, deps: ServerDeps): void {
  mountConversationFormatGuard(app, deps);
  const runtime = createCoderRuntime(deps.sessionStore);
  mountChatCollaborationRoutes(app, deps, runtime);
  mountCoderProvidersRoutes(app, deps);
  mountSessionWorkbenchRoutes(app, deps);
  mountCoderSessionsRoutes(app, deps, runtime);
  mountCoderSessionFilesRoutes(app, deps);
  mountCoderLinkedFileRoute(app, deps);
  mountCoderWorktreeRoutes(app, deps);
  mountCoderGroupsRoutes(app, deps);
  mountCoderInteractionRoutes(app, deps, runtime);
  mountCoderSpecResponseRoute(app, deps, runtime);
  mountCoderStreamRoutes(app, deps, runtime);
  mountCoderSkillsRoutes(app, deps, runtime);
  mountCoderProjectTreeRoutes(app, deps);
  mountCoderSnapshotRoutes(app, deps);
  mountCoderDriveRoutes(app, deps);
  mountCoderSummarizeClearRoute(app, deps, runtime);
  mountCoderRollbackRoute(app, deps, runtime);
  mountCoderTranscribeRoutes(app, deps);
  mountCoderChapterRoutes(app, deps, {
    rebuild: (sessionId, input) => withSessionLock(sessionId, async () => {
      const active = runtime.activeRuns.get(sessionId);
      if (active && !active.ended) throw new Error('a run is active — stop it before rebuilding chapters');
      return rebuildConversationChapters(deps, sessionId, input);
    }),
  });
  mountCoderSessionImportRoutes(app, deps);
  mountCoderFilesystemRootRoutes(app, deps);
  mountApiClientRoutes(app, deps);
  mountSshRoutes(app, deps);
  mountDbClientRoutes(app, deps);
  mountCompanyRoutes(app, deps);
}
