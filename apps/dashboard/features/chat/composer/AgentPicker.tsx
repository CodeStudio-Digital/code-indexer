import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot, Compass, ClipboardList, Database, Hammer, ShieldAlert, Sparkles, ScrollText, Webhook, Workflow } from 'lucide-react';
import { Combobox, type ComboboxOption } from '../../../components/ui/combobox.js';
import type { AgentPreset, BuiltInAgentPreset } from '@mcp/api-bus';

/**
 * AgentPicker — compact combobox that selects one of the built-in agent
 * presets (explore / plan / build / admin). Mirrors the CLI `--agent` flag.
 *
 * UX:
 * - Fetches /api/coder/agents once at mount to get the live list (resilient
 *   to the server adding new presets without a dashboard rebuild).
 * - When `autoSuggestFor` is set, debounces a call to
 *   /api/coder/classify-intent and shows a soft "Sparkles" hint next to the
 *   current selection if the heuristic recommends a different agent. Users
 *   keep control — the hint never auto-mutates `value`.
 */

interface AgentDef {
  id: AgentPreset;
  label?: string;
  description: string;
  profile: string;
  planMode: boolean;
  custom?: boolean;
  baseAgentId?: BuiltInAgentPreset;
}

type AgentId = AgentPreset;

const AGENT_LABEL: Record<BuiltInAgentPreset, string> = {
  explore: 'Explore',
  plan: 'Plan',
  build: 'Code',
  admin: 'Ops',
  spec: 'Spec Doc',
  app_orchestrator: 'App Coordinator',
  app_db: 'Database',
  api: 'API Test',
  diagram: 'Diagram',
  builder: 'UI Builder',
};

const AGENT_PROMISE: Record<BuiltInAgentPreset, string> = {
  explore: 'Answers, not edits',
  plan: 'Proposes a plan, waits for OK',
  build: 'Edits, verifies, reports',
  admin: 'Commits, snapshots, ops - asks first',
  spec: 'Writes a spec, waits for approval',
  app_orchestrator: 'Coordinates scope, blueprint, Kanban, verification, and release',
  app_db: 'Inspects schemas and data safely',
  api: 'Tests the API, fixes the spec',
  diagram: 'Draws .drawio diagrams of the design',
  builder: 'Builds the live app UI',
};

const ICONS: Record<BuiltInAgentPreset, React.ComponentType<{ className?: string }>> = {
  explore: Compass,
  plan: ClipboardList,
  build: Hammer,
  admin: ShieldAlert,
  spec: ScrollText,
  app_orchestrator: Bot,
  app_db: Database,
  api: Webhook,
  diagram: Workflow,
  builder: Hammer,
};

// Tailwind text-color class per mode — applied to the leading icon so the
// composer at a glance signals which mode is active.
const MODE_TINT: Record<BuiltInAgentPreset, string> = {
  explore: 'text-sky-500',
  plan: 'text-violet-500',
  build: 'text-emerald-500',
  admin: 'text-rose-500',
  spec: 'text-amber-500',
  app_orchestrator: 'text-violet-500',
  app_db: 'text-teal-500',
  api: 'text-cyan-500',
  diagram: 'text-violet-500',
  builder: 'text-fuchsia-500',
};

interface AgentPickerProps {
  value: AgentId;
  onChange: (id: AgentId) => void;
  /** When set, the picker debounced-calls /api/coder/classify-intent and renders a suggestion hint. */
  autoSuggestFor?: string;
}

