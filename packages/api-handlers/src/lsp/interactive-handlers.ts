import {
  type CompletionItem,
  type HoverInfo,
  type LspApi,
  type LspLocation,
} from '@mcp/api-bus';
import { isTsFile } from '@mcp/code-agent/lsp/ts-service.js';
import { languageIdForPath } from '@mcp/shared/utils/language-id.js';
import { serverForLanguage, type LspServerDef } from '@mcp/services/lsp/server-registry.js';
import { getDoc } from './document-store.js';
import type { LspHandlerContext } from './handler-context.js';
import {
  isServerCompletionRaw,
  serverCompletion,
  serverDefinition,
  serverHover,
  serverReferences,
  serverResolveCompletion,
} from './server-backend.js';

type InteractiveHandlers = Pick<
  LspApi,
  'completion' | 'resolveCompletion' | 'hover' | 'definition' | 'references'
>;

function lspLog(message: string): void {
  if (process.env.MCP_LSP_DEBUG === '1') console.error(message);
}

function softDeadlineMs(): number {
  const value = Number(process.env.MCP_LSP_SOFT_DEADLINE_MS);
  return Number.isFinite(value) && value > 0 ? value : 1500;
}

function mergeCompletions(server: CompletionItem[], index: CompletionItem[]): CompletionItem[] {
  if (index.length === 0) return server;
  if (server.length === 0) return index;
  const seen = new Set(server.map((item) => `${item.label}\0${item.kind}`));
  const merged = [...server];
  for (const item of index) {
    const key = `${item.label}\0${item.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged.slice(0, 200);
}

async function withSoftDeadline<T>(pending: Promise<T>): Promise<{ value: T | null; timedOut: boolean }> {
  const timedOut = Symbol('lsp-soft-deadline');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const raced = await Promise.race([
    pending,
    new Promise<typeof timedOut>((resolve) => {
      timer = setTimeout(() => resolve(timedOut), softDeadlineMs());
      timer.unref?.();
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (raced === timedOut) {
    void pending.catch(() => undefined);
    return { value: null, timedOut: true };
  }
  return { value: raced, timedOut: false };
}

export function createInteractiveHandlers(context: LspHandlerContext): InteractiveHandlers {
  const { db, lspManager, requireProjectRoot, angularOverlayForPosition, exec, opCtx } = context;

  return {
    async completion({ projectId, file, position, content, context: completionContext }, ctx) {
      const root = requireProjectRoot(projectId);
      const languageId = getDoc(projectId, file)?.languageId ?? languageIdForPath(file);
      const angular = angularOverlayForPosition(projectId, root, file, languageId, position, content);

      if (!isTsFile(file)) {
        const serverState = lspManager.status(projectId, languageId).state;
        const startedAt = Date.now();
        const primary = serverForLanguage(languageId);
        const defs = [angular?.def, primary]
          .filter((def): def is LspServerDef => !!def)
          .filter((def, index, all) => all.findIndex((candidate) => candidate.id === def.id) === index);
        const serverResults = await Promise.all(defs.map((def) => withSoftDeadline(serverCompletion(
          db,
          projectId,
          root,
          file,
          languageId,
          position,
          completionContext,
          ctx.signal,
          def.id === angular?.def.id ? angular.target : def.id,
        ))));
        const serverLists = serverResults.map((result) => result.value);
        const serverTimedOut = serverResults.some((result) => result.timedOut);
        const serverItems = serverLists.reduce<CompletionItem[]>(
          (all, list) => mergeCompletions(all, list?.items ?? []),
          [],
        );
        const fallbackItems = await exec().fallbackCompletion(
          opCtx(projectId, root, file, position, undefined, languageId),
        );
        const merged = mergeCompletions(serverItems, fallbackItems);
        lspLog(
          `[lsp.completion] proj=${projectId} ${languageId} file=${file} `
          + `src=${serverItems.length ? 'server+index' : serverTimedOut ? 'soft-timeout→index' : 'index'} `
          + `serverState=${serverState} server=${serverItems.length} index=${fallbackItems.length} `
          + `warmMs=${Date.now() - startedAt}`,
        );
        return {
          items: merged.map((item) => ({
            ...item,
            origin: item.origin ?? (serverItems.includes(item) ? 'lsp' : 'index'),
          })),
          isIncomplete: serverTimedOut
            || serverLists.length === 0
            || serverLists.some((list) => !list || list.isIncomplete),
        };
      }

      const angularPending = angular
        ? withSoftDeadline(serverCompletion(
          db,
          projectId,
          root,
          file,
          languageId,
          position,
          completionContext,
          ctx.signal,
          angular.target,
        ))
        : Promise.resolve({ value: null, timedOut: false });
      const [entries, fallbackItems, angularResult] = await Promise.all([
        exec().tsCompletions(opCtx(projectId, root, file, position, content)),
        exec().fallbackCompletion(opCtx(projectId, root, file, position, undefined, languageId)),
        angularPending,
      ]);
      const tsItems = entries.map<CompletionItem>((entry) => ({
        label: entry.name,
        kind: entry.kind,
        detail: entry.detail,
        insertText: entry.insertText,
        sortText: entry.sortText,
        insertTextFormat: entry.isSnippet ? 2 : 1,
        raw: entry.hasAction
          ? { name: entry.name, source: entry.source, data: entry.data, position }
          : undefined,
        origin: 'ts',
      }));
      const angularItems = angularResult.value?.items ?? [];
      return {
        items: mergeCompletions(
          mergeCompletions(angularItems, tsItems),
          fallbackItems.map((item) => ({ ...item, origin: 'index' as const })),
        ),
        isIncomplete: angularResult.timedOut || angularResult.value?.isIncomplete === true,
      };
    },

    async resolveCompletion({ projectId, file, item }, ctx) {
      const root = requireProjectRoot(projectId);
      const languageId = getDoc(projectId, file)?.languageId ?? languageIdForPath(file);
      if (isServerCompletionRaw(item)) {
        return serverResolveCompletion(db, projectId, languageId, item, ctx.signal);
      }
      if (isTsFile(file)) {
        const raw = item as
          | { name?: string; source?: string; data?: unknown; position?: { line: number; column: number } }
          | null;
        if (!raw?.name || !raw.position) return null;
        const details = await exec().tsCompletionDetails({
          ...opCtx(projectId, root, file, raw.position),
          completionEntry: { name: raw.name, source: raw.source, data: raw.data },
        });
        if (!details) return null;
        return {
          label: raw.name,
          kind: 'text',
          additionalTextEdits: details.additionalTextEdits,
          detail: details.detail,
          documentation: details.documentation,
        };
      }
      return serverResolveCompletion(db, projectId, languageId, item, ctx.signal);
    },

    async hover({ projectId, file, position, content }, ctx) {
      const root = requireProjectRoot(projectId);
      const languageId = getDoc(projectId, file)?.languageId ?? languageIdForPath(file);
      const angular = angularOverlayForPosition(projectId, root, file, languageId, position, content);
      if (angular) {
        const viaAngular = await serverHover(
          db, projectId, root, file, languageId, position, ctx.signal, angular.target,
        );
        if (ctx.signal.aborted) return null;
        if (viaAngular != null) return viaAngular;
      }
      if (!isTsFile(file)) {
        const viaServer = await serverHover(db, projectId, root, file, languageId, position, ctx.signal);
        if (ctx.signal.aborted) return null;
        if (viaServer !== undefined) return viaServer;
        return exec().fallbackHover(opCtx(projectId, root, file, position, undefined, languageId));
      }
      const info = await exec().tsHover(opCtx(projectId, root, file, position, content));
      if (!info) return null;
      const lines: string[] = [];
      if (info.displayString) lines.push('```ts\n' + info.displayString + '\n```');
      if (info.documentation) lines.push(info.documentation);
      const hover: HoverInfo = { contents: lines.join('\n\n') };
      return hover;
    },

    async definition({ projectId, file, position, content }, ctx) {
      const root = requireProjectRoot(projectId);
      const languageId = getDoc(projectId, file)?.languageId ?? languageIdForPath(file);
      const angular = angularOverlayForPosition(projectId, root, file, languageId, position, content);
      if (angular) {
        const viaAngular = await serverDefinition(
          db, projectId, root, file, languageId, position, ctx.signal, angular.target,
        );
        if (ctx.signal.aborted) return [];
        if (viaAngular && viaAngular.length > 0) return viaAngular;
      }
      if (!isTsFile(file)) {
        const viaServer = await serverDefinition(db, projectId, root, file, languageId, position, ctx.signal);
        if (ctx.signal.aborted) return [];
        if (viaServer && viaServer.length > 0) return viaServer;
        return exec().fallbackDefinition(opCtx(projectId, root, file, position));
      }
      const { targets } = await exec().tsDefinition(opCtx(projectId, root, file, position, content));
      return targets.map<LspLocation>((target) => ({
        file: target.file,
        range: {
          start: { line: target.line, column: target.column },
          end: { line: target.line, column: target.column },
        },
      }));
    },

    async references({ projectId, file, position, content }, ctx) {
      const root = requireProjectRoot(projectId);
      const languageId = getDoc(projectId, file)?.languageId ?? languageIdForPath(file);
      const angular = angularOverlayForPosition(projectId, root, file, languageId, position, content);
      if (angular) {
        const viaAngular = await serverReferences(
          db, projectId, root, file, languageId, position, ctx.signal, angular.target,
        );
        if (ctx.signal.aborted) return [];
        if (viaAngular && viaAngular.length > 0) return viaAngular;
      }
      if (!isTsFile(file)) {
        const viaServer = await serverReferences(db, projectId, root, file, languageId, position, ctx.signal);
        if (ctx.signal.aborted) return [];
        if (viaServer && viaServer.length > 0) return viaServer;
        return exec().fallbackReferences(opCtx(projectId, root, file, position));
      }
      const result = await exec().tsReferences(opCtx(projectId, root, file, position, content));
      return result.references.map<LspLocation>((reference) => ({
        file: reference.file,
        range: {
          start: { line: reference.line, column: reference.column },
          end: { line: reference.line, column: reference.column },
        },
      }));
    },
  };
}
