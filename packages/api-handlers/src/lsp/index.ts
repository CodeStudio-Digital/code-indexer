/**
 * Handlers for the `lsp` namespace — Monaco editor completions, hover,
 * definitions, references, diagnostics. Delegates to the in-process
 * `getTsService(projectRoot)` from @mcp/code-agent. The worker-pool
 * variant (Dia 9 of the plan) wraps this same handler in an `lsp` worker.
 *
 * MVP: only .ts / .tsx / .js / .jsx are fully wired. Other languages
 * still get Monaco's built-in syntax highlight but return empty for
 * LSP calls (no error, just nothing helpful).
 */

import {
  ApiError,
  type LspApi,
  type LspLocation,
  type CompletionItem,
  type HoverInfo,
  type DiagnosticItem,
} from '@mcp/api-bus';
import { getTsService, isTsFile } from '@mcp/code-agent/lsp/ts-service.js';
import type { HandlerDeps } from '../types.js';

export function createLspHandlers(deps: HandlerDeps): LspApi {
  const { db } = deps;

  function requireProjectRoot(projectId: number): string {
    const project = db.getProject(projectId);
    if (!project) throw new ApiError('not_found', 404, 'project not found');
    return project.root_path;
  }

  function emptyIfUnsupported<T>(file: string, fallback: T): T | null {
    return isTsFile(file) ? null : fallback;
  }

  // When the renderer ships its current model text in `content`, push
  // it into the TS service BEFORE computing. Without this, all
  // position-based queries see the on-disk file and miss unsaved
  // keystrokes — the textbook symptom is autocomplete returning no
  // suggestions right after the user types `.`, because the dot
  // hasn't been written to disk yet.
  function syncContent(root: string, file: string, content?: string): void {
    if (content === undefined) return;
    try {
      getTsService(root).setFileSnapshot(file, content);
    } catch {
      /* setFileSnapshot is best-effort; if it fails we still try the call */
    }
  }

  return {
    async completion({ projectId, file, position, content }) {
      const empty = emptyIfUnsupported(file, [] as CompletionItem[]);
      if (empty) return empty;
      const root = requireProjectRoot(projectId);
      syncContent(root, file, content);
      const svc = getTsService(root);
      const entries = svc.getCompletions(file, position.line, position.column);
      return entries.map<CompletionItem>((e) => ({
        label: e.name,
        kind: e.kind,
        detail: e.detail,
        insertText: e.insertText,
      }));
    },

    async hover({ projectId, file, position, content }) {
      if (!isTsFile(file)) return null;
      const root = requireProjectRoot(projectId);
      syncContent(root, file, content);
      const info = getTsService(root).getHover(file, position.line, position.column);
      if (!info) return null;
      const lines: string[] = [];
      if (info.displayString) lines.push('```ts\n' + info.displayString + '\n```');
      if (info.documentation) lines.push(info.documentation);
      const hover: HoverInfo = { contents: lines.join('\n\n') };
      return hover;
    },

    async definition({ projectId, file, position, content }) {
      const empty = emptyIfUnsupported(file, [] as LspLocation[]);
      if (empty) return empty;
      const root = requireProjectRoot(projectId);
      syncContent(root, file, content);
      const { targets } = getTsService(root).getDefinition(file, position.line, position.column);
      return targets.map<LspLocation>((t) => ({
        file: t.file,
        range: { start: { line: t.line, column: t.column }, end: { line: t.line, column: t.column } },
      }));
    },

    async references({ projectId, file, position, content }) {
      const empty = emptyIfUnsupported(file, [] as LspLocation[]);
      if (empty) return empty;
      const root = requireProjectRoot(projectId);
      syncContent(root, file, content);
      const { references } = getTsService(root).getReferences(file, position.line, position.column);
      return references.map<LspLocation>((r) => ({
        file: r.file,
        range: { start: { line: r.line, column: r.column }, end: { line: r.line, column: r.column } },
      }));
    },

    async diagnostics({ projectId, file, content }) {
      if (!file) return [];
      if (!isTsFile(file)) return [];
      const root = requireProjectRoot(projectId);
      syncContent(root, file, content);
      const diags = getTsService(root).getDiagnostics(file);
      return diags.map<DiagnosticItem>((d) => ({
        file: d.file,
        range: {
          start: { line: d.line, column: d.column },
          end: { line: d.line, column: d.column },
        },
        severity: d.severity,
        message: d.message,
        source: 'ts',
        code: d.code,
      }));
    },

    async semanticTokens({ projectId, file, content }) {
      // TS-only — JS gets the same TS service so it still works, but
      // non-script files (md, css, etc.) skip entirely.
      if (!isTsFile(file)) return { data: [] };
      const root = requireProjectRoot(projectId);
      syncContent(root, file, content);
      const data = getTsService(root).getSemanticTokens(file);
      return { data };
    },

    async rename(_input) {
      // The TS service doesn't expose a rename surface yet — `getEditsForRefactor`
      // can do it but plumbing is non-trivial. Throw 501 until the IDE actually
      // wires a rename UI (post-MVP).
      throw new ApiError('not_implemented', 501, 'lsp.rename lands post-MVP');
    },

    async codeActions(_input) {
      throw new ApiError('not_implemented', 501, 'lsp.codeActions lands post-MVP');
    },
  } satisfies LspApi;
}
