export interface CompletionCacheKeyInput {
  bindingRevision: string;
  projectId: number;
  file: string;
  language: string;
  cursorLine: number;
  documentVersion: number;
  contextRevision: number;
  contextEngine: string;
  windowHash: string;
}

export function completionResultCacheKey(input: CompletionCacheKeyInput): string {
  return [
    input.bindingRevision, input.projectId, input.file, input.language, input.cursorLine,
    input.documentVersion, input.contextRevision, input.contextEngine, input.windowHash,
  ].join(':');
}
