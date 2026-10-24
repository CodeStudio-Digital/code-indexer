import { isAbsolute, relative, resolve } from 'node:path';
import type { CoderAttachment } from '@mcp/code-agent/index.js';
import {
  resolveSessionProjectAuthority,
  type FsCoderSession,
} from '@mcp/session-storage/fs-store/index.js';
import type { SessionId } from '@mcp/agent-runtime-contracts';
import { modelSupportsVision } from '@mcp/code-agent/providers/capabilities.js';
import {
  binaryDocumentsHandledNatively,
  normalizeAttachmentsForModel,
  pdfHandledNatively,
} from '@mcp/services/services/docs/attachment-extract.js';
import { validateAttachments } from '@mcp/services/services/docs/attachment-validation.js';
import { getDefinition } from '@mcp/services/providers/registry.js';
import type { ServerDeps } from '../../deps.js';

type PreparedAttachments =
  | { ok: true; value: CoderAttachment[] | undefined }
  | { ok: false; status: 400 | 413 | 415; code: string; error: string };

/**
 * Apply the same validation and provider-aware normalization used by the
 * ordinary /messages route to a queued /inject payload.
 */
export async function prepareQueuedAttachments(
  deps: Pick<ServerDeps, 'providerStore' | 'sessionStore'>,
  sessionId: SessionId,
  input: unknown,
  describeImages: boolean,
): Promise<PreparedAttachments> {
  const checked = validateAttachments(input, { allowFileReferences: true });
  if (!checked.ok) return checked;
  if (!checked.value?.length) return { ok: true, value: undefined };

  const session = await deps.sessionStore.getSession(sessionId);
  const providerKind = session?.provider
    ? deps.providerStore.getProvider(session.provider)?.kind
    : undefined;
  const modelRow = session?.provider && session.model
    ? deps.providerStore
        .listModels(session.provider)
        .find((model) => model.model_id === session.model)
    : undefined;
  const canSeeImages = session?.model
    ? modelSupportsVision({
        providerKind,
        modelId: session.model,
        inputModalities: modelRow?.input_modalities,
      })
    : undefined;
  const fileHandling = {
    mode: providerKind ? getDefinition(providerKind)?.capabilities?.fileInput : undefined,
    modelId: session?.model,
    supportsAttachments: modelRow?.supports_attachments,
  };

  const value = await normalizeAttachmentsForModel(checked.value, {
    extractImages: canSeeImages === true || describeImages,
    extractPdfText: !pdfHandledNatively(fileHandling),
    keepBinaryDocuments: binaryDocumentsHandledNatively(fileHandling),
  });
  return { ok: true, value };
}

function contains(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function projectAuthority(deps: Pick<ServerDeps, 'db'>, session: FsCoderSession) {
  return resolveSessionProjectAuthority(session, (projectId) => {
    const project = deps.db.getProject(projectId);
    return project && !project.is_synthetic
      ? {
          project_id: project.id,
          name: project.name,
          root_path: project.root_path,
        }
      : null;
  });
}

/**
 * Persist exact-file read grants before the worker accepts path-backed queued
 * attachments. The worker refreshes its live root array in pushUserMessage.
 */
export async function authorizeQueuedAttachmentReferences(
  deps: Pick<ServerDeps, 'db' | 'sessionStore'>,
  sessionId: SessionId,
  attachments: readonly CoderAttachment[] | undefined,
): Promise<string | null> {
  const paths = attachments
    ?.flatMap((attachment) => attachment.path ? [attachment.path] : [])
    ?? [];
  if (paths.length === 0) return null;

  const session = await deps.sessionStore.getSession(sessionId);
  if (!session) return 'session not found';
  const authority = projectAuthority(deps, session);
  const projectRoots = [
    ...(authority && session.project_id === authority.primary.project_id
      ? [session.worktree_path]
      : []),
    ...(authority?.projects.map((project) => project.root_path) ?? []),
  ].filter((root): root is string => typeof root === 'string' && root.length > 0);
  const existing = await deps.sessionStore.listSessionFilesystemRoots(sessionId);

  for (const path of new Set(paths)) {
    if (projectRoots.some((root) => contains(root, path))) continue;
    if (existing.some((root) => contains(root.root_path, path))) continue;
    if (existing.length >= 16) {
      return 'session filesystem reference limit reached (16); remove an old filesystem grant first';
    }
    const row = await deps.sessionStore.upsertSessionFilesystemRoot(sessionId, path, 'read');
    existing.push(row);
  }
  return null;
}
