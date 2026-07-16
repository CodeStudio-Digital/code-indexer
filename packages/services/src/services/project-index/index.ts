export { ProjectIndexService, type EnsureFreshReason, type SemanticCatchupHooks } from './service.js';
export { createInProcessStructuralExecutor } from './in-process-executor.js';
export {
  readProjectIndexSettings,
  type DirtyEvent,
  type DirtyKind,
  type FsEvent,
  type IndexFilesSummary,
  type ProjectIndexPhase,
  type ProjectIndexSettings,
  type ProjectIndexStatus,
  type ScheduledIndexRun,
  type StructuralExecutor,
  type StructuralProgressFrame,
  type StructuralRunSummary,
} from './types.js';
