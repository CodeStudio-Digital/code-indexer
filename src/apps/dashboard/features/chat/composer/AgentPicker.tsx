import { useEffect, useMemo, useState } from 'react';
import { Compass, ClipboardList, Hammer, ShieldAlert, Sparkles } from 'lucide-react';
import { Combobox, type ComboboxOption } from '../../../components/ui/combobox.js';

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
  id: 'explore' | 'plan' | 'build' | 'admin';
  description: string;
  profile: string;
  planMode: boolean;
}

type AgentId = AgentDef['id'];

const ICONS: Record<AgentId, React.ComponentType<{ className?: string }>> = {
  explore: Compass,
  plan: ClipboardList,
  build: Hammer,
  admin: ShieldAlert,
};

interface AgentPickerProps {
  value: AgentId;
  onChange: (id: AgentId) => void;
  /** When set, the picker debounced-calls /api/coder/classify-intent and renders a suggestion hint. */
  autoSuggestFor?: string;
}

export function AgentPicker({ value, onChange, autoSuggestFor }: AgentPickerProps) {
  const [agents, setAgents] = useState<AgentDef[] | null>(null);
  const [suggestion, setSuggestion] = useState<AgentId | null>(null);

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
        { id: 'explore', description: 'Read-only investigation (bootstrap tier)', profile: 'bootstrap', planMode: false },
        { id: 'plan', description: 'Read + plan mode (navigate tier)', profile: 'navigate', planMode: true },
        { id: 'build', description: 'Read + edit + shell (navigate tier)', profile: 'navigate', planMode: false },
        { id: 'admin', description: 'Everything (full tier)', profile: 'full', planMode: false },
      ] satisfies AgentDef[]);
    return source.map((a) => ({
      value: a.id,
      label: capitalise(a.id),
      hint: a.description.split('.')[0],
    }));
  }, [agents]);

  const SelectedIcon = ICONS[value];
  const SuggestionIcon = suggestion ? ICONS[suggestion] : null;

  return (
    <div className="flex items-center gap-1.5">
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        <SelectedIcon className="h-3.5 w-3.5" />
      </div>
      <div className="w-[108px]">
        <Combobox
          value={value}
          onChange={(v) => onChange(v as AgentId)}
          options={options}
          placeholder="Agent"
          searchPlaceholder="Search agent…"
          emptyLabel="No agent"
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
          title={`Your message looks like it needs the '${suggestion}' agent. Click to switch.`}
        >
          <Sparkles className="h-3 w-3" />
          <span>try {suggestion}</span>
        </button>
      )}
    </div>
  );
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
