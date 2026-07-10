import { Bot, CheckCircle2, CircleAlert, CircleHelp, FileText, PanelRightClose, PanelRightOpen, Target, TriangleAlert } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { auditAppSpec, type SpecAuditIssue, type SpecAuditSeverity } from '@mcp/app-studio/spec/audit.js';
import type { AppSpec } from '@mcp/app-studio/spec/types.js';
import { Button } from '../../../components/ui/button.js';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../components/ui/tooltip.js';
import { cn } from '../../../lib/utils.js';

interface SpecOverviewPanelProps {
  spec: AppSpec;
  onOpenSpecAgent?: (prompt: string) => void;
}

const SEVERITY_CLASS: Record<SpecAuditSeverity, string> = {
  error: 'border-red-300/70 bg-red-50 text-red-800 dark:border-red-400/30 dark:bg-red-950/25 dark:text-red-200',
  warning:
    'border-amber-300/70 bg-amber-50 text-amber-800 dark:border-amber-400/30 dark:bg-amber-950/25 dark:text-amber-200',
  info: 'border-sky-300/70 bg-sky-50 text-sky-800 dark:border-sky-400/30 dark:bg-sky-950/25 dark:text-sky-200',
};

const OVERVIEW_COLLAPSED_KEY = 'mcp.app-studio.spec-overview-collapsed';

function IssueIcon({ severity }: { severity: SpecAuditSeverity }) {
  if (severity === 'error') return <CircleAlert className="h-3.5 w-3.5 shrink-0" />;
  if (severity === 'warning') return <TriangleAlert className="h-3.5 w-3.5 shrink-0" />;
  return <CircleHelp className="h-3.5 w-3.5 shrink-0" />;
}

function issuePromptLine(issue: SpecAuditIssue): string {
  return `- [${issue.severity}/${issue.area}] ${issue.title}: ${issue.detail}`;
}

function buildSpecialistPrompt(spec: AppSpec, issues: SpecAuditIssue[], score: number): string {
  const top = issues.slice(0, 8).map(issuePromptLine).join('\n') || '- Nenhuma pendencia critica detectada.';
  return [
    'Abra uma revisao especializada do plano do App Studio.',
    'Objetivo: melhorar a spec antes do build, em linguagem simples para usuario leigo.',
    '',
    `App: ${spec.summary}`,
    `Publico: ${spec.audience}`,
    `Saude atual da spec: ${score}/100`,
    '',
    'Pontos detectados pela auditoria:',
    top,
    '',
    'Use app_get_pipeline, app_get_spec e app_spec_audit para se ancorar. Se faltar decisao do usuario, faca UMA pergunta por vez com ask_user.',
    'Se discovery ainda nao estiver aprovada, salve a spec completa com app_save_spec incluindo requirements.goals, requirements.acceptance_criteria, requirements.business_rules e requirements.out_of_scope.',
    'Se discovery ja estiver aprovada, proponha uma revisao com app_propose_spec_revision em vez de sobrescrever a spec aprovada.',
  ].join('\n');
}

function requirementCount(spec: AppSpec): number {
  const r = spec.requirements;
  if (!r) return 0;
  return [
    r.goals,
    r.business_rules,
    r.acceptance_criteria,
    r.out_of_scope,
    r.assumptions,
    r.risks,
  ].reduce((sum, items) => sum + (items?.length ?? 0), 0);
}

