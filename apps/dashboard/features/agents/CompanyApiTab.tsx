/**
 * Company API tab — wraps the full API client (Postman) and the read-only
 * Scalar docs browser behind a Client/Docs toggle. The client persists per
 * PROJECT, so it needs the session's linked project; when a session has no
 * linked project we fall back to Docs-only (Scalar reads the sandbox spec).
 */
import { lazy, Suspense, useState } from 'react';
import { CompanyApiReferenceTab } from './CompanyApiReferenceTab.js';
import type { SessionProject } from '../builder/preview/useSessionProjects.js';

type Mode = 'client' | 'docs';

const ApiClientTab = lazy(() =>
  import('../api-client/ApiClientTab.js').then((module) => ({ default: module.ApiClientTab })),
);

interface Props {
  sessionId: number;
  projects: SessionProject[];
}

export function CompanyApiTab({ sessionId, projects }: Props) {
  const projectId = projects[0]?.project_id ?? null;
  const [mode, setMode] = useState<Mode>(projectId != null ? 'client' : 'docs');

  return (
    <div className="flex flex-col h-full">
      <div className="h-8 flex items-center gap-1 px-2 border-b text-xs">
        <button
          disabled={projectId == null}
          onClick={() => setMode('client')}
          className={`px-2 py-0.5 rounded ${mode === 'client' ? 'bg-muted font-medium' : 'text-muted-foreground hover:text-foreground'} disabled:opacity-40`}
        >
          Client
        </button>
        <button
          onClick={() => setMode('docs')}
          className={`px-2 py-0.5 rounded ${mode === 'docs' ? 'bg-muted font-medium' : 'text-muted-foreground hover:text-foreground'}`}
        >
          Docs
        </button>
      </div>
      <div className="flex-1 min-h-0">
        {mode === 'client' && projectId != null
          ? <Suspense fallback={null}><ApiClientTab projectId={projectId} /></Suspense>
          : <CompanyApiReferenceTab sessionId={sessionId} />}
      </div>
    </div>
  );
}
