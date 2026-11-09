/** Plan criteria and verdicts from the same persisted QA run. */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Markdown } from '../../../chat/messages/Markdown.js';
import {
  AnnotatedSection,
  AnnotatedScenario,
} from '@mcp/services/qa/parsers/match-plan-to-results.js';
import {
  formatTestStatus,
  type StatusVisual,
} from '@mcp/services/qa/parsers/run-status-format.js';
import { useTestPlan } from './useTestPlan.js';

interface Props {
  sessionId: string;
  serviceId?: string;
}

export function TestPlanView({ sessionId, serviceId }: Props) {
  const { t } = useTranslation('agents');
  const { loading, error, data, refresh } = useTestPlan(sessionId, serviceId);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
        {t('qa.planLoading')}
      </div>
    );
  }

  if (error) {
    return (
      <div role="alert" className="m-4 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm">
        <p className="font-medium text-destructive">{t('qa.planError')}</p>
        <p className="mt-1 break-words text-xs text-muted-foreground">{error}</p>
        <button onClick={() => void refresh()} className="ml-2 underline">
          {t('qa.planRetry')}
        </button>
      </div>
    );
  }

  if (!data?.plan.exists) {
    return (
      <div className="flex flex-col items-center justify-center px-6 py-8 text-center">
        <h3 className="text-sm font-semibold">{t('qa.planEmpty')}</h3>
        <p className="text-sm text-muted-foreground mt-2 max-w-md">
          {t('qa.planEmptyHint')}
        </p>
        <button onClick={() => void refresh()} className="text-xs underline mt-3">
          {t('qa.planRefresh')}
        </button>
      </div>
    );
  }

  return (
    <div className="overflow-auto p-4 space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium text-muted-foreground">{t(data.plan.source === 'preview' ? 'qa.planPreview' : 'qa.planWorkspace')}</p>
          {data.plan.target_url && <p className="mt-1 break-all text-xs text-muted-foreground">{data.plan.target_url}</p>}
        </div>
        <button type="button" onClick={() => void refresh()} className="shrink-0 text-xs underline">{t('qa.planRefresh')}</button>
      </div>
      {data.resultsUnavailable && <p role="status" className="text-xs text-muted-foreground">{t('qa.planResultsUnavailable')}</p>}
      {data.sections.length === 0 ? <Markdown text={data.plan.content} /> : data.sections.map((s) => (
        <PlanSection key={s.heading} section={s} />
      ))}
    </div>
  );
}

function PlanSection({ section }: { section: AnnotatedSection }) {
  return (
    <section>
      <header className="flex items-center gap-2 mb-2">
        <h4 className="text-sm font-semibold">{section.heading}</h4>
        {section.priority && (
          <span className="text-[10px] uppercase tracking-wide bg-muted px-1.5 py-0.5 rounded">
            {section.priority}
          </span>
        )}
      </header>
      <ul className="space-y-1 ml-2">
        {section.scenarios.map((scenario, idx) => (
          <ScenarioRow key={idx} scenario={scenario} />
        ))}
      </ul>
    </section>
  );
}

function ScenarioRow({ scenario }: { scenario: AnnotatedScenario }) {
  const visual = scenarioVisual(scenario);
  return (
    <li className="text-sm flex items-start gap-2">
      <span className={`flex-shrink-0 ${visual.toneClass}`} aria-label={visual.label}>
        {visual.icon}
      </span>
      <div className="flex-1 min-w-0">
        <span>{scenario.text}</span>
        {scenario.specFile && (
          <span className="ml-2 text-[11px] text-muted-foreground">
            <code className="bg-muted px-1 rounded">{scenario.specFile}</code>
          </span>
        )}
      </div>
    </li>
  );
}

function scenarioVisual(scenario: AnnotatedScenario): StatusVisual | { icon: '○'; label: string; toneClass: 'text-zinc-400' } {
  if (scenario.verdict === 'not-run') {
    return { icon: '○', label: 'Not run yet', toneClass: 'text-zinc-400' };
  }
  return formatTestStatus(scenario.verdict);
}