export function SpecOverviewPanel({ spec, onOpenSpecAgent }: SpecOverviewPanelProps) {
  const { t } = useTranslation('appStudio');
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem(OVERVIEW_COLLAPSED_KEY) === '1';
    } catch {
      return false;
    }
  });
  const report = useMemo(() => auditAppSpec(spec), [spec]);
  const topIssues = report.issues.slice(0, 5);
  const prompt = useMemo(() => buildSpecialistPrompt(spec, report.issues, report.score), [spec, report]);
  const counts = [
    { label: t('blueprint.overview.counts.features'), value: spec.features.length },
    { label: t('blueprint.overview.counts.screens'), value: spec.screens.length },
    { label: t('blueprint.overview.counts.data'), value: spec.database.entities.length },
    { label: t('blueprint.overview.counts.actions'), value: spec.behaviors?.length ?? 0 },
  ];
  const reqCount = requirementCount(spec);
  const scoreClass = cn(
    'rounded-full border px-2 py-0.5 text-[11px] font-semibold',
    report.score >= 80
      ? 'border-green-300 bg-green-50 text-green-700 dark:border-green-400/30 dark:bg-green-950/25 dark:text-green-200'
      : report.score >= 55
        ? 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-400/30 dark:bg-amber-950/25 dark:text-amber-200'
        : 'border-red-300 bg-red-50 text-red-700 dark:border-red-400/30 dark:bg-red-950/25 dark:text-red-200',
  );
  const setOverviewCollapsed = (next: boolean) => {
    setCollapsed(next);
    try {
      window.localStorage.setItem(OVERVIEW_COLLAPSED_KEY, next ? '1' : '0');
    } catch {
      /* ignore */
    }
  };

  if (collapsed) {
    return (
      <aside
        className="flex h-full w-11 shrink-0 flex-col items-center gap-1 border-l bg-card/80 py-1.5"
        aria-label={t('blueprint.overview.title')}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => setOverviewCollapsed(false)}
              className="relative grid h-8 w-8 place-items-center rounded-md bg-accent text-accent-foreground shadow-sm transition-colors hover:bg-accent/90"
              aria-label={t('blueprint.overview.expand')}
              aria-current="page"
            >
              <PanelRightOpen className="h-4 w-4" />
              <span aria-hidden className="absolute -right-1 top-1.5 bottom-1.5 w-0.5 rounded-full bg-primary" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="left">{t('blueprint.overview.expand')}</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <div
              className={cn(
                'mt-1 grid h-8 w-8 place-items-center rounded-md border text-[10px] font-semibold',
                report.score >= 80
                  ? 'border-green-300 bg-green-50 text-green-700 dark:border-green-400/30 dark:bg-green-950/25 dark:text-green-200'
                  : report.score >= 55
                    ? 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-400/30 dark:bg-amber-950/25 dark:text-amber-200'
                    : 'border-red-300 bg-red-50 text-red-700 dark:border-red-400/30 dark:bg-red-950/25 dark:text-red-200',
              )}
            >
              {report.score}
            </div>
          </TooltipTrigger>
          <TooltipContent side="left">
            {t('blueprint.overview.health')}: {report.score}/100
          </TooltipContent>
        </Tooltip>

        <div className="min-h-2 flex-1" />

        {onOpenSpecAgent && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => onOpenSpecAgent(prompt)}
                aria-label={t('blueprint.overview.openAgent')}
              >
                <Bot className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left">{t('blueprint.overview.openAgent')}</TooltipContent>
          </Tooltip>
        )}
      </aside>
    );
  }

  return (
    <aside className="flex h-full w-80 shrink-0 flex-col border-l bg-card">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
        <FileText className="h-4 w-4 text-primary" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold">{t('blueprint.overview.title')}</h2>
        </div>
        <span className={scoreClass}>{report.score}/100</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => setOverviewCollapsed(true)}
              aria-label={t('blueprint.overview.collapse')}
            >
              <PanelRightClose className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">{t('blueprint.overview.collapse')}</TooltipContent>
        </Tooltip>
      </header>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
        <section className="space-y-2">
          <p className="flex items-center gap-1.5 text-xs font-semibold uppercase text-muted-foreground">
            <Target className="h-3.5 w-3.5" />
            {t('blueprint.overview.idea')}
          </p>
          <p className="text-sm leading-relaxed">{spec.summary}</p>
          <p className="text-xs text-muted-foreground">{spec.audience}</p>
        </section>

        <section className="grid grid-cols-2 gap-2">
          {counts.map((item) => (
            <div key={item.label} className="rounded-md border bg-background px-2 py-1.5">
              <div className="text-lg font-semibold leading-none">{item.value}</div>
              <div className="mt-1 truncate text-[11px] text-muted-foreground">{item.label}</div>
            </div>
          ))}
        </section>

        <section className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-semibold uppercase text-muted-foreground">{t('blueprint.overview.requirements')}</p>
            <span className="text-[11px] text-muted-foreground">
              {t('blueprint.overview.requirementsCount', { count: reqCount })}
            </span>
          </div>
          {reqCount > 0 ? (
            <div className="space-y-1.5 text-xs">
              {(spec.requirements?.goals ?? []).slice(0, 2).map((goal) => (
                <p key={goal} className="rounded-md border bg-background px-2 py-1.5">{goal}</p>
              ))}
              {(spec.requirements?.acceptance_criteria ?? []).slice(0, 2).map((criteria) => (
                <p key={criteria} className="rounded-md border bg-background px-2 py-1.5">
                  <CheckCircle2 className="mr-1 inline h-3 w-3 text-green-600" />
                  {criteria}
                </p>
              ))}
            </div>
          ) : (
            <p className="rounded-md border border-dashed bg-background px-2 py-2 text-xs text-muted-foreground">
              {t('blueprint.overview.noRequirements')}
            </p>
          )}
        </section>

        <section className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-semibold uppercase text-muted-foreground">{t('blueprint.overview.health')}</p>
            <span className="text-[11px] text-muted-foreground">
              {report.counts.error} / {report.counts.warning} / {report.counts.info}
            </span>
          </div>
          {topIssues.length > 0 ? (
            <div className="space-y-1.5">
              {topIssues.map((issue) => (
                <div key={issue.id} className={cn('rounded-md border px-2 py-1.5 text-xs', SEVERITY_CLASS[issue.severity])}>
                  <div className="flex items-center gap-1.5 font-medium">
                    <IssueIcon severity={issue.severity} />
                    <span className="min-w-0 truncate">{issue.title}</span>
                  </div>
                  <p className="mt-1 leading-relaxed opacity-90">{issue.detail}</p>
                </div>
              ))}
            </div>
          ) : (
            <p className="rounded-md border bg-background px-2 py-2 text-xs text-muted-foreground">
              {t('blueprint.overview.noIssues')}
            </p>
          )}
        </section>
      </div>

      <footer className="shrink-0 border-t p-2">
        <Button className="w-full justify-center gap-2" size="sm" onClick={() => onOpenSpecAgent?.(prompt)}>
          <Bot className="h-4 w-4" />
          {t('blueprint.overview.openAgent')}
        </Button>
      </footer>
    </aside>
  );
}
