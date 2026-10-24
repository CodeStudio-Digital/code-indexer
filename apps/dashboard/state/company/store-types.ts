import type { SessionSlice } from './sessionSlice.js';
import type { StreamSlice } from './streamSlice.js';
import type { KanbanSlice } from './kanbanSlice.js';
import type { SandboxSlice } from './sandboxSlice.js';
import type { DriveSlice } from './driveSlice.js';
import type { InboxSlice } from './inboxSlice.js';
import type { AutonomySlice } from './autonomySlice.js';
export type CompanyStore = SessionSlice &
  StreamSlice &
  KanbanSlice &
  SandboxSlice &
  DriveSlice &
  InboxSlice &
  AutonomySlice;
