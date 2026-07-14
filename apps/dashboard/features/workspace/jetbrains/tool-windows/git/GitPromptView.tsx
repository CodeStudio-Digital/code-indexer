/**
 * Git Prompt — natural-language git via the "IA Geral" provider.
 *
 * Flow:
 *   1. User types intent ("crie branch X partindo de main e
 *       dê cherry-pick do último commit de release/2.0").
 *   2. Click "Gerar plano" → backend asks the AI for a structured plan
 *       of typed operations + server-derived risk.
 *   3. UI lists each step. Dangerous steps (reset --hard, branch -D,
 *       force push) get a warning tint. User reviews.
 *   4. Click "Executar" → backend runs the steps sequentially, stopping
 *       at the first non-zero exit. Per-step results stream back into
 *       the same list (success / failure + stderr excerpt).
 *
 * Safety: the renderer only sends the opaque planId back. The backend executes
 * its immutable typed copy once; previews are never parsed as commands.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Play,
  Sparkles,
  Trash2,
  Wand2,
  XCircle,
} from 'lucide-react';
import { apiCall } from '../../../../../lib/api-client.js';
import { Button } from '../../../../../components/ui/button.js';
import { toast } from '../../../../../components/ui/prompt-dialog.js';
import { cn } from '../../../../../lib/utils.js';
import type { GitPlan, GitRunResult } from '@mcp/api-bus';

interface GitPromptViewProps {
  projectId: number;
  /** Selected git root (submodule / nested repo); undefined = main repo. */
  repoPath?: string;
  onMutated: () => void;
}

