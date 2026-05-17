import React, { useState } from 'react';
import { GitBranch, Loader2 } from 'lucide-react';
import { workspaceApi, type GitStatusResponse } from '../api.js';

interface Props {
  sessionId: number;
  projectId: number;
  onInitialized: (status: GitStatusResponse) => void;
}

export function GitInitCard({ sessionId, projectId, onInitialized }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleInit() {
    setLoading(true);
    setError(null);
    try {
      const r = await workspaceApi.gitInit(sessionId, projectId);
      onInitialized(r.status);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="p-6 flex flex-col items-center justify-center text-center gap-3">
      <GitBranch className="h-10 w-10 text-muted-foreground opacity-40" />
      <p className="text-sm font-medium">Este projeto não é um repositório Git</p>
      <p className="text-xs text-muted-foreground max-w-sm">
        Inicialize um repositório Git em <code className="font-mono">.git/</code> para começar a acompanhar alterações.
      </p>
      <button
        onClick={handleInit}
        disabled={loading}
        className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md border bg-primary text-primary-foreground hover:opacity-90 text-xs disabled:opacity-40"
      >
        {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <GitBranch className="h-3.5 w-3.5" />}
        Inicializar Git
      </button>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
