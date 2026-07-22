/**
 * Public composition root for the `lsp` namespace.
 *
 * Stateful services and routing closures are created once per factory call in
 * handler-context; each feature module only contributes a disjoint LspApi slice.
 */
import type { LspApi } from '@mcp/api-bus';
import type { HandlerDeps } from '../types.js';
import { createDocumentSyncHandlers } from './document-sync-handlers.js';
import { createEditorOpsHandlers } from './editor-ops-handlers.js';
import { createLspHandlerContext } from './handler-context.js';
import { createInteractiveHandlers } from './interactive-handlers.js';
import { createLanguageFeatureHandlers } from './language-feature-handlers.js';
import { createServerAdminHandlers } from './server-admin-handlers.js';

export function createLspHandlers(deps: HandlerDeps): LspApi {
  const context = createLspHandlerContext(deps);
  return {
    ...createDocumentSyncHandlers(context),
    ...createInteractiveHandlers(context),
    ...createLanguageFeatureHandlers(context),
    ...createServerAdminHandlers(context),
    ...createEditorOpsHandlers(deps, context),
  } satisfies LspApi;
}
