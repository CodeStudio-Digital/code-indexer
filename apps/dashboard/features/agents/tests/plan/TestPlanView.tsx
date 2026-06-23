/**
 * Read-only Test Plan view (v1). Renders the parsed sections with each
 * scenario annotated by its latest verdict (cross-referenced with the
 * most recent run's results). The future inline editor swaps this
 * component out — the hook (`useTestPlan`) already exposes `save`.
 */
import React from 'react';
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
  sessionId: number;
}

export function TestPlanView({ sessionId }: Props) {
  const { loading, error, exists, sections, refresh } = useTestPlan(sessionId);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
        Loading test plan…
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 text-sm text-red-600">
        Failed: {error}
        <button onClick={() => void refresh()} className="ml-2 underline">
          Retry
        </button>
      </div>
    );
  }

  if (!exists || sections.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center px-6 py-8 text-center">
        <h3 className="text-sm font-semibold">Test plan</h3>
        <p className="text-sm text-muted-foreground mt-2 max-w-md">
          The QA agent persists the plan at{' '}
          <code className="bg-muted px-1 rounded text-xs">tests/e2e/TEST_PLAN.md</code>{' '}
          inside the sandbox. Spawn the QA agent — it will draft the plan and submit it
          for your approval.
        </p>
        <button onClick={() => void refresh()} className="text-xs underline mt-3">
          Refresh
        </button>
      </div>
    );
  }

  return (
    <div className="overflow-auto p-4 space-y-5">
      {sections.map((s) => (
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

function scenarioVisual(scenario: AnnotatedScenario): StatusVisual {
  if (scenario.verdict === 'not-run') {
    return { icon: '○', label: 'Not run yet', toneClass: 'text-zinc-400' } as StatusVisual;
  }
  return formatTestStatus(scenario.verdict);
}
