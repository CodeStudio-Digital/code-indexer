/**
 * Shared parser that maps the current router location to a coarse "active
 * view" ({ page, projectId, sessionId }). Extracted from AppShell so the
 * Pinned Tabs Bar and the pin describe/active-match helpers use the exact same
 * classification as the top nav — one source of truth, no drift.
 */

export interface ActiveView {
  page:
    | 'home'
    | 'project'
    | 'agents'
    | 'global'
    | 'admin'
    | 'design-systems'
    | 'sprites'
    | 'telemetry'
    | 'docs'
    | 'other';
  projectId: number | null;
  sessionId: number | null;
}

export function parseView(pathname: string, search: string): ActiveView {
  if (pathname === '/' || pathname === '') {
    return { page: 'home', projectId: null, sessionId: null };
  }
  if (pathname.startsWith('/projects/')) {
    const parts = pathname.split('/');
    const id = Number(parts[2]);
    const params = new URLSearchParams(search);
    const sessionIdRaw = params.get('session');
    return {
      page: 'project',
      projectId: Number.isFinite(id) ? id : null,
      sessionId: sessionIdRaw ? Number(sessionIdRaw) : null,
    };
  }
  if (pathname === '/agents' || pathname.startsWith('/company/sessions/')) {
    return { page: 'agents', projectId: null, sessionId: null };
  }
  if (pathname.startsWith('/global')) {
    const params = new URLSearchParams(search);
    const sessionIdRaw = params.get('session');
    return { page: 'global', projectId: null, sessionId: sessionIdRaw ? Number(sessionIdRaw) : null };
  }
  if (pathname.startsWith('/admin')) return { page: 'admin', projectId: null, sessionId: null };
  if (pathname.startsWith('/design-systems')) return { page: 'design-systems', projectId: null, sessionId: null };
  if (pathname.startsWith('/sprites')) return { page: 'sprites', projectId: null, sessionId: null };
  if (pathname.startsWith('/telemetry')) return { page: 'telemetry', projectId: null, sessionId: null };
  if (pathname.startsWith('/docs')) return { page: 'docs', projectId: null, sessionId: null };
  return { page: 'other', projectId: null, sessionId: null };
}
