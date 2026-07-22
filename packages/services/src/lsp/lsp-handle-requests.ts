import type { LspRpcClient } from './lsp-client.js';
import {
  type LspRequestPriority,
  type LspRequestScheduler,
} from './lsp-request-scheduler.js';
import { pathToUri, toLsp } from './lsp-protocol.js';

type Position = { line: number; column: number };
type Range = { start: Position; end: Position };

const TIMEOUT = {
  completion: 5_000,
  hover: 5_000,
  definition: 10_000,
  typeDefinition: 10_000,
  foldingRanges: 10_000,
  inlayHints: 10_000,
  linkedEditingRanges: 5_000,
  references: 30_000,
  resolve: 5_000,
  codeAction: 10_000,
  semanticTokens: 10_000,
  rename: 30_000,
  signatureHelp: 5_000,
  documentSymbol: 10_000,
  formatting: 10_000,
  implementation: 10_000,
} as const;

/** Builds and schedules Monaco-facing document requests against one RPC client. */
export class LspHandleRequests {
  constructor(
    private rpc: Pick<LspRpcClient, 'request'>,
    private scheduler: Pick<LspRequestScheduler, 'schedule'>,
  ) {}

  request<T = unknown>(
    method: string,
    params: unknown,
    timeoutMs: number,
    priority: LspRequestPriority,
    key?: string,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.scheduler.schedule({
      priority,
      key,
      signal,
      run: (scheduledSignal) => this.rpc.request<T>(method, params, timeoutMs, scheduledSignal),
    });
  }

  completion(
    absPath: string,
    position: Position,
    context?: { triggerKind: number; triggerCharacter?: string },
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.request('textDocument/completion', {
      textDocument: { uri: pathToUri(absPath) },
      position: toLsp(position),
      ...(context ? {
        context: {
          triggerKind: context.triggerKind,
          triggerCharacter: context.triggerCharacter,
        },
      } : {}),
    }, TIMEOUT.completion, 'interactive', `completion:${absPath}`, signal);
  }

  resolveCompletion(item: unknown, signal?: AbortSignal): Promise<unknown> {
    return this.request('completionItem/resolve', item, TIMEOUT.resolve, 'interactive', undefined, signal);
  }

  hover(absPath: string, position: Position, signal?: AbortSignal): Promise<unknown> {
    return this.positionRequest('textDocument/hover', absPath, position, TIMEOUT.hover, 'background', `hover:${absPath}`, signal);
  }

  definition(absPath: string, position: Position, signal?: AbortSignal): Promise<unknown> {
    return this.positionRequest('textDocument/definition', absPath, position, TIMEOUT.definition, 'manual', undefined, signal);
  }

  typeDefinition(absPath: string, position: Position, signal?: AbortSignal): Promise<unknown> {
    return this.positionRequest('textDocument/typeDefinition', absPath, position, TIMEOUT.typeDefinition, 'manual', undefined, signal);
  }

  foldingRanges(absPath: string, signal?: AbortSignal): Promise<unknown> {
    return this.documentRequest('textDocument/foldingRange', absPath, TIMEOUT.foldingRanges, 'background', `folding:${absPath}`, signal);
  }

  inlayHints(absPath: string, range: Range, signal?: AbortSignal): Promise<unknown> {
    return this.request('textDocument/inlayHint', {
      textDocument: { uri: pathToUri(absPath) },
      range: { start: toLsp(range.start), end: toLsp(range.end) },
    }, TIMEOUT.inlayHints, 'background', `inlayHints:${absPath}`, signal);
  }

  linkedEditingRanges(absPath: string, position: Position, signal?: AbortSignal): Promise<unknown> {
    return this.positionRequest(
      'textDocument/linkedEditingRange',
      absPath,
      position,
      TIMEOUT.linkedEditingRanges,
      'interactive',
      `linkedEditing:${absPath}`,
      signal,
    );
  }

