/** Advanced document features currently bridged by the Monaco client. */
export const ADVANCED_TEXT_DOCUMENT_CAPABILITIES = {
  typeDefinition: { dynamicRegistration: false, linkSupport: true },
  foldingRange: {
    dynamicRegistration: false,
    lineFoldingOnly: true,
    foldingRangeKind: { valueSet: ['comment', 'imports', 'region'] },
  },
  inlayHint: { dynamicRegistration: false },
  linkedEditingRange: { dynamicRegistration: false },
} as const;

interface InitializationSpec {
  rootUri: string;
  workspaceFolders?: boolean;
  initializationOptions?: unknown;
}

/** Stable initialize payload shared by every spawned language server. */
export function createLspInitializeParams(spec: InitializationSpec): unknown {
  return {
    processId: process.pid,
    clientInfo: { name: 'codestudio', version: '0.1' },
    rootUri: spec.rootUri,
    workspaceFolders: spec.workspaceFolders === false
      ? null
      : [{ uri: spec.rootUri, name: 'workspace' }],
    initializationOptions: spec.initializationOptions,
    capabilities: {
      general: { positionEncodings: ['utf-16'] },
      workspace: {
        applyEdit: true,
        configuration: true,
        workspaceFolders: spec.workspaceFolders !== false,
        workspaceEdit: { documentChanges: true },
        didChangeConfiguration: { dynamicRegistration: false },
      },
      textDocument: {
        synchronization: { didSave: false, dynamicRegistration: false },
        publishDiagnostics: { relatedInformation: false },
        completion: {
          contextSupport: true,
          completionItem: {
            snippetSupport: true,
            insertReplaceSupport: true,
            labelDetailsSupport: true,
            documentationFormat: ['markdown', 'plaintext'],
            resolveSupport: {
              properties: ['documentation', 'detail', 'additionalTextEdits'],
            },
          },
          completionItemKind: {
            valueSet: [
              1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
              14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25,
            ],
          },
        },
        hover: { contentFormat: ['markdown', 'plaintext'] },
        codeAction: {
          dynamicRegistration: false,
          codeActionLiteralSupport: {
            codeActionKind: {
              valueSet: [
                'quickfix',
                'refactor',
                'refactor.extract',
                'refactor.inline',
                'refactor.rewrite',
                'source',
                'source.organizeImports',
                'source.fixAll',
              ],
            },
          },
          isPreferredSupport: true,
        },
        definition: {},
        references: {},
        implementation: {},
        ...ADVANCED_TEXT_DOCUMENT_CAPABILITIES,
        formatting: {},
        rangeFormatting: {},
        documentSymbol: { hierarchicalDocumentSymbolSupport: true },
        signatureHelp: {
          signatureInformation: {
            parameterInformation: { labelOffsetSupport: false },
          },
        },
        rename: { dynamicRegistration: false },
        semanticTokens: {
          dynamicRegistration: false,
          requests: { full: true, range: false },
          tokenTypes: [
            'namespace', 'type', 'class', 'enum', 'interface', 'struct',
            'typeParameter', 'parameter', 'variable', 'property', 'enumMember',
            'event', 'function', 'method', 'macro', 'keyword', 'modifier',
            'comment', 'string', 'number', 'regexp', 'operator', 'decorator',
          ],
          tokenModifiers: [
            'declaration', 'definition', 'readonly', 'static', 'deprecated',
            'abstract', 'async', 'modification', 'documentation', 'defaultLibrary',
          ],
          formats: ['relative'],
          overlappingTokenSupport: false,
          multilineTokenSupport: false,
        },
      },
    },
  };
}
