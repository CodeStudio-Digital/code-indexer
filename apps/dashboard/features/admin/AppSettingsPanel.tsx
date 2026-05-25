/**
 * AppSettingsPanel — admin section for the env-var catalog
 * (`packages/store/src/app-settings-catalog.ts` + migration 105).
 *
 * UX goals:
 *   - Default landing shows ~15 essentials (non-advanced); a toggle
 *     reveals the long tail of tuning knobs.
 *   - Group by category (LLM / MCP / Agent / Company / Debug) with
 *     collapsible sections so the page doesn't feel infinite.
 *   - Show provenance per row: "from admin" (saved in DB), "from .env"
 *     (legacy / dev override), "default" (catalog fallback). Helps the
 *     operator understand where a value came from.
 *   - Restart-needed pill next to fields that won't hot-apply. A
 *     "Restart backend" button enables once any restart-required
 *     setting has been edited.
 *   - Single save button at the bottom — the form buffers edits and
 *     the PUT is one transaction (cheaper + cleaner audit log).
 */
import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  Loader2,
  RefreshCw,
  RotateCcw,
} from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Switch } from '../../components/ui/switch.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select.js';
import { Badge } from '../../components/ui/badge.js';
import { cn } from '../../lib/utils.js';
import { toast } from '../../components/ui/prompt-dialog.js';

type SettingType = 'string' | 'bool' | 'int' | 'float' | 'url' | 'secret';
type SettingCategory = 'llm' | 'mcp' | 'agent' | 'company' | 'debug';
type Source = 'db' | 'env' | 'default' | 'unset';

interface SettingItem {
  key: string;
  label: string;
  description: string;
  type: SettingType;
  category: SettingCategory;
  advanced: boolean;
  restartNeeded: boolean;
  options?: readonly string[];
  min?: number;
  max?: number;
  default: string | null;
  source: Source;
  updatedAt: string | null;
  /** Non-secret current value (catalog default / env / DB). Null for secrets. */
  value: string | null;
  /** For secrets: indicates whether anything is stored (without revealing it). */
  hasValue: boolean;
}

interface CategoryDef {
  id: SettingCategory;
  label: string;
}

interface SettingsResponse {
  items: SettingItem[];
  categories: readonly CategoryDef[];
}

/**
 * Track edits as a sparse map: only keys the user touched land here.
 * Saving sends only these entries — anything untouched keeps its
 * existing DB / env / default resolution.
 */
type EditMap = Record<string, string | null>;