  references(absPath: string, position: Position, signal?: AbortSignal): Promise<unknown> {
    return this.request('textDocument/references', {
      textDocument: { uri: pathToUri(absPath) },
      position: toLsp(position),
      context: { includeDeclaration: true },
    }, TIMEOUT.references, 'manual', undefined, signal);
  }

  rename(absPath: string, position: Position, newName: string, signal?: AbortSignal): Promise<unknown> {
    return this.request('textDocument/rename', {
      textDocument: { uri: pathToUri(absPath) },
      position: toLsp(position),
      newName,
    }, TIMEOUT.rename, 'manual', undefined, signal);
  }

  signatureHelp(absPath: string, position: Position, signal?: AbortSignal): Promise<unknown> {
    return this.positionRequest(
      'textDocument/signatureHelp',
      absPath,
      position,
      TIMEOUT.signatureHelp,
      'interactive',
      `signature:${absPath}`,
      signal,
    );
  }

  documentSymbol(absPath: string, signal?: AbortSignal): Promise<unknown> {
    return this.documentRequest(
      'textDocument/documentSymbol',
      absPath,
      TIMEOUT.documentSymbol,
      'background',
      `symbols:${absPath}`,
      signal,
    );
  }

  codeActions(
    absPath: string,
    range: Range,
    only?: string[],
    options: { origin?: 'auto' | 'invoke'; signal?: AbortSignal } = {},
  ): Promise<unknown> {
    const automatic = options.origin === 'auto';
    return this.request('textDocument/codeAction', {
      textDocument: { uri: pathToUri(absPath) },
      range: { start: toLsp(range.start), end: toLsp(range.end) },
      context: { diagnostics: [], ...(only ? { only } : {}) },
    }, TIMEOUT.codeAction, automatic ? 'background' : 'manual', automatic ? `codeAction:${absPath}` : undefined, options.signal);
  }

  resolveCodeAction(action: unknown, signal?: AbortSignal): Promise<unknown> {
    return this.request('codeAction/resolve', action, TIMEOUT.codeAction, 'manual', undefined, signal);
  }

  executeCommand(command: string, args: unknown[] | undefined, signal?: AbortSignal): Promise<unknown> {
    return this.request(
      'workspace/executeCommand',
      { command, arguments: args ?? [] },
      TIMEOUT.codeAction,
      'manual',
      undefined,
      signal,
    );
  }

  implementation(absPath: string, position: Position, signal?: AbortSignal): Promise<unknown> {
    return this.positionRequest('textDocument/implementation', absPath, position, TIMEOUT.implementation, 'manual', undefined, signal);
  }

  formatting(
    absPath: string,
    options: { tabSize: number; insertSpaces: boolean },
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.request('textDocument/formatting', {
      textDocument: { uri: pathToUri(absPath) },
      options,
    }, TIMEOUT.formatting, 'manual', undefined, signal);
  }

  rangeFormatting(
    absPath: string,
    range: Range,
    options: { tabSize: number; insertSpaces: boolean },
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.request('textDocument/rangeFormatting', {
      textDocument: { uri: pathToUri(absPath) },
      range: { start: toLsp(range.start), end: toLsp(range.end) },
      options,
    }, TIMEOUT.formatting, 'manual', undefined, signal);
  }

  semanticTokens(absPath: string, signal?: AbortSignal): Promise<unknown> {
    return this.documentRequest(
      'textDocument/semanticTokens/full',
      absPath,
      TIMEOUT.semanticTokens,
      'background',
      `semanticTokens:${absPath}`,
      signal,
    );
  }

  private positionRequest(
    method: string,
    absPath: string,
    position: Position,
    timeoutMs: number,
    priority: LspRequestPriority,
    key?: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.request(method, {
      textDocument: { uri: pathToUri(absPath) },
      position: toLsp(position),
    }, timeoutMs, priority, key, signal);
  }

  private documentRequest(
    method: string,
    absPath: string,
    timeoutMs: number,
    priority: LspRequestPriority,
    key?: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.request(method, {
      textDocument: { uri: pathToUri(absPath) },
    }, timeoutMs, priority, key, signal);
  }
}
