import React, { useState } from 'react';
import { Loader2, Sparkles, Check, Layers } from 'lucide-react';
import {
  workspaceApi,
  type GitStatusResponse,
  type SuggestedCommitGroup,
  type ApiError,
} from '../api.js';

interface Props {
  sessionId: string;
  projectId: number;
  status: GitStatusResponse;
  onMutated: () => void | Promise<void>;
}

function isApiError(err: unknown): err is ApiError {
  return !!err && typeof err === 'object' && 'status' in (err as Record<string, unknown>);
}

export function CommitBox({ sessionId, projectId, status, onMutated }: Props) {
  const [message, setMessage] = useState('');
  const [committing, setCommitting] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [grouping, setGrouping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notConfigured, setNotConfigured] = useState(false);
  const [groups, setGroups] = useState<SuggestedCommitGroup[] | null>(null);
  const [applyingGroup, setApplyingGroup] = useState<string | null>(null);

  const stagedCount = status.files.filter((f) => f.index !== '.' && f.index !== '?').length;
  const hasStaged = stagedCount > 0;
  const canCommit = hasStaged && message.trim().length > 0 && !committing;

  function handleAiError(err: unknown) {
    if (isApiError(err) && err.code === 'general_ai_not_configured') {
      setNotConfigured(true);
      setError(null);
    } else {
      setNotConfigured(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleSuggestMessage() {
    if (suggesting || !hasStaged) return;
    setSuggesting(true);
    setError(null);
    setNotConfigured(false);
    try {
      const r = await workspaceApi.suggestCommitMessage(sessionId, projectId);
      setMessage(r.message);
    } catch (err) {
      handleAiError(err);
    } finally {
      setSuggesting(false);
    }
  }

  async function handleSuggestGroups() {
    if (grouping) return;
    setGrouping(true);
    setError(null);
    setNotConfigured(false);
    setGroups(null);
    try {
      const r = await workspaceApi.suggestStaging(sessionId, projectId);
      setGroups(r.groups);
    } catch (err) {
      handleAiError(err);
    } finally {
      setGrouping(false);
    }
  }

  async function handleApplyGroup(group: SuggestedCommitGroup) {
    if (applyingGroup) return;
    setApplyingGroup(group.title);
    setError(null);
    try {
      await workspaceApi.gitAdd(sessionId, projectId, group.paths);
      await onMutated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setApplyingGroup(null);
    }
  }

  async function handleCommit() {
    if (!canCommit) return;
    setCommitting(true);
    setError(null);
    try {
      await workspaceApi.gitCommit(sessionId, projectId, message.trim());
      setMessage('');
      setGroups(null);
      await onMutated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCommitting(false);
    }
  }

  return (
    <div className="border-t bg-background">
      <div className="px-3 py-2 border-b text-[10px] uppercase tracking-wide text-muted-foreground">
        Novo commit
      </div>
      <div className="p-3 flex flex-col gap-2">
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder={hasStaged ? 'Mensagem do commit…' : 'Adicione arquivos ao stage primeiro.'}
          rows={3}
          disabled={!hasStaged || committing}
          className="w-full resize-y min-h-[72px] text-xs font-mono rounded-md border bg-muted/20 px-2 py-1.5 disabled:opacity-60 focus:outline-none focus:ring-1 focus:ring-primary"
        />
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={handleSuggestMessage}
            disabled={!hasStaged || suggesting || committing}
            className="text-xs flex items-center gap-1 px-2 py-1 rounded-md border hover:bg-muted disabled:opacity-40"
            title={hasStaged ? 'Gerar mensagem com IA a partir do diff staged' : 'Stage algum arquivo para habilitar'}
          >
            {suggesting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            Gerar com IA
          </button>
          <button
            type="button"
            onClick={handleSuggestGroups}
            disabled={grouping || committing || status.files.length === 0}
            className="text-xs flex items-center gap-1 px-2 py-1 rounded-md border hover:bg-muted disabled:opacity-40"
            title="Sugerir agrupamento lógico dos arquivos alterados"
          >
            {grouping ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Layers className="h-3.5 w-3.5" />}
            Sugerir agrupamento
          </button>
          <span className="flex-1" />
          <span className="text-[10px] text-muted-foreground">
            {stagedCount} staged
          </span>
          <button
            type="button"
            onClick={handleCommit}
            disabled={!canCommit}
            className="text-xs flex items-center gap-1 px-3 py-1 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
          >
            {committing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
            Commit
          </button>
        </div>
        {notConfigured && (
          <div className="text-xs text-amber-600 dark:text-amber-400">
            IA geral não configurada. Configure em Admin → AI Geral.
          </div>
        )}
        {error && <div className="text-xs text-destructive">{error}</div>}
        {groups && groups.length === 0 && (
          <div className="text-xs text-muted-foreground italic">A IA não sugeriu nenhum agrupamento.</div>
        )}
        {groups && groups.length > 0 && (
          <div className="flex flex-col gap-1.5 mt-1">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Sugestão de agrupamento</div>
            {groups.map((g) => (
              <div key={g.title} className="rounded-md border bg-muted/10 p-2 text-xs flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium flex-1 truncate">{g.title}</span>
                  <button
                    type="button"
                    onClick={() => handleApplyGroup(g)}
                    disabled={!!applyingGroup}
                    className="px-2 py-0.5 text-[11px] rounded border hover:bg-muted disabled:opacity-40 flex items-center gap-1"
                  >
                    {applyingGroup === g.title && <Loader2 className="h-3 w-3 animate-spin" />}
                    Stage este grupo
                  </button>
                </div>
                {g.rationale && <div className="text-muted-foreground">{g.rationale}</div>}
                <ul className="font-mono text-[10.5px] leading-snug text-muted-foreground pl-3">
                  {g.paths.map((p) => <li key={p}>{p}</li>)}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
