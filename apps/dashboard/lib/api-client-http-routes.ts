import { type DotPath } from './api-client-transport.js';

/**
 * Map a dotted method path to a Hono REST endpoint (best-effort, used
 * only in the browser fallback). Coverage is the IDE-hot subset; less
 * common methods fall through to a thrown error so we don't silently
 * shadow a missing implementation.
 */
export function dottedToHttp(path: DotPath, input: unknown): { url: string; init: RequestInit } | null {
  const json = (b: unknown): RequestInit => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(b),
  });
  const ip = input as Record<string, unknown> | undefined;
  if (path.startsWith('projectGit.') && ip?.projectId) {
    const method = path.slice('projectGit.'.length);
    return {
      url: `/api/projects/${ip.projectId}/git/rpc/${encodeURIComponent(method)}`,
      init: json(ip),
    };
  }
  switch (path) {
    case 'projects.list':
      return { url: '/api/projects', init: {} };
    case 'projects.get':
      return { url: `/api/projects/${ip!.id}`, init: {} };
    case 'projects.activate':
      return { url: `/api/projects/${ip!.id}/activation`, init: json({ activationId: ip!.activationId, clientId: ip!.clientId }) };
    case 'projects.deactivate':
      return {
        url: `/api/projects/${ip!.id}/activation`,
        init: { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ activationId: ip!.activationId, clientId: ip!.clientId }) },
      };
    case 'projects.stats':
      return { url: `/api/projects/${ip!.id}/stats`, init: {} };
    case 'files.list':
      return { url: `/api/projects/${ip!.projectId}/files`, init: {} };
    case 'files.searchPaths':
      return { url: `/api/projects/${ip!.projectId}/file-paths?query=${encodeURIComponent(String(ip!.query ?? ''))}&limit=${Number(ip!.limit ?? 50)}&fuzzy=${ip!.fuzzy !== false}`, init: {} };
    case 'files.tree': {
      const depth = ip!.maxDepth != null ? `&maxDepth=${Number(ip!.maxDepth)}` : '';
      const stats = (ip as { withStats?: boolean }).withStats ? '&withStats=1' : '';
      return { url: `/api/projects/${ip!.projectId}/file-tree?root=${encodeURIComponent(String(ip!.root ?? '.'))}${depth}${stats}`, init: {} };
    }
    case 'files.read': {
      const ims = ip!.ifModifiedSince ? `&ifModifiedSince=${encodeURIComponent(String(ip!.ifModifiedSince))}` : '';
      return { url: `/api/projects/${ip!.projectId}/file?path=${encodeURIComponent(String(ip!.path))}${ims}`, init: {} };
    }
    case 'files.write':
      return { url: `/api/projects/${ip!.projectId}/file`, init: { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: ip!.path, content: ip!.content, encoding: (ip as { encoding?: string }).encoding }) } };
    case 'files.delete':
      return {
        url: `/api/projects/${ip!.projectId}/file?path=${encodeURIComponent(String(ip!.path))}${ip!.recursive ? '&recursive=1' : ''}`,
        init: { method: 'DELETE' },
      };
    case 'files.rename':
      return {
        url: `/api/projects/${ip!.projectId}/file/rename`,
        init: json({ from: ip!.from, to: ip!.to }),
      };
    case 'files.mkdir':
      return {
        url: `/api/projects/${ip!.projectId}/dir`,
        init: json({ path: ip!.path }),
      };
    case 'files.historyList':
      return { url: `/api/projects/${ip!.projectId}/file/history?path=${encodeURIComponent(String(ip!.path))}`, init: {} };
    case 'files.historyGet':
      return { url: `/api/projects/${ip!.projectId}/file/history/${Number(ip!.id)}`, init: {} };
    case 'files.historyRestore':
      return { url: `/api/projects/${ip!.projectId}/file/history/${Number(ip!.id)}/restore`, init: { method: 'POST' } };
    case 'files.historyLabel':
      return { url: `/api/projects/${ip!.projectId}/file/history/${Number(ip!.id)}/label`, init: json({ label: ip!.label }) };
    case 'snapshots.list':
      return {
        url: `/api/projects/${ip!.projectId}/snapshots${ip!.category ? `?category=${encodeURIComponent(String(ip!.category))}` : ''}`,
        init: {},
      };
    case 'snapshots.create':
      return {
        url: `/api/projects/${ip!.projectId}/snapshots`,
        init: json({
          title: ip!.title,
          category: ip!.category,
          content: ip!.content,
          tags: ip!.tags,
        }),
      };
    case 'snapshots.update':
      return {
        url: `/api/snapshots/${ip!.id}`,
        init: {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: ip!.title,
            category: ip!.category,
            content: ip!.content,
            tags: ip!.tags,
          }),
        },
      };
    case 'snapshots.delete':
      return {
        url: `/api/snapshots/${ip!.id}`,
        init: { method: 'DELETE' },
      };
    case 'projectGit.status':
      return {
        url: `/api/projects/${ip!.projectId}/git/status${ip!.includeFiles === false ? '?includeFiles=0' : ''}`,
        init: {},
      };
    case 'projectGit.diff':
      return {
        url: `/api/projects/${ip!.projectId}/git/diff`,
        init: json({ path: ip!.path, staged: ip!.staged }),
      };
    case 'projectGit.log':
      return {
        url: `/api/projects/${ip!.projectId}/git/log?limit=${ip!.limit ?? 30}${ip!.skip ? `&skip=${ip!.skip}` : ''}${ip!.path ? `&path=${encodeURIComponent(String(ip!.path))}` : ''}${ip!.branch ? `&branch=${encodeURIComponent(String(ip!.branch))}` : ''}${ip!.all ? '&all=true' : ''}`,
        init: {},
      };
    case 'projectGit.stage':
      return {
        url: `/api/projects/${ip!.projectId}/git/stage`,
        init: json({ paths: ip!.paths }),
      };
    case 'projectGit.unstage':
      return {
        url: `/api/projects/${ip!.projectId}/git/unstage`,
        init: json({ paths: ip!.paths }),
      };
    case 'projectGit.discard':
      return {
        url: `/api/projects/${ip!.projectId}/git/discard`,
        init: json({ paths: ip!.paths }),
      };
    case 'projectGit.commit':
      return {
        url: `/api/projects/${ip!.projectId}/git/commit`,
        init: json({ message: ip!.message, amend: ip!.amend }),
      };
    case 'lsp.completion':
    case 'lsp.hover':
    case 'lsp.definition':
    case 'lsp.references':
    case 'lsp.implementation':
    case 'lsp.diagnostics': {
      const op = path.split('.')[1];
      return {
        url: `/api/lsp/${ip!.projectId}/${op}`,
        init: json({ file: ip!.file, position: ip!.position, content: ip!.content, context: ip!.context }),
      };
    }
    case 'lsp.formatting':
      return {
        url: `/api/lsp/${ip!.projectId}/formatting`,
        init: json({ file: ip!.file, range: ip!.range, options: ip!.options }),
      };
    case 'lsp.typeDefinition':
      return {
        url: `/api/lsp/${ip!.projectId}/type-definition`,
        init: json({ file: ip!.file, position: ip!.position }),
      };
    case 'lsp.foldingRanges':
      return {
        url: `/api/lsp/${ip!.projectId}/folding-ranges`,
        init: json({ file: ip!.file }),
      };
    case 'lsp.inlayHints':
      return {
        url: `/api/lsp/${ip!.projectId}/inlay-hints`,
        init: json({ file: ip!.file, range: ip!.range }),
      };
    case 'lsp.linkedEditingRanges':
      return {
        url: `/api/lsp/${ip!.projectId}/linked-editing-ranges`,
        init: json({ file: ip!.file, position: ip!.position }),
      };
    case 'lsp.organizeImports':
      return { url: `/api/lsp/${ip!.projectId}/organize-imports`, init: json({ file: ip!.file }) };
    case 'lsp.codeActions':
      return { url: `/api/lsp/${ip!.projectId}/code-actions`, init: json({ file: ip!.file, range: ip!.range }) };
    case 'lsp.rename':
      return { url: `/api/lsp/${ip!.projectId}/rename`, init: json({ file: ip!.file, position: ip!.position, newName: ip!.newName }) };
    case 'lsp.signatureHelp':
      return { url: `/api/lsp/${ip!.projectId}/signature-help`, init: json({ file: ip!.file, position: ip!.position }) };
    case 'lsp.documentSymbols':
      return { url: `/api/lsp/${ip!.projectId}/document-symbols`, init: json({ file: ip!.file }) };
    case 'lsp.didOpen':
      return {
        url: `/api/lsp/${ip!.projectId}/did-open`,
        init: json({ file: ip!.file, languageId: ip!.languageId, version: ip!.version, content: ip!.content, syncSessionId: ip!.syncSessionId }),
      };
    case 'lsp.didChange':
      return {
        url: `/api/lsp/${ip!.projectId}/did-change`,
        init: json({ file: ip!.file, version: ip!.version, changes: ip!.changes, syncSessionId: ip!.syncSessionId }),
      };
    case 'lsp.didClose':
      return { url: `/api/lsp/${ip!.projectId}/did-close`, init: json({ file: ip!.file, syncSessionId: ip!.syncSessionId }) };
    case 'lsp.resolveCompletion':
      return { url: `/api/lsp/${ip!.projectId}/resolve-completion`, init: json({ file: ip!.file, item: ip!.item }) };
    case 'lsp.resolveCodeAction':
      return { url: `/api/lsp/${ip!.projectId}/resolve-code-action`, init: json({ file: ip!.file, action: ip!.action }) };
    case 'lsp.executeCodeAction':
      return { url: `/api/lsp/${ip!.projectId}/execute-code-action`, init: json({ action: ip!.action }) };
    case 'lsp.serverStatus':
      return {
        url: `/api/lsp/${ip!.projectId}/server-status`,
        init: json({ languageId: ip!.languageId, file: ip!.file }),
      };
    case 'lsp.listServers':
      return { url: '/api/lsp/servers', init: { method: 'GET' } };
    case 'lsp.angularProfileOverrides':
      return { url: `/api/lsp/${ip!.projectId}/angular-profile-overrides`, init: { method: 'GET' } };
    case 'lsp.instances':
      return { url: '/api/lsp/instances', init: { method: 'GET' } };
    case 'editor.complete':
      return { url: '/api/editor/complete', init: json(ip!) };
    case 'editor.resolveConfig':
      return { url: '/api/editor/resolve-config', init: json(ip!) };
    case 'editor.cancel':
      return { url: '/api/editor/cancel', init: json(ip!) };
    case 'editor.probe':
      return { url: '/api/editor/probe', init: json(ip ?? {}) };
    case 'editor.feedback':
      return { url: '/api/editor/feedback', init: json(ip!) };
    case 'editor.delivery':
      return { url: '/api/editor/delivery', init: json(ip!) };
    case 'editor.stats':
      return { url: '/api/editor/stats', init: json(ip ?? {}) };
    case 'search.project': {
      const qp = new URLSearchParams({ q: String(ip!.query), limit: String(Number(ip!.limit ?? 50)) });
      if (ip!.mode) qp.set('mode', String(ip!.mode));
      if (ip!.type) qp.set('type', String(ip!.type));
      if (ip!.supersessionKey) qp.set('supersessionKey', String(ip!.supersessionKey));
      return { url: `/api/projects/${ip!.projectId}/search?${qp.toString()}`, init: {} };
    }
    case 'search.grep':
      return { url: `/api/projects/${ip!.projectId}/search/grep`, init: json(ip!) };
    case 'search.replace':
      return { url: `/api/projects/${ip!.projectId}/search/replace`, init: json(ip!) };
    case 'search.symbols':
      return { url: `/api/projects/${ip!.projectId}/search/symbols?q=${encodeURIComponent(String(ip!.query))}&limit=${Number(ip!.limit ?? 50)}`, init: {} };
    case 'search.text':
      return { url: `/api/projects/${ip!.projectId}/search/text?q=${encodeURIComponent(String(ip!.query))}&limit=${Number(ip!.limit ?? 50)}`, init: {} };
    case 'lsp.removeServer':
      return { url: `/api/lsp/servers/${ip!.serverId}`, init: { method: 'DELETE' } };
    case 'lsp.restartServer':
      return {
        url: `/api/lsp/${ip!.projectId}/servers/${ip!.serverId}/restart`,
        init: json({ routeId: ip!.routeId, file: ip!.file }),
      };
    case 'lsp.setLanguageLevel':
      return { url: `/api/lsp/${ip!.projectId}/language-level`, init: json({ languageId: ip!.languageId, level: ip!.level }) };
    case 'lsp.setAngularProfileOverride':
      return {
        url: `/api/lsp/${ip!.projectId}/angular-profile-overrides`,
        init: {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspacePath: ip!.workspacePath, profileId: ip!.profileId }),
        },
      };
    case 'lsp.languageLevels':
      return { url: `/api/lsp/${ip!.projectId}/language-levels`, init: {} };
    default:
      return null;
  }
}
