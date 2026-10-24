import type { FsSessionStore } from '@mcp/session-storage/fs-store/index.js';

import { operations as operations1 } from './control-plane-file-commands.js';
import { ControlPlaneFileContext } from './control-plane-file-context.js';
import { operations as operations3 } from './control-plane-file-events.js';
import { operations as operations2 } from './control-plane-file-execution.js';
import { operations as operations4 } from './control-plane-file-recovery.js';
import { operations as operations0 } from './control-plane-file-repository.js';
export function createControlPlaneFileContext(sessions: FsSessionStore, options: {journalEnabled?: boolean} = {}): ControlPlaneFileContext {
return Object.assign(new ControlPlaneFileContext(sessions, options), operations0, operations1, operations2, operations3, operations4);
}
