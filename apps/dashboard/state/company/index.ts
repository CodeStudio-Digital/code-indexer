import type { CompanyStore } from './store-types.js';

/**
 * Composition root for the company store. Slices are kept in separate
 * files so each domain can evolve (and be tested) in isolation.
 *
 * Usage:
 *   const cards = useCompanyStore((s) => selectKanban(s, sessionId).cards);
 *
 * The legacy hooks (`useCompanyStream`, `useCompanySiblings`,
 * `useKanbanState`) keep their existing public API and read from the
 * same store, so components can migrate to direct selectors at their
 * own pace.
 */
import { create } from 'zustand';
import { createSessionSlice, type SessionSlice } from './sessionSlice.js';
import { createStreamSlice, type StreamSlice } from './streamSlice.js';
import { createKanbanSlice, type KanbanSlice } from './kanbanSlice.js';
import { createSandboxSlice, type SandboxSlice } from './sandboxSlice.js';
import { createDriveSlice, type DriveSlice } from './driveSlice.js';
import { createInboxSlice, type InboxSlice } from './inboxSlice.js';
import { createAutonomySlice, type AutonomySlice } from './autonomySlice.js';


export const useCompanyStore = create<CompanyStore>()((...a) => ({
  ...createSessionSlice(...a),
  ...createStreamSlice(...a),
  ...createKanbanSlice(...a),
  ...createSandboxSlice(...a),
  ...createDriveSlice(...a),
  ...createInboxSlice(...a),
  ...createAutonomySlice(...a),
}));

export * from './types.js';
export * from './selectors.js';






export type { AutonomyEvent, AutonomyEventType, AutonomyConfigLike } from './autonomySlice.js';
