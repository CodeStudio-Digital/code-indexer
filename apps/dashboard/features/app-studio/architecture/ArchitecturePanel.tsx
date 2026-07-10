import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot, Boxes, CheckCircle2, ExternalLink, FilePenLine, Loader2, ShieldCheck, TestTube2, TriangleAlert } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import { patchAppStage, type AppStudioSessionDetail } from '../app-studio-api.js';
import { ApproveBar } from '../guide/ApproveBar.js';

export function ArchitecturePanel({
  detail,
  onChanged,
  onOpenAgent,
}: {
  detail: AppStudioSessionDetail;
  onChanged: () => void;
  onOpenAgent?: (prompt: string) => void;
}) {
  const { t } = useTranslation('appStudio');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stage = detail.pipeline?.stages.find((item) => item.id === 'architecture');
  const architecture = detail.architecture;

  async function act(action: 'approve' | 'reopen', feedback?: string) {
    setBusy(true);
    setError(null);
    try {
      await patchAppStage(detail.session.id, 'architecture', action, feedback);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function openAgent() {
    setBusy(true);
    setError(null);
    try {
      if (stage?.status === 'pending') await patchAppStage(detail.session.id, 'architecture', 'start');
      onChanged();
      onOpenAgent?.(t('stageMessage.architecture'));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function updateSpec() {
    setError(null);
    onOpenAgent?.(t('architecture.updateSpecPrompt'));
  }

  if (!architecture) {
    return (
      <div className="flex h-full min-h-[360px] flex-col items-center justify-center gap-3 p-8 text-center">
        <div className="grid h-10 w-10 place-items-center rounded-md border bg-muted/30"><Boxes className="h-5 w-5 text-primary" /></div>
        <div className="max-w-md">
          <h2 className="text-base font-semibold">{t('architecture.emptyTitle')}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t('architecture.emptyBody')}</p>
        </div>
        {error && <p className="text-xs text-red-600">{error}</p>}
        <Button size="sm" disabled={busy || !detail.spec} onClick={() => void openAgent()}>
          {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Bot className="mr-1 h-3.5 w-3.5" />}
          {t('architecture.openAgent')}
        </Button>
      </div>
    );
  }

  const { plan, audit } = architecture;
  return (
    <div className="mx-auto w-full max-w-6xl space-y-5 p-4">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b pb-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold">{t('architecture.title')}</h2>
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">v{architecture.revision_number}</span>
            <span className={audit.ok ? 'text-xs text-green-600' : 'text-xs text-amber-600'}>
              {audit.ok ? t('architecture.ready') : t('architecture.pending', { count: audit.issues.length })}
            </span>
          </div>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{plan.summary}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" disabled={busy} onClick={updateSpec}>
            <FilePenLine className="mr-1 h-3.5 w-3.5" /> {t('architecture.updateSpec')}
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void openAgent()}>
            <Bot className="mr-1 h-3.5 w-3.5" /> {t('architecture.refine')}
          </Button>
        </div>
      </header>

      {error && <p className="rounded border border-red-300 bg-red-50 p-2 text-xs text-red-800">{error}</p>}

      <section>
        <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold"><Boxes className="h-4 w-4 text-primary" />{t('architecture.modules')}</h3>
        <div className="grid gap-px overflow-hidden rounded-md border bg-border md:grid-cols-2">
          {plan.modules.map((module) => (
            <div key={module.id} className="bg-background p-3">
              <div className="flex items-center justify-between gap-2"><strong className="text-sm">{module.name}</strong><span className="text-[10px] uppercase text-muted-foreground">{module.layer}</span></div>
              <p className="mt-1 text-xs text-muted-foreground">{module.responsibility}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="grid gap-5 lg:grid-cols-2">
        <div>
          <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold"><CheckCircle2 className="h-4 w-4 text-primary" />{t('architecture.decisions')}</h3>
          <div className="divide-y rounded-md border">
            {plan.decisions.map((decision) => <div key={decision.id} className="p-3"><p className="text-sm font-medium">{decision.title}</p><p className="mt-1 text-xs">{decision.decision}</p><p className="mt-1 text-xs text-muted-foreground">{decision.rationale}</p></div>)}
          </div>
        </div>
        <div>
          <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold"><TestTube2 className="h-4 w-4 text-primary" />{t('architecture.tests')}</h3>
          <p className="mb-2 text-xs text-muted-foreground">{plan.tdd.strategy}</p>
          <div className="divide-y rounded-md border">
            {plan.tdd.cases.map((testCase) => <div key={testCase.id} className="flex items-start gap-2 p-3"><span className="mt-0.5 rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase">{testCase.layer}</span><div><p className="text-sm font-medium">{testCase.title}</p><p className="mt-0.5 text-xs text-muted-foreground">{testCase.expected}</p></div></div>)}
          </div>
        </div>
      </section>

      <section className="grid gap-5 lg:grid-cols-2">
        <div><h3 className="mb-2 flex items-center gap-2 text-sm font-semibold"><ShieldCheck className="h-4 w-4 text-primary" />{t('architecture.security')}</h3><ul className="space-y-1 text-xs text-muted-foreground">{plan.security.map((item) => <li key={item}>• {item}</li>)}</ul></div>
        <div><h3 className="mb-2 flex items-center gap-2 text-sm font-semibold"><TriangleAlert className="h-4 w-4 text-primary" />{t('architecture.risks')}</h3><ul className="space-y-1 text-xs text-muted-foreground">{plan.risks.map((risk) => <li key={risk.id}><strong className="text-foreground">{risk.title}:</strong> {risk.mitigation}</li>)}</ul></div>
      </section>

      <section className="border-t pt-4">
        <h3 className="mb-2 text-sm font-semibold">{t('architecture.sources')}</h3>
        <div className="flex flex-wrap gap-2">{plan.sources.map((source) => <a key={source.url} href={source.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded border px-2 py-1 text-xs hover:bg-muted">{source.title}<ExternalLink className="h-3 w-3" /></a>)}</div>
      </section>

      {stage?.status === 'review' && <div className="border-t pt-4"><ApproveBar busy={busy} onApprove={() => void act('approve')} onReopen={(feedback) => void act('reopen', feedback)} /></div>}
    </div>
  );
}
