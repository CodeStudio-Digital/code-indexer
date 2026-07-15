/**
 * Monaco SignatureHelpProvider (Ctrl+P / digitação de `(`/`,`) backed por
 * lsp.signatureHelp — TS service, server LSP ou fallback do índice, decidido
 * no backend. flushDoc antes (mesmo anti-race da completion).
 */
import type * as MonacoNs from 'monaco-editor';
import { apiCall } from '../../../../lib/api-client.js';
import { logLsp } from '../lsp-log.js';
import { modelBelongsToProject, relPath, type Monaco } from './dto.js';

interface SignatureHelpDTO {
  signatures: Array<{
    label: string;
    parameters: Array<{ label: string; documentation?: string }>;
    documentation?: string;
  }>;
  activeSignature: number;
  activeParameter: number;
}

export function registerSignatureHelpProviders(
  monaco: Monaco,
  projectId: number,
  ensureSynced: (model: MonacoNs.editor.ITextModel) => Promise<void>,
): MonacoNs.IDisposable[] {
  const provider: MonacoNs.languages.SignatureHelpProvider = {
    signatureHelpTriggerCharacters: ['(', ','],
    signatureHelpRetriggerCharacters: [')'],
    async provideSignatureHelp(model, position) {
      if (!modelBelongsToProject(model, projectId)) return null;
      const file = relPath(model);
      const lang = model.getLanguageId();
      const t0 = performance.now();
      try {
        await ensureSynced(model);
        const dto = await apiCall<SignatureHelpDTO | null>('lsp.signatureHelp', {
          projectId,
          file,
          position: { line: position.lineNumber, column: position.column },
        });
        if (!dto || dto.signatures.length === 0) {
          logLsp({ op: 'signatureHelp', file, lang, outcome: 'empty', ms: performance.now() - t0 });
          return null;
        }
        logLsp({ op: 'signatureHelp', file, lang, outcome: 'ok', count: dto.signatures.length, ms: performance.now() - t0 });
        return {
          value: {
            signatures: dto.signatures.map((s) => ({
              label: s.label,
              documentation: s.documentation,
              parameters: s.parameters.map((p) => ({ label: p.label, documentation: p.documentation })),
            })),
            activeSignature: Math.min(dto.activeSignature, dto.signatures.length - 1),
            activeParameter: dto.activeParameter,
          },
          dispose: () => { /* nothing retained */ },
        };
      } catch (err) {
        logLsp({
          op: 'signatureHelp', file, lang, outcome: 'threw',
          ms: performance.now() - t0, err: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    },
  };
  return [monaco.languages.registerSignatureHelpProvider('*', provider)];
}
