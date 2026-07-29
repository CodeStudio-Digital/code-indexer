import { resolve } from 'node:path';
import type { Context, Hono } from 'hono';
import {
  buildDeterministicImportSummary,
  detectExternalSessionSource,
  discoverExternalSessions,
  ExternalSessionError,
  importSummaryInput,
  previewExternalSession,
  readExternalSession,
  type ExternalSessionReference,
  type ExternalSessionSource,
} from '@mcp/code-agent/sessions/import/index.js';
import type { ChatProvider } from '@mcp/code-agent/providers/adapter.js';
import { createCoderProvider } from '@mcp/services/providers/factory.js';
import type { ServerDeps } from '../../deps.js';
import { parseIntQuery, parseJsonBody } from '../_helpers.js';
import { compactionOptionsFromConfig, summarizeReliably } from './compaction-summary.js';

const SOURCES = new Set<ExternalSessionSource>(['claude-code', 'codex']);

interface PreviewBody {
  source?: ExternalSessionSource;
  source_path: string;
  external_id?: string;
  fingerprint?: string;
  project_id?: number;
}

interface ImportBody extends PreviewBody {
  project_id: number;
  provider: string;
  model: string;
  agent?: string | null;
  title?: string;
  allow_project_mismatch?: boolean;
}

function normalizedPath(value: string): string {
  return resolve(value).replaceAll('\\', '/').replace(/\/$/, '').toLowerCase();
}

function cwdMatches(source: string | null, project: string | null | undefined): boolean {
  return Boolean(source && project && normalizedPath(source) === normalizedPath(project));
}

function errorResponse(c: Context, error: unknown) {
  if (error instanceof ExternalSessionError) {
    const status = error.code === 'source_not_found' ? 404
      : error.code === 'source_too_large' ? 413
      : error.code === 'empty_transcript' ? 422
      : error.code === 'source_busy' || error.code === 'project_mismatch' || error.code === 'duplicate_import' ? 409
      : 400;
    return c.json({ error: error.code, message: error.message, details: error.details }, status);
  }
  console.error('[session-imports]', error);
  return c.json({ error: 'import_failed', message: error instanceof Error ? error.message : String(error) }, 500);
}

async function referenceFromBody(body: Partial<PreviewBody>): Promise<ExternalSessionReference> {
  const path = body.source_path?.trim();
  if (!path || !path.toLowerCase().endsWith('.jsonl')) {
    throw new ExternalSessionError('unsupported_format', 'A .jsonl source_path is required');
  }
  if (body.source && !SOURCES.has(body.source)) {
    throw new ExternalSessionError('unsupported_format', `Unsupported source: ${String(body.source)}`);
  }
  const source = body.source && SOURCES.has(body.source)
    ? body.source
    : await detectExternalSessionSource(path);
  return {
    source,
    source_path: path,
    external_id: body.external_id?.trim() ?? '',
    fingerprint: body.fingerprint?.trim() || undefined,
  };
}

