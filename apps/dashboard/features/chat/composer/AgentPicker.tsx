import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot, Boxes, Compass, ClipboardList, Database, Hammer, Layers3, Palette, ShieldAlert, Sparkles, ScrollText, Webhook, Workflow } from 'lucide-react';
import { Combobox, type ComboboxOption } from '../../../components/ui/combobox.js';
import type { AgentPreset } from '@mcp/api-bus';

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
}

type AgentId = AgentPreset;

const AGENT_LABEL: Record<AgentId, string> = {
  explore: 'Explore',
  plan: 'Plan',
  build: 'Code',
  admin: 'Ops',
  spec: 'Spec Doc',
  app_spec: 'App Plan',
  app_db: 'Data Model',
  app_architect: 'App Architecture',
  app_product: 'Product Model',
  app_ux: 'App UX',
  app_wireframe: 'App Wireframes',
  api: 'API Test',
  diagram: 'Diagram',
  builder: 'UI Builder',
};

const AGENT_PROMISE: Record<AgentId, string> = {
  explore: 'Answers, not edits',
  plan: 'Proposes a plan, waits for OK',
  build: 'Edits, verifies, reports',
  admin: 'Commits, snapshots, ops - asks first',
  spec: 'Writes a spec, waits for approval',
  app_spec: 'Refines App Studio requirements',
  app_db: 'Analyzes App Studio data',
  app_architect: 'Plans the App Studio architecture and test contract',
  app_product: 'Maps domains, capabilities, scope horizons, and scenarios',
  app_ux: 'Defines the App Studio visual direction and accessibility contract',
  app_wireframe: 'Plans user flows, wireframes, UI tests, and build groups',
  api: 'Tests the API, fixes the spec',
  diagram: 'Draws .drawio diagrams of the design',
  builder: 'Builds the live app UI',
};

const ICONS: Record<AgentId, React.ComponentType<{ className?: string }>> = {
  explore: Compass,
  plan: ClipboardList,
  build: Hammer,
  admin: ShieldAlert,
  spec: ScrollText,
  app_spec: Bot,
  app_db: Database,
  app_architect: Boxes,
  app_product: Layers3,
  app_ux: Palette,
  app_wireframe: Workflow,
  api: Webhook,
  diagram: Workflow,
  builder: Hammer,
};

// Tailwind text-color class per mode — applied to the leading icon so the
// composer at a glance signals which mode is active.
const MODE_TINT: Record<AgentId, string> = {
  explore: 'text-sky-500',
  plan: 'text-violet-500',
  build: 'text-emerald-500',
  admin: 'text-rose-500',
  spec: 'text-amber-500',
  app_spec: 'text-indigo-500',
  app_db: 'text-teal-500',
  app_architect: 'text-blue-500',
  app_product: 'text-emerald-500',
  app_ux: 'text-pink-500',
  app_wireframe: 'text-violet-500',
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

  const agentLabel = (id: AgentId, fallback?: string) =>
    t(`agentPicker.labels.${id}`, { defaultValue: fallback ?? AGENT_LABEL[id] ?? capitalise(id) });
  const agentPromise = (id: AgentId, fallback?: string) =>
    t(`agentPicker.promises.${id}`, { defaultValue: fallback ?? AGENT_PROMISE[id] ?? '' });

  useEffect(() => {
    let aborted = false;
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
    return () => {
      aborted = true;
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
        { id: 'app_spec', label: AGENT_LABEL.app_spec, description: agentPromise('app_spec'), profile: 'bootstrap', planMode: false },
        { id: 'app_db', label: AGENT_LABEL.app_db, description: agentPromise('app_db'), profile: 'bootstrap', planMode: false },
        { id: 'app_architect', label: AGENT_LABEL.app_architect, description: agentPromise('app_architect'), profile: 'bootstrap', planMode: false },
        { id: 'app_product', label: AGENT_LABEL.app_product, description: agentPromise('app_product'), profile: 'bootstrap', planMode: false },
        { id: 'app_ux', label: AGENT_LABEL.app_ux, description: agentPromise('app_ux'), profile: 'bootstrap', planMode: false },
        { id: 'app_wireframe', label: AGENT_LABEL.app_wireframe, description: agentPromise('app_wireframe'), profile: 'bootstrap', planMode: false },
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
  const SelectedIcon = ICONS[value] ?? Compass;
  const SuggestionIcon = suggestion ? ICONS[suggestion] : null;
  const selectedPromise = agentPromise(value);
  const suggestionLabel = suggestion ? agentLabel(suggestion) : '';

  return (
    <div className="flex items-center gap-1.5">
      <div
        className={`flex items-center gap-1 text-xs ${MODE_TINT[value] ?? 'text-muted-foreground'}`}
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
