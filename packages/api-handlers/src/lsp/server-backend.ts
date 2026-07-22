/**
 * Public facade for the LSP backend. Implementations live in focused modules
 * so editor operations, lifecycle wiring and wire-shape mapping evolve safely.
 */
export {
  acquireLspWithDeadline,
  INTERACTIVE_LSP_ACQUIRE_DEADLINE_MS,
  type LspServerTarget,
} from './server-backend-acquire.js';
export {
  serverCodeActions,
  serverExecuteCodeAction,
  serverResolveCodeAction,
} from './server-backend-actions.js';
export {
  filterServerCompletionItems,
  isServerCompletionRaw,
  mapServerCompletionItem,
  serverCompletion,
  serverResolveCompletion,
  type ServerCompletionRaw,
} from './server-backend-completion.js';
export { ensureLspManager } from './server-backend-manager.js';
export {
  mapServerCodeActions,
  mapServerWorkspaceEdit,
  toLocations,
} from './server-backend-mappers.js';
export {
  serverDefinition,
  serverHover,
  serverReferences,
} from './server-backend-navigation.js';
export { serverSemanticTokens } from './server-backend-semantic.js';
export { serverStatusFor } from './server-backend-status.js';
export { getDoc } from './document-store.js';