async function summaryProviders(deps: ServerDeps, provider: string, model: string): Promise<{
  providers: ChatProvider[];
  options: ReturnType<typeof compactionOptionsFromConfig>;
  errors: string[];
}> {
  const providers: ChatProvider[] = [];
  const errors: string[] = [];
  let options: ReturnType<typeof compactionOptionsFromConfig> = {};
  try {
    const binding = await deps.pipelineProviderResolver.resolveOrNull('code-agent', 'compaction', {});
    if (binding) {
      options = compactionOptionsFromConfig(binding.config);
      providers.push(await createCoderProvider(binding.provider.id, binding.modelId));
    }
  } catch (error) {
    errors.push(`compaction binding: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const target = await createCoderProvider(provider, model);
    if (!providers.some((item) => item.name === target.name && item.model === target.model)) providers.push(target);
  } catch (error) {
    errors.push(`target provider: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { providers, options, errors };
}

export function mountCoderSessionImportRoutes(app: Hono, deps: ServerDeps): void {
  app.get('/api/coder/session-imports/discover', async (c) => {
    try {
      const sourceRaw = c.req.query('source');
      if (sourceRaw && !SOURCES.has(sourceRaw as ExternalSessionSource)) {
        throw new ExternalSessionError('unsupported_format', `Unsupported source: ${sourceRaw}`);
      }
      const projectId = parseIntQuery(c, 'project_id', 0);
      const project = projectId > 0 ? deps.db.getProject(projectId) : null;
      const search = (c.req.query('q') ?? '').trim().toLowerCase();
      const matchFilter = c.req.query('cwd_match');
      const limit = Math.max(1, Math.min(100, parseIntQuery(c, 'limit', 30)));
      const offsetMatch = /^offset:(\d+)$/.exec(c.req.query('cursor') ?? '');
      const offset = offsetMatch ? Number(offsetMatch[1]) : 0;
      let items = await discoverExternalSessions(sourceRaw as ExternalSessionSource | undefined);
      items = await Promise.all(items.map(async (candidate) => ({
        ...candidate,
        matches_project: project ? cwdMatches(candidate.cwd, project.root_path) : undefined,
        already_imported_session_id: project
          ? await deps.sessionStore.findImportedSession(
              project.id,
              candidate.source,
              candidate.external_id,
            )
          : null,
      })));
      if (search) items = items.filter((item) => `${item.title} ${item.cwd ?? ''} ${item.external_id}`.toLowerCase().includes(search));
      if (matchFilter === 'match') items = items.filter((item) => item.matches_project === true);
      if (matchFilter === 'mismatch') items = items.filter((item) => item.matches_project === false);
      const page = items.slice(offset, offset + limit);
      return c.json({ items: page, next_cursor: offset + limit < items.length ? `offset:${offset + limit}` : null });
    } catch (error) { return errorResponse(c, error); }
  });

  app.post('/api/coder/session-imports/preview', async (c) => {
    try {
      const body = await parseJsonBody<PreviewBody>(c);
      const reference = await referenceFromBody(body);
      const document = await readExternalSession(reference);
      const preview = previewExternalSession(document);
      const project = Number.isSafeInteger(body.project_id) ? deps.db.getProject(Number(body.project_id)) : null;
      return c.json({
        ...preview,
        matches_project: project ? cwdMatches(preview.cwd, project.root_path) : undefined,
      });
    } catch (error) { return errorResponse(c, error); }
  });

  app.post('/api/coder/session-imports/import', async (c) => {
    try {
      const body = await parseJsonBody<ImportBody>(c);
      if (!Number.isSafeInteger(body.project_id) || Number(body.project_id) <= 0) {
        throw new ExternalSessionError('project_mismatch', 'An existing project is required');
      }
      const project = deps.db.getProject(Number(body.project_id));
      if (!project) throw new ExternalSessionError('project_mismatch', 'Target project was not found');
      if (!body.provider?.trim() || !body.model?.trim()) {
        throw new ExternalSessionError('unsupported_format', 'provider and model are required');
      }
      const reference = await referenceFromBody(body);
      const document = await readExternalSession(reference);
      const mismatch = Boolean(document.candidate.cwd && !cwdMatches(document.candidate.cwd, project.root_path));
      if (mismatch && body.allow_project_mismatch !== true) {
        throw new ExternalSessionError('project_mismatch', 'Source cwd differs from the target project', {
          source_cwd: document.candidate.cwd,
          project_root: project.root_path,
        });
      }

      const bareModel = body.model.split('::')[0];
      const chain = await summaryProviders(deps, body.provider, bareModel);
      const summarized = chain.providers.length > 0
        ? await summarizeReliably(importSummaryInput(document), chain.providers, chain.options, chain.errors)
        : { summary: null, provider: null, model: null, providerChain: [], errors: chain.errors };
      const usedFallback = summarized.summary == null;
      const summary = summarized.summary ?? buildDeterministicImportSummary(document);
      const result = await deps.sessionStore.importExternalSession({
        project_id: project.id,
        provider: body.provider.trim(),
        model: bareModel.trim(),
        agent: body.agent?.trim() || null,
        title: body.title?.trim() || document.candidate.title,
        source: document.candidate.source,
        reference: { ...reference, external_id: document.candidate.external_id, fingerprint: document.fingerprint },
        allow_project_mismatch: body.allow_project_mismatch,
        document,
        summary,
        diagnostics: {
          used_fallback_summary: usedFallback,
          summary_provider: summarized.provider,
          summary_model: summarized.model,
          summary_provider_chain: summarized.providerChain,
          summary_errors: summarized.errors,
          project_mismatch_confirmed: mismatch,
        },
      });
      return c.json({ ...result, used_fallback_summary: usedFallback }, 201);
    } catch (error) { return errorResponse(c, error); }
  });
}
