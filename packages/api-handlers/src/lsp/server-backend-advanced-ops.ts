import type {
  FoldingRangeDTO,
  InlayHintDTO,
  InlayHintLabelPartDTO,
  LinkedEditingRangesDTO,
  LspLocation,
} from '@mcp/api-bus';
import type { CodeIndexDB } from '@mcp/store/db.js';
import {
  fromLsp,
  type LspFoldingRange,
  type LspInlayHint,
  type LspInlayHintLabelPart,
  type LspLinkedEditingRanges,
} from '@mcp/services/lsp/lsp-protocol.js';
import {
  INTERACTIVE_LSP_ACQUIRE_DEADLINE_MS,
  type LspServerTarget,
} from './server-backend-acquire.js';
import { toLocations } from './server-backend-mappers.js';
import { acquireWithDoc, debugLspOperation } from './server-backend-op-context.js';
import { mapServerTextEdits } from './server-backend-format-ops.js';

export async function serverTypeDefinition(
  db: CodeIndexDB,
  projectId: number,
  root: string,
  file: string,
  languageId: string,
  position: { line: number; column: number },
  signal?: AbortSignal,
  serverTarget?: string | LspServerTarget,
): Promise<LspLocation[] | null> {
  const acquired = await acquireWithDoc(
    db,
    projectId,
    root,
    file,
    languageId,
    serverTarget,
    0,
    signal,
    'manual',
  );
  if (!acquired?.acq.handle.supportsTypeDefinition()) return null;
  try {
    return toLocations(
      await acquired.acq.handle.typeDefinition(acquired.abs, position, signal),
    );
  } catch (error) {
    debugLspOperation('serverTypeDefinition', projectId, languageId, error, acquired.acq);
    return null;
  }
}

export function mapServerFoldingRanges(raw: unknown): FoldingRangeDTO[] {
  const ranges = Array.isArray(raw) ? raw as LspFoldingRange[] : [];
  return ranges
    .filter((range) => Number.isInteger(range?.startLine)
      && Number.isInteger(range?.endLine)
      && range.endLine >= range.startLine)
    .map((range) => ({
      startLine: range.startLine + 1,
      endLine: range.endLine + 1,
      kind: typeof range.kind === 'string' ? range.kind : undefined,
    }));
}

export async function serverFoldingRanges(
  db: CodeIndexDB,
  projectId: number,
  root: string,
  file: string,
  languageId: string,
  signal?: AbortSignal,
  serverTarget?: string | LspServerTarget,
): Promise<FoldingRangeDTO[] | null> {
  const acquired = await acquireWithDoc(
    db,
    projectId,
    root,
    file,
    languageId,
    serverTarget,
    INTERACTIVE_LSP_ACQUIRE_DEADLINE_MS,
    signal,
    'background',
  );
  if (!acquired?.acq.handle.supportsFoldingRanges()) return null;
  try {
    return mapServerFoldingRanges(
      await acquired.acq.handle.foldingRanges(acquired.abs, signal),
    );
  } catch (error) {
    debugLspOperation('serverFoldingRanges', projectId, languageId, error, acquired.acq);
    return null;
  }
}

const tooltipText = (tooltip: string | { value: string } | undefined): string | undefined =>
  typeof tooltip === 'string' ? tooltip : tooltip?.value;

function mapInlayLabelPart(part: LspInlayHintLabelPart): InlayHintLabelPartDTO | null {
  if (!part || typeof part.value !== 'string') return null;
  const location = part.location ? toLocations([part.location])[0] : undefined;
  const command = part.command
    && typeof part.command.title === 'string'
    && typeof part.command.command === 'string'
    ? {
        title: part.command.title,
        command: part.command.command,
        arguments: part.command.arguments,
      }
    : undefined;
  return {
    label: part.value,
    tooltip: tooltipText(part.tooltip),
    location,
    command,
  };
}

export function mapServerInlayHints(raw: unknown): InlayHintDTO[] {
  const hints = Array.isArray(raw) ? raw as LspInlayHint[] : [];
  const mapped: InlayHintDTO[] = [];
  for (const hint of hints) {
    if (!hint?.position
      || !Number.isInteger(hint.position.line)
      || !Number.isInteger(hint.position.character)) continue;
    const label = typeof hint.label === 'string'
      ? hint.label
      : Array.isArray(hint.label)
        ? hint.label
            .map(mapInlayLabelPart)
            .filter((part): part is InlayHintLabelPartDTO => !!part)
        : [];
    if ((typeof label === 'string' && !label) || (Array.isArray(label) && label.length === 0)) {
      continue;
    }
    mapped.push({
      position: fromLsp(hint.position),
      label,
      kind: hint.kind === 1 || hint.kind === 2 ? hint.kind : undefined,
      tooltip: tooltipText(hint.tooltip),
      textEdits: hint.textEdits?.length ? mapServerTextEdits(hint.textEdits) : undefined,
      paddingLeft: hint.paddingLeft,
      paddingRight: hint.paddingRight,
    });
  }
  return mapped;
}

export async function serverInlayHints(
  db: CodeIndexDB,
  projectId: number,
  root: string,
  file: string,
  languageId: string,
  range: { start: { line: number; column: number }; end: { line: number; column: number } },
  signal?: AbortSignal,
  serverTarget?: string | LspServerTarget,
): Promise<InlayHintDTO[] | null> {
  const acquired = await acquireWithDoc(
    db,
    projectId,
    root,
    file,
    languageId,
    serverTarget,
    INTERACTIVE_LSP_ACQUIRE_DEADLINE_MS,
    signal,
    'background',
  );
  if (!acquired?.acq.handle.supportsInlayHints()) return null;
  try {
    return mapServerInlayHints(
      await acquired.acq.handle.inlayHints(acquired.abs, range, signal),
    );
  } catch (error) {
    debugLspOperation('serverInlayHints', projectId, languageId, error, acquired.acq);
    return null;
  }
}

export function mapServerLinkedEditingRanges(raw: unknown): LinkedEditingRangesDTO | null {
  const value = raw as LspLinkedEditingRanges | null;
  if (!value?.ranges?.length) return null;
  const ranges = value.ranges
    .filter((range) => !!range?.start && !!range?.end)
    .map((range) => ({ start: fromLsp(range.start), end: fromLsp(range.end) }));
  if (ranges.length === 0) return null;
  return {
    ranges,
    wordPattern: typeof value.wordPattern === 'string' ? value.wordPattern : undefined,
  };
}

export async function serverLinkedEditingRanges(
  db: CodeIndexDB,
  projectId: number,
  root: string,
  file: string,
  languageId: string,
  position: { line: number; column: number },
  signal?: AbortSignal,
  serverTarget?: string | LspServerTarget,
): Promise<LinkedEditingRangesDTO | null> {
  const acquired = await acquireWithDoc(
    db,
    projectId,
    root,
    file,
    languageId,
    serverTarget,
    INTERACTIVE_LSP_ACQUIRE_DEADLINE_MS,
    signal,
    'interactive',
  );
  if (!acquired?.acq.handle.supportsLinkedEditingRanges()) return null;
  try {
    return mapServerLinkedEditingRanges(
      await acquired.acq.handle.linkedEditingRanges(acquired.abs, position, signal),
    );
  } catch (error) {
    debugLspOperation(
      'serverLinkedEditingRanges',
      projectId,
      languageId,
      error,
      acquired.acq,
    );
    return null;
  }
}