export function AgentPicker({ value, onChange, autoSuggestFor }: AgentPickerProps) {
  const { t } = useTranslation('chat');
  const [agents, setAgents] = useState<AgentDef[] | null>(null);
  const [suggestion, setSuggestion] = useState<AgentId | null>(null);

  const agentLabel = (id: AgentId, fallback?: string) => {
    if (id.startsWith('custom:')) return fallback ?? agents?.find((agent) => agent.id === id)?.label ?? t('agentPicker.customAgent');
    const builtIn = id as BuiltInAgentPreset;
    return t(`agentPicker.labels.${builtIn}`, { defaultValue: fallback ?? AGENT_LABEL[builtIn] ?? capitalise(id) });
  };
  const agentPromise = (id: AgentId, fallback?: string) => {
    if (id.startsWith('custom:')) return fallback ?? agents?.find((agent) => agent.id === id)?.description ?? '';
    const builtIn = id as BuiltInAgentPreset;
    return t(`agentPicker.promises.${builtIn}`, { defaultValue: fallback ?? AGENT_PROMISE[builtIn] ?? '' });
  };

  useEffect(() => {
    let aborted = false;
    const load = () => {
      fetch('/api/coder/agents')
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (aborted || !data) return;
          if (Array.isArray(data.agents)) setAgents(data.agents as AgentDef[]);
        })
        .catch(() => {
          /* network hiccup is non-fatal — the combobox stays empty and the
             parent should fall back to 'explore' */
        });
    };
    load();
    window.addEventListener('coder:custom-agents-changed', load);
    return () => {
      aborted = true;
      window.removeEventListener('coder:custom-agents-changed', load);
    };
  }, []);

  // Debounced intent classifier — 350ms after typing stops we call
  // /api/coder/classify-intent and stash the recommendation. We never
  // mutate `value` ourselves; the hint is advisory only.
  useEffect(() => {
    if (!autoSuggestFor || autoSuggestFor.length < 4) {
      setSuggestion(null);
      return;
    }
    const controller = new AbortController();
    const handle = setTimeout(async () => {
      try {
        const res = await fetch('/api/coder/classify-intent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: autoSuggestFor }),
          signal: controller.signal,
        });
        if (!res.ok) return;
        const data = (await res.json()) as { agent?: AgentId };
        if (data.agent && data.agent !== value) {
          setSuggestion(data.agent);
        } else {
          setSuggestion(null);
        }
      } catch {
        /* ignore abort / network */
      }
    }, 350);
    return () => {
      clearTimeout(handle);
      controller.abort();
    };
  }, [autoSuggestFor, value]);

  const options = useMemo<ComboboxOption[]>(() => {
    const source =
      agents ??
      ([
        { id: 'explore', label: AGENT_LABEL.explore, description: t('agentPicker.bootstrap'), profile: 'bootstrap', planMode: false },
        { id: 'plan', label: AGENT_LABEL.plan, description: t('agentPicker.navigate'), profile: 'navigate', planMode: true },
        { id: 'build', label: AGENT_LABEL.build, description: t('agentPicker.navigateFull'), profile: 'navigate', planMode: false },
        { id: 'admin', label: AGENT_LABEL.admin, description: t('agentPicker.full'), profile: 'full', planMode: false },
        { id: 'spec', label: AGENT_LABEL.spec, description: t('agentPicker.spec', { defaultValue: 'Spec-driven authoring - pauses for human approval before code.' }), profile: 'navigate', planMode: false },
        { id: 'app_orchestrator', label: AGENT_LABEL.app_orchestrator, description: agentPromise('app_orchestrator'), profile: 'navigate', planMode: false },
        { id: 'app_db', label: AGENT_LABEL.app_db, description: agentPromise('app_db'), profile: 'bootstrap', planMode: false },
        { id: 'builder', label: AGENT_LABEL.builder, description: agentPromise('builder'), profile: 'navigate', planMode: false },
        { id: 'api', label: AGENT_LABEL.api, description: agentPromise('api'), profile: 'navigate', planMode: false },
        { id: 'diagram', label: AGENT_LABEL.diagram, description: agentPromise('diagram'), profile: 'navigate', planMode: false },
      ] satisfies AgentDef[]);
    return source.map((a) => ({
      value: a.id,
      label: agentLabel(a.id, a.label),
      // Promise-first description: what the mode delivers, not what
      // tier it sits in. Stacks BELOW the label inside Combobox rows so
      // long copy ("Commits, snapshots, ops — asks first") doesn't
      // squeeze the label column down to "PL…" / "S…" as it did when
      // we used `hint` (which competes side-by-side).
      description: agentPromise(a.id, a.description.split('.')[0]),
    }));
  }, [agents, t]);

  // Defensive: never render <undefined/> if `value` is somehow unmapped
  // (a stale persisted agent id predating the validation guards, or a dep
  // hiccup during a dev re-optimization). Fall back to the explore icon so a
  // single missing glyph can't white-screen the whole composer.
  const SelectedIcon = value.startsWith('custom:') ? Bot : (ICONS[value as BuiltInAgentPreset] ?? Compass);
  const SuggestionIcon = suggestion
    ? suggestion.startsWith('custom:') ? Bot : ICONS[suggestion as BuiltInAgentPreset]
    : null;
  const selectedPromise = agentPromise(value, agents?.find((agent) => agent.id === value)?.description);
  const suggestionLabel = suggestion ? agentLabel(suggestion) : '';

  return (
    <div className="flex items-center gap-1.5">
      <div
        className={`flex items-center gap-1 text-xs ${value.startsWith('custom:') ? 'text-indigo-500' : (MODE_TINT[value as BuiltInAgentPreset] ?? 'text-muted-foreground')}`}
        title={selectedPromise}
      >
        <SelectedIcon className="h-3.5 w-3.5" />
      </div>
      <div className="w-[108px]">
        <Combobox
          value={value}
          onChange={(v) => onChange(v as AgentId)}
          options={options}
          placeholder={t('toolbar.agent')}
          searchPlaceholder={t('toolbar.searchAgent')}
          emptyLabel={t('toolbar.noAgent')}
          // Trigger is narrow (108px) but the dropdown needs room for
          // promise descriptions like "Commits, snapshots, ops — asks
          // first". 19rem ≈ 304px fits the longest line at text-[10px].
          contentClassName="min-w-[19rem]"
        />
      </div>
      {suggestion && SuggestionIcon && (
        <button
          type="button"
          onClick={() => {
            onChange(suggestion);
            setSuggestion(null);
          }}
          className="flex items-center gap-1 text-[10px] text-amber-600 dark:text-amber-400 hover:underline"
          title={t('agentPicker.suggestionTooltip', { suggestion: suggestionLabel })}
        >
          <Sparkles className="h-3 w-3" />
          <span>{t('agentPicker.suggestion', { suggestion: suggestionLabel })}</span>
        </button>
      )}
    </div>
  );
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
