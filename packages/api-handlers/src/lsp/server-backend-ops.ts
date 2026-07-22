/** Public facade for editor-grade LSP document operations. */
export {
  mapServerFoldingRanges,
  mapServerInlayHints,
  mapServerLinkedEditingRanges,
  serverFoldingRanges,
  serverInlayHints,
  serverLinkedEditingRanges,
  serverTypeDefinition,
} from './server-backend-advanced-ops.js';
export {
  mapServerTextEdits,
  pickOrganizeImportsEdits,
  serverFormatting,
  serverImplementation,
  serverOrganizeImports,
  type FlatEdit,
} from './server-backend-format-ops.js';
export {
  mapServerDocumentSymbols,
  mapServerSignatureHelp,
  serverDocumentSymbols,
  serverRename,
  serverSignatureHelp,
} from './server-backend-symbol-ops.js';
