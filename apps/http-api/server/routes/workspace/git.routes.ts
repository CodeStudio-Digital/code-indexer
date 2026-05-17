import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { guardWorkspaceRequest } from './guards.js';
import { gitStatus, gitDiff, gitLog, gitInit, gitAdd, gitReset, gitCommit, gitDiscard } from './git-service.js';
import { parseIntQuery, parseJsonBody } from '../_helpers.js';
import { runGeneralAi, GeneralAiNotConfiguredError } from '@mcp/services/ai-general/generalClient.js';
import { extractFirstJson } from '@mcp/services/ai-general/extract-json.js';

const MAX_AI_DIFF_CHARS = 40_000;

function truncateForAi(text: string, limit = MAX_AI_DIFF_CHARS): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + `\n\n[... truncated, ${text.length - limit} more chars]`;
}

export function mountGitRoutes(app: Hono, deps: ServerDeps): void {
  app.get('/api/company/sessions/:sid/projects/:pid/git/status', async (c) => {
    const guard = guardWorkspaceRequest(c, deps, '.');
    if (guard instanceof Response) return guard;
    return c.json(await gitStatus(guard.resolved.root));
  });

  app.get('/api/company/sessions/:sid/projects/:pid/git/diff', async (c) => {
    const relPath = c.req.query('path') ?? '';
    // `path` is optional for git diff (whole-repo diff). When present,
    // validate through the same guard that every other workspace route
    // uses so we can't be tricked into `git diff -- ../outside`.
    const guard = guardWorkspaceRequest(c, deps, relPath || '.');
    if (guard instanceof Response) return guard;
    const staged = c.req.query('staged') === 'true';
    const result = await gitDiff(guard.resolved.root, {
      path: relPath || undefined,
      staged,
    });
    return c.json(result);
  });

  app.get('/api/company/sessions/:sid/projects/:pid/git/log', async (c) => {
    const guard = guardWorkspaceRequest(c, deps, '.');
    if (guard instanceof Response) return guard;
    const limit = parseIntQuery(c, 'limit', 30);
    return c.json({ entries: await gitLog(guard.resolved.root, limit) });
  });

  app.post('/api/company/sessions/:sid/projects/:pid/git/init', async (c) => {
    const guard = guardWorkspaceRequest(c, deps, '.');
    if (guard instanceof Response) return guard;
    const result = await gitInit(guard.resolved.root);
    if (!result.ok) return c.json({ error: result.message }, 500);
    return c.json({ ok: true, status: await gitStatus(guard.resolved.root) });
  });

  app.post('/api/company/sessions/:sid/projects/:pid/git/add', async (c) => {
    const rootGuard = guardWorkspaceRequest(c, deps, '.');
    if (rootGuard instanceof Response) return rootGuard;
    const body = await parseJsonBody<{ paths: string[] }>(c);
    const paths = Array.isArray(body.paths) ? body.paths : [];
    for (const p of paths) {
      const g = guardWorkspaceRequest(c, deps, p);
      if (g instanceof Response) return g;
    }
    const result = await gitAdd(rootGuard.resolved.root, paths);
    if (!result.ok) return c.json({ error: result.message }, 500);
    return c.json({ ok: true, status: await gitStatus(rootGuard.resolved.root) });
  });

  app.post('/api/company/sessions/:sid/projects/:pid/git/reset', async (c) => {
    const rootGuard = guardWorkspaceRequest(c, deps, '.');
    if (rootGuard instanceof Response) return rootGuard;
    const body = await parseJsonBody<{ paths: string[] }>(c);
    const paths = Array.isArray(body.paths) ? body.paths : [];
    for (const p of paths) {
      const g = guardWorkspaceRequest(c, deps, p);
      if (g instanceof Response) return g;
    }
    const result = await gitReset(rootGuard.resolved.root, paths);
    if (!result.ok) return c.json({ error: result.message }, 500);
    return c.json({ ok: true, status: await gitStatus(rootGuard.resolved.root) });
  });

  app.post('/api/company/sessions/:sid/projects/:pid/git/discard', async (c) => {
    const rootGuard = guardWorkspaceRequest(c, deps, '.');
    if (rootGuard instanceof Response) return rootGuard;
    const body = await parseJsonBody<{ paths: string[] }>(c);
    const paths = Array.isArray(body.paths) ? body.paths : [];
    for (const p of paths) {
      const g = guardWorkspaceRequest(c, deps, p);
      if (g instanceof Response) return g;
    }
    const status = await gitStatus(rootGuard.resolved.root);
    const result = await gitDiscard(rootGuard.resolved.root, paths, status);
    if (!result.ok) return c.json({ error: result.message }, 500);
    return c.json({ ok: true, status: await gitStatus(rootGuard.resolved.root) });
  });

  app.post('/api/company/sessions/:sid/projects/:pid/git/commit', async (c) => {
    const guard = guardWorkspaceRequest(c, deps, '.');
    if (guard instanceof Response) return guard;
    const body = await parseJsonBody<{ message: string }>(c);
    const message = typeof body.message === 'string' ? body.message : '';
    const result = await gitCommit(guard.resolved.root, message);
    if (!result.ok) return c.json({ error: result.message }, 400);
    return c.json({
      ok: true,
      hash: result.hash,
      status: await gitStatus(guard.resolved.root),
    });
  });

  app.post('/api/company/sessions/:sid/projects/:pid/git/suggest-commit-message', async (c) => {
    const guard = guardWorkspaceRequest(c, deps, '.');
    if (guard instanceof Response) return guard;
    const { diff } = await gitDiff(guard.resolved.root, { staged: true });
    if (!diff.trim()) {
      return c.json({ error: 'No staged changes to summarize' }, 400);
    }
    const prompt =
      'Write a Conventional-Commits-style commit message for the diff below.\n' +
      'Rules:\n' +
      '- First line: type(scope): short summary, <=72 chars, imperative mood.\n' +
      '- Optional body: wrap at ~100 chars, explain WHY not WHAT.\n' +
      '- No trailing punctuation on the subject line.\n' +
      '- Respond with ONLY the message text, no fences, no quotes.\n\n' +
      '--- STAGED DIFF ---\n' +
      truncateForAi(diff);
    try {
      const message = await runGeneralAi(prompt);
      return c.json({ message: message.replace(/^["']|["']$/g, '').trim() });
    } catch (err) {
      if (err instanceof GeneralAiNotConfiguredError) {
        return c.json({ error: err.message, code: 'general_ai_not_configured' }, 412);
      }
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, 500);
    }
  });

  app.post('/api/company/sessions/:sid/projects/:pid/git/suggest-staging', async (c) => {
    const guard = guardWorkspaceRequest(c, deps, '.');
    if (guard instanceof Response) return guard;
    const status = await gitStatus(guard.resolved.root);
    const changed = status.files.filter((f) => f.index !== '!' && f.worktree !== '!');
    if (changed.length === 0) {
      return c.json({ groups: [] });
    }
    const { diff } = await gitDiff(guard.resolved.root, {});
    const fileList = changed.map((f) => `- ${f.path} (index=${f.index}, worktree=${f.worktree})`).join('\n');
    const prompt =
      'Group the files below into logical commit units. Each group should be ' +
      'an atomic, reviewable change with a clear intent.\n\n' +
      'Respond with ONLY a JSON array, no prose, no fences. Shape:\n' +
      '[{"title":"short imperative","paths":["path/a","path/b"],"rationale":"one sentence"}]\n' +
      'Every path in the output MUST come from the list. Do not invent paths.\n\n' +
      '--- FILES ---\n' + fileList +
      '\n\n--- DIFF ---\n' + truncateForAi(diff);
    try {
      const raw = await runGeneralAi(prompt);
      const parsed = extractFirstJson(raw);
      if (!Array.isArray(parsed)) {
        return c.json({ error: 'AI response was not a JSON array', raw }, 500);
      }
      const validPaths = new Set(changed.map((f) => f.path));
      const groups = parsed
        .map((g) => g as Record<string, unknown>)
        .map((g) => ({
          title: typeof g.title === 'string' ? g.title : '',
          rationale: typeof g.rationale === 'string' ? g.rationale : '',
          paths: Array.isArray(g.paths)
            ? g.paths.filter((p): p is string => typeof p === 'string' && validPaths.has(p))
            : [],
        }))
        .filter((g) => g.title && g.paths.length > 0);
      return c.json({ groups });
    } catch (err) {
      if (err instanceof GeneralAiNotConfiguredError) {
        return c.json({ error: err.message, code: 'general_ai_not_configured' }, 412);
      }
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, 500);
    }
  });
}
