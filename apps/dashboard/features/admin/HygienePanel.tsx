import { useEffect, useMemo, useState } from 'react';
import { Loader2, RefreshCcw, Sparkles, Trash2, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card.js';
import { confirm } from '../../components/ui/prompt-dialog.js';
import {
  cleanupProject,
  clearAllProjectData,
  clearProjectData,
  fetchHygieneStatus,
  purgeProjects,
  runGlobalSqlCleanup,
  type CleanupResult,
  type HygieneProject,
  type HygieneStatus,
} from './hygiene-api.js';

/**
 * Sum the per-project counters so the header shows a single "X issues
 * across N projects" line. We treat any of the four signals as an
 * issue — a project with all zeros doesn't show on the warning row.
 */
function countIssues(p: HygieneProject): number {
  return (
    p.orphan_semantic_items +
    p.stale_runs +
    p.mixed_case_languages +
    (p.missing_on_disk ? 1 : 0)
  );
}

function severity(p: HygieneProject): 'ok' | 'warn' | 'bad' {
  if (p.missing_on_disk) return 'bad';
  if (countIssues(p) > 0) return 'warn';
  return 'ok';
}

const SEVERITY_CLASS: Record<'ok' | 'warn' | 'bad', string> = {
  ok: 'border-emerald-500/30',
  warn: 'border-amber-500/40',
  bad: 'border-red-500/50',
};

export function HygienePanel() {
  const [status, setStatus] = useState<HygieneStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setStatus(await fetchHygieneStatus());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const totals = useMemo(() => {
    if (!status) return null;
    return status.projects.reduce(
      (acc, p) => {
        acc.orphans += p.orphan_semantic_items;
        acc.stale += p.stale_runs;
        acc.langs += p.mixed_case_languages;
        if (p.missing_on_disk) acc.missing += 1;
        return acc;
      },
      { orphans: 0, stale: 0, langs: 0, missing: 0 },
    );
  }, [status]);

  async function withBusy<T>(label: string, fn: () => Promise<T>, summarize: (r: T) => string): Promise<void> {
    setBusy(label);
    setLastResult(null);
    setError(null);
    try {
      const result = await fn();
      setLastResult(summarize(result));
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  function summarizeCleanup(r: CleanupResult): string {
    const parts = [
      r.vectors_deleted_local > 0 && `${r.vectors_deleted_local} vetores locais removidos`,
      r.local_deleted > 0 && `${r.local_deleted} itens semânticos locais removidos`,
      r.languages_normalized > 0 && `${r.languages_normalized} linguagens normalizadas`,
      r.stale_runs_closed > 0 && `${r.stale_runs_closed} runs fechados`,
      r.vector_error && `erro vetorial: ${r.vector_error}`,
    ].filter(Boolean) as string[];
    return parts.length > 0 ? parts.join(' · ') : 'Nada para limpar.';
  }

  async function purgeMissing() {
    if (!status) return;
    const ids = status.projects.filter((p) => p.missing_on_disk).map((p) => p.id);
    if (ids.length === 0) {
      setLastResult('Nenhum projeto com root_path ausente.');
      return;
    }
    if (!(await confirm({
      title: `Apagar ${ids.length} projeto(s) ausente(s)?`,
      description: 'Os diretórios não existem mais no disco e os bancos vetoriais locais correspondentes serão removidos.',
      confirmLabel: 'Apagar projetos',
      tone: 'destructive',
    }))) {
      return;
    }
    await withBusy('purge', () => purgeProjects(ids), (r) => {
      const vectors = r.summaries.reduce((acc, s) => acc + s.vectors_deleted, 0);
      const errors = r.summaries.filter((s) => s.vector_error).length;
      return `${r.purged} projeto(s) apagado(s), ${vectors} vetores locais removidos${errors > 0 ? `, ${errors} com erro` : ''}.`;
    });
  }

  async function clearAll() {
    if (!status) return;
    const n = status.projects.length;
    if (n === 0) {
      setLastResult('Nenhum projeto para limpar.');
      return;
    }
    if (
      !(await confirm({
        title: `Limpar todos os dados de ${n} projeto(s)?`,
        description: 'Apaga índice, sessões, snapshots, runs, custos e vetores, mas mantém os projetos cadastrados. Esta ação é irreversível.',
        confirmLabel: 'Limpar dados',
        tone: 'destructive',
      }))
    ) {
      return;
    }
    await withBusy('clear-all', clearAllProjectData, (r) => {
      const errs = r.errors.length > 0 ? `, ${r.errors.length} com erro` : '';
      return `${r.projects_cleared} projeto(s) limpo(s), ${r.vectors_deleted} vetores locais removidos${errs}. Re-indexe quando quiser.`;
    });
  }

  async function clearOne(p: HygieneProject) {
    if (
      !(await confirm({
        title: `Limpar todos os dados de “${p.name}”?`,
        description: 'Apaga índice, sessões, snapshots, runs, custos e vetores, mas mantém o projeto cadastrado. Esta ação é irreversível.',
        confirmLabel: 'Limpar dados',
        tone: 'destructive',
      }))
    ) {
      return;
    }
    await withBusy(`clear-${p.id}`, () => clearProjectData(p.id), (r) =>
      `"${p.name}" limpo: ${r.vectors_deleted} vetores locais removidos` +
      `${r.vector_error ? ` (erro: ${r.vector_error})` : ''}. Re-indexe quando quiser.`,
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Sparkles className="h-4 w-4" /> Higiene do Indexador
          </h2>
          <p className="text-sm text-muted-foreground">
            Detecta itens semânticos órfãos, runs travados e projetos
            cujo diretório sumiu do disco. Limpezas removem dados; revise antes de confirmar.
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading || !!busy}>
            <RefreshCcw className={`h-3.5 w-3.5 mr-1 ${loading ? 'animate-spin' : ''}`} />
            Atualizar
          </Button>
        </div>
      </div>

      {status && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
          <Card>
            <CardContent className="py-3 px-3">
              <div className="text-muted-foreground">Vetores locais</div>
              <div className={`font-medium ${status.vector_store_available ? 'text-emerald-500' : 'text-red-500'}`}>
                {status.vector_store_available ? 'online' : 'offline'}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="py-3 px-3">
              <div className="text-muted-foreground">Projetos</div>
              <div className="font-medium">{status.projects.length}</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="py-3 px-3">
              <div className="text-muted-foreground">Issues totais</div>
              <div className="font-medium">
                {totals ? totals.orphans + totals.stale + totals.langs + totals.missing : 0}
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={!!busy || !status}
          onClick={() =>
            void withBusy('global-sql', runGlobalSqlCleanup, (r) =>
              `SQL cleanup: ${r.languages_normalized} linguagens, ${r.stale_runs_closed} runs fechados.`,
            )
          }
        >
          {busy === 'global-sql' && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
          SQL cleanup global
        </Button>
        <Button
          variant="destructive"
          size="sm"
          disabled={!!busy || !status || !totals || totals.missing === 0}
          onClick={() => void purgeMissing()}
        >
          {busy === 'purge' && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
          <Trash2 className="h-3.5 w-3.5 mr-1" />
          Apagar projetos sumidos do disco
          {totals && totals.missing > 0 && (
            <Badge variant="secondary" className="ml-2 h-4 text-[10px]">
              {totals.missing}
            </Badge>
          )}
        </Button>
        <Button
          variant="destructive"
          size="sm"
          disabled={!!busy || !status || status.projects.length === 0}
          onClick={() => void clearAll()}
          title="Zera índice/sessões/snapshots/vetores de todos os projetos, mantendo os projetos cadastrados. Use antes de re-indexar do zero."
        >
          {busy === 'clear-all' && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
          <Trash2 className="h-3.5 w-3.5 mr-1" />
          Limpar dados de TODOS os projetos
          {status && status.projects.length > 0 && (
            <Badge variant="secondary" className="ml-2 h-4 text-[10px]">
              {status.projects.length}
            </Badge>
          )}
        </Button>
      </div>

      {lastResult && (
        <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs flex items-start gap-2">
          <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
          <span>{lastResult}</span>
        </div>
      )}
      {error && (
        <div className="rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 text-red-500 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {loading && !status && <div className="text-sm text-muted-foreground">Carregando…</div>}

      {status && (
        <div className="space-y-2">
          {status.projects.length === 0 && (
            <div className="text-sm text-muted-foreground border rounded-lg p-6 text-center">
              Nenhum projeto indexado.
            </div>
          )}
          {status.projects.map((p) => {
            const sev = severity(p);
            const issues = countIssues(p);
            return (
              <Card key={p.id} className={SEVERITY_CLASS[sev]}>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="truncate font-medium">{p.name}</span>
                      {p.missing_on_disk && (
                        <Badge variant="destructive" className="h-4 text-[10px]">
                          disco ausente
                        </Badge>
                      )}
                      {issues === 0 && !p.missing_on_disk && (
                        <Badge variant="secondary" className="h-4 text-[10px]">limpo</Badge>
                      )}
                    </div>
                    <div className="flex gap-1.5 shrink-0">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!!busy}
                        onClick={() =>
                          void withBusy(`cleanup-${p.id}`, () => cleanupProject(p.id), summarizeCleanup)
                        }
                      >
                        {busy === `cleanup-${p.id}` && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
                        Cleanup
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={!!busy}
                        onClick={() => void clearOne(p)}
                        title="Zera índice/sessões/snapshots/vetores deste projeto, mantendo o cadastro. Use antes de re-indexar do zero."
                      >
                        {busy === `clear-${p.id}` && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
                        <Trash2 className="h-3.5 w-3.5 mr-1" />
                        Limpar
                      </Button>
                    </div>
                  </CardTitle>
                  <p className="text-[11px] text-muted-foreground font-mono truncate">{p.root_path}</p>
                </CardHeader>
                <CardContent className="pt-0 pb-3 space-y-2">
                  <div className="grid grid-cols-3 sm:grid-cols-5 gap-2 text-[11px]">
                    <Counter label="files" value={p.file_count} />
                    <Counter label="vectors" value={p.vector_count} />
                    <Counter label="itens órfãos" value={p.orphan_semantic_items} warn={p.orphan_semantic_items > 0} />
                    <Counter label="runs travados" value={p.stale_runs} warn={p.stale_runs > 0} />
                    <Counter label="lang mix" value={p.mixed_case_languages} warn={p.mixed_case_languages > 0} />
                  </div>
                  {(p.tiers.core || p.tiers.support || p.tiers.on_demand || p.tiers.untagged) && (
                    <div className="flex flex-wrap gap-1.5 text-[10px]">
                      {p.tiers.core ? (
                        <Badge variant="outline" className="h-4 border-emerald-500/40">core: {p.tiers.core}</Badge>
                      ) : null}
                      {p.tiers.support ? (
                        <Badge variant="outline" className="h-4">support: {p.tiers.support}</Badge>
                      ) : null}
                      {p.tiers.on_demand ? (
                        <Badge variant="outline" className="h-4 border-amber-500/40">on_demand: {p.tiers.on_demand}</Badge>
                      ) : null}
                      {p.tiers.untagged ? (
                        <Badge variant="outline" className="h-4 border-muted">untagged: {p.tiers.untagged}</Badge>
                      ) : null}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Counter({ label, value, warn }: { label: string; value: number; warn?: boolean }) {
  return (
    <div className="flex flex-col">
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-medium ${warn ? 'text-amber-500' : ''}`}>{value}</span>
    </div>
  );
}