export function GitPromptView({ projectId, repoPath, onMutated }: GitPromptViewProps) {
  const { t } = useTranslation('workspace');
  const suggestions = [1, 2, 3, 4].map((index) => t(`git.ai.suggestion${index}`));
  const [intent, setIntent] = useState('');
  const [plan, setPlan] = useState<GitPlan | null>(null);
  const [results, setResults] = useState<GitRunResult[] | null>(null);
  const [aborted, setAborted] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aiConsent, setAiConsent] = useState(false);

  const generatePlan = async () => {
    if (!intent.trim() || !aiConsent) return;
    setPlanning(true);
    setPlan(null);
    setResults(null);
    setAborted(false);
    setError(null);
    try {
      const p = await apiCall<GitPlan>('projectGit.aiPlan', {
        projectId,
        repoPath,
        intent: intent.trim(),
        consent: true,
      });
      setPlan(p);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPlanning(false);
    }
  };

  const execute = async () => {
    if (!plan || plan.steps.length === 0) return;
    setExecuting(true);
    setResults(null);
    setAborted(false);
    try {
      const r = await apiCall<{ results: GitRunResult[]; aborted: boolean }>(
        'projectGit.aiExecute',
        { projectId, repoPath, planId: plan.planId },
      );
      setResults(r.results);
      setAborted(r.aborted);
      if (r.aborted) {
        toast.error(t('git.ai.stopped'), {
          description: t('git.ai.stoppedDescription'),
        });
      } else {
        toast.success(t('git.ai.executed'), {
          description: t('git.ai.completedSteps', { count: r.results.length }),
        });
      }
      onMutated();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setExecuting(false);
    }
  };

  const reset = () => {
    setPlan(null);
    setResults(null);
    setAborted(false);
    setError(null);
  };

  const dangerousCount = plan?.steps.filter((s) => s.risk === 'destructive').length ?? 0;

  return (
    <div className="h-full flex flex-col min-h-0 overflow-y-auto">
      <div className="shrink-0 px-3 py-2 border-b">
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Sparkles className="h-3 w-3 text-primary" />
          <span>{t('git.ai.intro')}</span>
        </div>
      </div>

      <div className="shrink-0 p-3 border-b space-y-2">
        <textarea
          value={intent}
          onChange={(e) => setIntent(e.target.value)}
          placeholder={suggestions[0]}
          className="w-full min-h-[80px] rounded-md border bg-card px-3 py-2 text-[12px] focus:outline-none focus:ring-2 focus:ring-ring/40 resize-y"
          disabled={planning || executing}
        />
        <label className="flex items-start gap-2 text-[10.5px] text-muted-foreground cursor-pointer">
          <input
            type="checkbox"
            checked={aiConsent}
            onChange={(event) => setAiConsent(event.target.checked)}
            disabled={planning || executing}
            className="mt-0.5"
          />
          <span>{t('git.ai.consent')}</span>
        </label>
        <div className="flex items-center gap-1.5 flex-wrap">
          <Button
            size="sm"
            onClick={() => void generatePlan()}
            disabled={!intent.trim() || !aiConsent || planning || executing}
            className="h-7 text-[11.5px]"
          >
            {planning ? (
              <Loader2 className="h-3 w-3 mr-1 animate-spin" />
            ) : (
              <Wand2 className="h-3 w-3 mr-1" />
            )}
            {t('git.ai.generate')}
          </Button>
          {(plan || results) && (
            <Button
              size="sm"
              variant="ghost"
              onClick={reset}
              disabled={planning || executing}
              className="h-7 text-[11.5px]"
            >
              {t('git.ai.clear')}
            </Button>
          )}
          {!plan && !results && (
            <div className="flex items-center gap-1 flex-wrap ml-auto">
              {suggestions.slice(0, 2).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setIntent(s)}
                  className="text-[10px] text-muted-foreground hover:text-foreground border rounded-sm px-2 py-0.5 hover:bg-muted/40"
                  title={s}
                >
                  {s.slice(0, 40)}…
                </button>
              ))}
            </div>
          )}
        </div>
        {error && <div className="text-[11px] text-destructive">{error}</div>}
      </div>

      {plan?.refusal && (
        <div className="m-3 p-3 rounded-md border border-amber-500/40 bg-amber-500/10 text-[11.5px] text-amber-700 dark:text-amber-300">
          <div className="font-medium mb-1 inline-flex items-center gap-1">
            <AlertTriangle className="h-3 w-3" />
            {t('git.ai.refused')}
          </div>
          <div className="leading-snug">{plan.refusal}</div>
        </div>
      )}

      {plan && plan.steps.length > 0 && (
        <div className="p-3 space-y-2">
          {plan.summary && (
            <div className="text-[11.5px] text-muted-foreground italic">{plan.summary}</div>
          )}
          <div className="rounded-md border bg-card/40 overflow-hidden">
            {plan.steps.map((s, i) => {
              const result = results?.[i];
              return (
                <div
                  key={s.id}
                  className={cn(
                    'flex items-start gap-2 px-3 py-2 border-b last:border-b-0',
                    s.risk === 'destructive' && !result && 'bg-amber-500/5',
                    result?.ok === true && 'bg-emerald-500/5',
                    result?.ok === false && 'bg-destructive/10',
                  )}
                >
                  <span className="text-[10px] text-muted-foreground/70 font-mono w-5 shrink-0 mt-0.5">
                    {i + 1}.
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1 flex-wrap">
                      <code className="font-mono text-[11.5px] bg-muted/60 rounded px-1.5 py-0.5">
                        {s.preview}
                      </code>
                      {s.risk === 'destructive' && !result && (
                        <span className="inline-flex items-center gap-0.5 text-[9.5px] text-amber-600 dark:text-amber-400 font-medium">
                          <AlertTriangle className="h-2.5 w-2.5" />
                          {t('git.ai.destructive')}
                        </span>
                      )}
                      {result?.ok === true && (
                        <CheckCircle2 className="h-3 w-3 text-emerald-500 shrink-0" />
                      )}
                      {result?.ok === false && (
                        <XCircle className="h-3 w-3 text-destructive shrink-0" />
                      )}
                    </div>
                    {s.description && (
                      <div className="text-[11px] text-muted-foreground mt-0.5">{s.description}</div>
                    )}
                    {result && (result.stderr || result.stdout) && (
                      <pre className="mt-1 text-[10.5px] font-mono bg-muted/40 rounded p-1.5 max-h-32 overflow-auto whitespace-pre-wrap">
                        {result.stderr || result.stdout}
                      </pre>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {!results && (
            <div className="flex items-center gap-2 pt-1">
              <Button
                size="sm"
                onClick={() => void execute()}
                disabled={executing}
                className="h-7 text-[11.5px]"
                variant={dangerousCount > 0 ? 'destructive' : 'default'}
              >
                {executing ? (
                  <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                ) : (
                  <Play className="h-3 w-3 mr-1" />
                )}
                {t('git.ai.executeSteps', { count: plan.steps.length })}
                {dangerousCount > 0 && ` (${t('git.ai.destructiveSteps', { count: dangerousCount })})`}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={reset}
                disabled={executing}
                className="h-7 text-[11.5px]"
              >
                <Trash2 className="h-3 w-3 mr-1" />
                {t('git.ai.discardPlan')}
              </Button>
            </div>
          )}
          {aborted && (
            <div className="text-[11.5px] text-amber-600 dark:text-amber-400">
              {t('git.ai.aborted')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