export function AppSettingsPanel() {
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [edits, setEdits] = useState<EditMap>({});
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/admin/settings');
      if (!r.ok) throw new Error(`fetch failed (${r.status})`);
      const j = (await r.json()) as SettingsResponse;
      setData(j);
      setError(null);
      setEdits({}); // clear pending edits on reload
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const grouped = useMemo(() => {
    if (!data) return null;
    const byCategory = new Map<SettingCategory, SettingItem[]>();
    for (const item of data.items) {
      if (!showAdvanced && item.advanced) continue;
      const list = byCategory.get(item.category) ?? [];
      list.push(item);
      byCategory.set(item.category, list);
    }
    return byCategory;
  }, [data, showAdvanced]);

  const dirtyCount = Object.keys(edits).length;
  const restartNeeded = useMemo(() => {
    if (!data) return false;
    return Object.keys(edits).some((k) => data.items.find((i) => i.key === k)?.restartNeeded);
  }, [data, edits]);

  const setEdit = (key: string, value: string | null) => {
    setEdits((prev) => ({ ...prev, [key]: value }));
  };

  const clearEdit = (key: string) => {
    setEdits((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const save = async () => {
    if (dirtyCount === 0) return;
    setSaving(true);
    try {
      const r = await fetch('/api/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates: edits }),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `save failed (${r.status})`);
      }
      const j = (await r.json()) as { restartNeeded?: boolean };
      toast.success(`Saved ${dirtyCount} setting${dirtyCount === 1 ? '' : 's'}`, {
        description: j.restartNeeded
          ? 'Some changes require a backend restart to take effect.'
          : 'Changes applied immediately.',
      });
      await load();
    } catch (e) {
      toast.error('Save failed', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  };

  const restart = async () => {
    try {
      const r = await fetch('/api/admin/settings/restart', { method: 'POST' });
      if (!r.ok && r.status !== 202) throw new Error(`HTTP ${r.status}`);
      toast.message('Restarting backend…', {
        description: 'The Electron host will spawn a fresh http-api process in a moment.',
      });
    } catch (e) {
      toast.error('Restart failed', { description: e instanceof Error ? e.message : String(e) });
    }
  };

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  if (error && !data) {
    return <div className="text-sm text-destructive p-4">{error}</div>;
  }
  if (!data || !grouped) return null;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">Configurações</h2>
          <p className="text-sm text-muted-foreground">
            Configurações persistidas no banco; substituem o <code className="font-mono">.env</code> pra
            quem instalou o desktop. Mudanças hot-apply quando possível; campos com badge{' '}
            <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400 text-xs">
              <AlertTriangle className="h-3 w-3" /> reiniciar
            </span>{' '}
            exigem restart do backend.
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading || saving}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
        </Button>
      </div>

      <div className="flex items-center gap-2 text-sm">
        <label className="flex items-center gap-2 cursor-pointer">
          <Switch checked={showAdvanced} onCheckedChange={setShowAdvanced} />
          <span>Mostrar avançadas</span>
        </label>
        <span className="text-muted-foreground text-xs ml-2">
          ({data.items.filter((i) => !i.advanced).length} essenciais ·{' '}
          {data.items.filter((i) => i.advanced).length} avançadas)
        </span>
      </div>

      <div className="space-y-3">
        {data.categories.map((cat) => {
          const items = grouped.get(cat.id) ?? [];
          if (items.length === 0) return null;
          const isCollapsed = collapsed[cat.id] ?? false;
          return (
            <div key={cat.id} className="rounded-md border bg-card/40">
              <button
                type="button"
                onClick={() => setCollapsed((c) => ({ ...c, [cat.id]: !isCollapsed }))}
                className="w-full px-3 py-2 flex items-center gap-2 text-sm hover:bg-muted/30 transition-colors"
              >
                {isCollapsed ? (
                  <ChevronRight className="h-3.5 w-3.5" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5" />
                )}
                <span className="font-semibold">{cat.label}</span>
                <span className="text-xs text-muted-foreground ml-auto">{items.length}</span>
              </button>
              {!isCollapsed && (
                <div className="border-t divide-y">
                  {items.map((item) => (
                    <SettingRow
                      key={item.key}
                      item={item}
                      edit={edits[item.key]}
                      onChange={(v) => setEdit(item.key, v)}
                      onClear={() => clearEdit(item.key)}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Sticky save bar */}
      <div className="sticky bottom-0 -mx-3 px-3 py-3 bg-background/95 backdrop-blur border-t flex items-center gap-2">
        <div className="text-xs text-muted-foreground flex-1">
          {dirtyCount > 0 ? (
            <>
              <Check className="inline h-3 w-3 mr-1 text-emerald-500" />
              {dirtyCount} alteração{dirtyCount === 1 ? '' : 'ões'} pendente{dirtyCount === 1 ? '' : 's'}
            </>
          ) : (
            'Nenhuma alteração pendente'
          )}
        </div>
        {restartNeeded && (
          <Button variant="outline" size="sm" onClick={() => void restart()}>
            <AlertTriangle className="h-3.5 w-3.5 mr-1.5 text-amber-500" />
            Reiniciar backend
          </Button>
        )}
        <Button size="sm" onClick={() => void save()} disabled={dirtyCount === 0 || saving}>
          {saving ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : null}
          Salvar {dirtyCount > 0 ? `(${dirtyCount})` : ''}
        </Button>
      </div>
    </div>
  );
}

function SettingRow({
  item,
  edit,
  onChange,
  onClear,
}: {
  item: SettingItem;
  edit: string | null | undefined;
  onChange: (v: string | null) => void;
  onClear: () => void;
}) {
  const dirty = edit !== undefined;
  // For non-secrets, the source-of-truth display value:
  // - dirty (user has typed something this session) → edit
  // - otherwise → server-side resolved value
  const displayValue = dirty ? edit ?? '' : item.value ?? '';

  return (
    <div className="px-3 py-2.5 flex items-start gap-3">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono text-[11.5px] text-foreground">{item.key}</span>
          <span className="text-[12px] text-muted-foreground">{item.label}</span>
          {item.restartNeeded && (
            <Badge
              variant="outline"
              className="border-amber-500/40 text-amber-600 dark:text-amber-400 text-[9.5px] px-1.5 py-0 h-4"
            >
              <AlertTriangle className="h-2.5 w-2.5 mr-1" />
              reiniciar
            </Badge>
          )}
          {item.advanced && (
            <Badge variant="secondary" className="text-[9.5px] px-1.5 py-0 h-4">
              advanced
            </Badge>
          )}
          <SourceBadge source={item.source} />
        </div>
        {item.description && (
          <div className="text-[11.5px] text-muted-foreground mt-0.5 leading-snug">
            {item.description}
          </div>
        )}
      </div>
      <div className="shrink-0 w-[240px] flex items-center gap-2">
        <SettingInput item={item} value={displayValue} dirty={dirty} onChange={onChange} />
        {dirty && (
          <button
            type="button"
            onClick={onClear}
            className="text-muted-foreground hover:text-foreground"
            title="Discard this edit"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}

function SourceBadge({ source }: { source: Source }) {
  const map: Record<Source, { label: string; className: string }> = {
    db: { label: 'salvo', className: 'text-emerald-600 dark:text-emerald-400' },
    env: { label: '.env', className: 'text-blue-600 dark:text-blue-400' },
    default: { label: 'default', className: 'text-muted-foreground' },
    unset: { label: 'unset', className: 'text-muted-foreground/70' },
  };
  const m = map[source];
  return <span className={cn('text-[10px] font-mono', m.className)}>· {m.label}</span>;
}

function SettingInput({
  item,
  value,
  dirty,
  onChange,
}: {
  item: SettingItem;
  value: string;
  dirty: boolean;
  onChange: (v: string | null) => void;
}) {
  const [revealSecret, setRevealSecret] = useState(false);

  if (item.type === 'bool') {
    const checked = value === '1' || value === 'true';
    return (
      <Switch
        checked={checked}
        onCheckedChange={(v) => onChange(v ? '1' : '0')}
        className={cn(dirty && 'ring-2 ring-primary/40')}
      />
    );
  }

  if (item.options && item.options.length > 0) {
    return (
      <Select value={value} onValueChange={(v) => onChange(v || null)}>
        <SelectTrigger className={cn('h-8 text-xs', dirty && 'ring-2 ring-primary/40')}>
          <SelectValue placeholder={item.default ?? '—'} />
        </SelectTrigger>
        <SelectContent>
          {item.options.map((opt) => (
            <SelectItem key={opt} value={opt}>
              {opt}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  if (item.type === 'secret') {
    return (
      <div className="flex items-center gap-1 w-full">
        <Input
          type={revealSecret ? 'text' : 'password'}
          value={dirty ? value : ''}
          placeholder={item.hasValue ? '••••••••' : 'unset'}
          onChange={(e) => onChange(e.target.value || null)}
          className={cn('h-8 text-xs font-mono', dirty && 'ring-2 ring-primary/40')}
        />
        <button
          type="button"
          onClick={() => setRevealSecret((v) => !v)}
          className="text-muted-foreground hover:text-foreground"
          title={revealSecret ? 'Hide' : 'Show'}
        >
          {revealSecret ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
        </button>
      </div>
    );
  }

  return (
    <Input
      type={item.type === 'int' || item.type === 'float' ? 'number' : 'text'}
      step={item.type === 'float' ? '0.01' : '1'}
      min={item.min}
      max={item.max}
      value={value}
      placeholder={item.default ?? '—'}
      onChange={(e) => onChange(e.target.value || null)}
      className={cn('h-8 text-xs font-mono', dirty && 'ring-2 ring-primary/40')}
    />
  );
}
