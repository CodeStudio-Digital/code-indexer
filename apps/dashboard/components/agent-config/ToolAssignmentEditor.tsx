import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCheck,
  ChevronDown,
  ChevronsUpDown,
  LockKeyhole,
  RotateCcw,
  Search,
  Wrench,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/utils.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';

export interface ToolAssignmentOption {
  name: string;
  tier: string;
  source: string;
  description: string;
  globallyDisabled?: boolean;
}

type SelectionMode = 'pins' | 'allowlist' | 'inherited';

interface SelectionCheckboxProps {
  checked: boolean;
  indeterminate?: boolean;
  disabled?: boolean;
  label: string;
  onChange: () => void;
}

function SelectionCheckbox({
  checked,
  indeterminate = false,
  disabled = false,
  label,
  onChange,
}: SelectionCheckboxProps) {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);

  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      disabled={disabled}
      aria-label={label}
      onChange={onChange}
      className="h-3.5 w-3.5 shrink-0 accent-primary disabled:cursor-not-allowed disabled:opacity-45"
    />
  );
}

function ToolGroup({
  tier,
  tools,
  selected,
  open,
  forceOpen,
  inherited,
  disabled,
  onOpenChange,
  onToggle,
  onToggleGroup,
}: {
  tier: string;
  tools: ToolAssignmentOption[];
  selected: Set<string>;
  open: boolean;
  forceOpen: boolean;
  inherited: boolean;
  disabled: boolean;
  onOpenChange: (open: boolean) => void;
  onToggle: (name: string) => void;
  onToggleGroup: (tools: ToolAssignmentOption[], selected: boolean) => void;
}) {
  const { t } = useTranslation('agents');
  const renderedOpen = forceOpen || open;
  const selectedCount = tools.filter((tool) => selected.has(tool.name)).length;
  const toggleable = tools.filter((tool) => !tool.globallyDisabled || selected.has(tool.name));
  const allSelected = toggleable.length > 0 && toggleable.every((tool) => selected.has(tool.name));
  const partiallySelected = !allSelected && toggleable.some((tool) => selected.has(tool.name));

  return (
    <section className="overflow-hidden rounded-md border border-border/70 bg-background">
      <div className="flex min-w-0 items-center gap-2 bg-muted/20 px-2.5 py-2">
        <SelectionCheckbox
          checked={allSelected}
          indeterminate={partiallySelected}
          disabled={disabled || toggleable.length === 0}
          label={t('agentConfig.tools.toggleTier', { tier })}
          onChange={() => onToggleGroup(toggleable, !allSelected)}
        />
        <button
          type="button"
          aria-expanded={renderedOpen}
          onClick={() => { if (!forceOpen) onOpenChange(!open); }}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <Badge variant="outline" className="h-5 max-w-44 shrink-0 truncate text-[9px] uppercase">
            {tier}
          </Badge>
          <span className="truncate text-[10px] tabular-nums text-muted-foreground">
            {t('agentConfig.tools.groupCount', { selected: selectedCount, total: tools.length })}
          </span>
          {inherited && (
            <span className="ml-auto hidden shrink-0 items-center gap-1 text-[9px] text-primary sm:flex">
              <LockKeyhole className="h-3 w-3" />
              {t('agentConfig.tools.inheritedAccess')}
            </span>
          )}
          <ChevronDown className={cn(
            'ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
            renderedOpen && 'rotate-180',
            inherited && 'sm:ml-0',
          )} />
        </button>
      </div>

      {renderedOpen && (
        <div className="divide-y divide-border/50 border-t border-border/60">
          {tools.map((tool) => {
            const active = selected.has(tool.name);
            const globallyDisabled = !!tool.globallyDisabled;
            const cannotSelect = disabled || (globallyDisabled && !active);
            return (
              <label
                key={tool.name}
                title={globallyDisabled ? t('agentConfig.tools.globallyDisabled') : tool.description}
                className={cn(
                  'flex min-w-0 items-center gap-2.5 px-2.5 py-1.5 transition-colors',
                  cannotSelect ? 'cursor-not-allowed opacity-55' : 'cursor-pointer hover:bg-muted/35',
                )}
              >
                <input
                  type="checkbox"
                  checked={active}
                  disabled={cannotSelect}
                  onChange={() => onToggle(tool.name)}
                  className="h-3.5 w-3.5 shrink-0 accent-primary"
                />
                <span className="w-[min(42%,20rem)] shrink-0 truncate font-mono text-[10px] font-medium text-foreground">
                  {tool.name}
                </span>
                <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">
                  {tool.description || tool.source}
                </span>
                {globallyDisabled && (
                  <span className="hidden shrink-0 text-[9px] text-destructive sm:block">
                    {t('agentConfig.tools.disabledShort')}
                  </span>
                )}
              </label>
            );
          })}
        </div>
      )}
    </section>
  );
}

export interface ToolAssignmentEditorProps {
  tools: ToolAssignmentOption[];
  selected: string[];
  onChange: (tools: string[]) => void;
  loading?: boolean;
  disabled?: boolean;
  mode?: SelectionMode;
  inheritedTiers?: string[];
  resetKind?: 'preset' | 'saved';
  baselineSelected?: string[];
  className?: string;
}

export function ToolAssignmentEditor({
  tools,
  selected,
  onChange,
  loading = false,
  disabled = false,
  mode = 'pins',
  inheritedTiers = [],
  resetKind = 'preset',
  baselineSelected,
  className,
}: ToolAssignmentEditorProps) {
  const { t } = useTranslation('agents');
  const initialSelection = useRef([...selected].sort());
  const [query, setQuery] = useState('');
  const [selectedOnly, setSelectedOnly] = useState(false);
  const [expandedTiers, setExpandedTiers] = useState<Set<string>>(() => new Set());
  const selectedNames = useMemo(() => new Set(selected), [selected]);
  const inherited = useMemo(() => new Set(inheritedTiers), [inheritedTiers]);
  const resetSelection = useMemo(
    () => [...(baselineSelected ?? initialSelection.current)].sort(),
    [baselineSelected],
  );

  const allTools = useMemo(() => {
    const knownNames = new Set(tools.map((tool) => tool.name));
    return [
      ...tools,
      ...selected
        .filter((name) => !knownNames.has(name))
        .map((name) => ({
          name,
          tier: 'configured',
          source: 'configured',
          description: t('agentConfig.tools.configuredDescription'),
        })),
    ];
  }, [selected, t, tools]);

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleTools = useMemo(() => allTools
    .filter((tool) => !selectedOnly || selectedNames.has(tool.name))
    .filter((tool) => !normalizedQuery || [tool.name, tool.tier, tool.source, tool.description]
      .some((value) => value.toLocaleLowerCase().includes(normalizedQuery)))
    .sort((left, right) => left.name.localeCompare(right.name)), [allTools, normalizedQuery, selectedNames, selectedOnly]);

  const groups = useMemo(() => {
    const result = new Map<string, ToolAssignmentOption[]>();
    for (const tool of visibleTools) result.set(tool.tier, [...(result.get(tool.tier) ?? []), tool]);
    return result;
  }, [visibleTools]);

  const tierOrder = [
    'bootstrap',
    'navigate',
    'admin',
    'company',
    'master',
    'app',
    'sandbox',
    'qa',
    'preview',
    'db',
    'api',
    'diagram',
    'custom',
    'configured',
  ];
  const orderedTiers = [
    ...tierOrder.filter((tier) => groups.has(tier)),
    ...[...groups.keys()].filter((tier) => !tierOrder.includes(tier)).sort(),
  ];
  const allVisibleSelected = visibleTools.length > 0
    && visibleTools.filter((tool) => !tool.globallyDisabled).every((tool) => selectedNames.has(tool.name));
  const baselineChanged = [...selected].sort().join('\u0000') !== resetSelection.join('\u0000');
  const everyGroupOpen = orderedTiers.length > 0 && orderedTiers.every((tier) => expandedTiers.has(tier));
  const forceOpen = normalizedQuery.length > 0;

  const toggle = (name: string) => onChange(
    selectedNames.has(name)
      ? selected.filter((candidate) => candidate !== name)
      : [...selected, name].sort(),
  );

  const toggleGroup = (groupTools: ToolAssignmentOption[], shouldSelect: boolean) => {
    const names = new Set(groupTools.map((tool) => tool.name));
    onChange(shouldSelect
      ? [...new Set([...selected, ...names])].sort()
      : selected.filter((name) => !names.has(name)));
  };

  const selectVisible = () => onChange([
    ...new Set([
      ...selected,
      ...visibleTools.filter((tool) => !tool.globallyDisabled).map((tool) => tool.name),
    ]),
  ].sort());
  const clearVisible = () => {
    const visibleNames = new Set(visibleTools.map((tool) => tool.name));
    onChange(selected.filter((name) => !visibleNames.has(name)));
  };
  const toggleAllGroups = () => setExpandedTiers(everyGroupOpen ? new Set() : new Set(orderedTiers));

  return (
    <div className={cn('flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-card', className)}>
      <div className="shrink-0 border-b border-border p-3">
        <div className="flex min-w-0 items-start gap-3">
          <Wrench className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-xs font-semibold">
                {t(
                  mode === 'allowlist'
                    ? 'agentConfig.tools.allowed'
                    : mode === 'inherited'
                      ? 'agentConfig.tools.inherited'
                      : 'agentConfig.tools.assigned',
                )}
              </span>
              <Badge variant="secondary" className="h-5 shrink-0 px-1.5 text-[9px] tabular-nums">
                {t('agentConfig.tools.totalSelected', { selected: selected.length, total: allTools.length })}
              </Badge>
            </div>
            <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">
              {t(
                mode === 'allowlist'
                  ? 'agentConfig.tools.allowlistHint'
                  : mode === 'inherited'
                    ? 'agentConfig.tools.inheritedHint'
                    : 'agentConfig.tools.hint',
              )}
            </p>
          </div>
        </div>

        <div className="mt-3 flex min-w-0 flex-wrap items-center gap-1.5">
          <label className="relative min-w-48 flex-1">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('agentConfig.tools.searchPlaceholder')}
              className="h-8 w-full rounded-md border bg-background pl-7 pr-7 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            {query && (
              <button
                type="button"
                aria-label={t('agentConfig.tools.clearSearch')}
                onClick={() => setQuery('')}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </label>
          <Button
            type="button"
            size="sm"
            variant={selectedOnly ? 'secondary' : 'outline'}
            aria-pressed={selectedOnly}
            onClick={() => setSelectedOnly((current) => !current)}
            className="h-8 px-2 text-[10px]"
          >
            {t('agentConfig.tools.selectedOnly')}
          </Button>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <Button type="button" size="sm" variant="outline" disabled={disabled || visibleTools.length === 0 || allVisibleSelected} onClick={selectVisible} className="h-7 px-2 text-[10px]">
            <CheckCheck className="h-3 w-3" /> {t('agentConfig.tools.selectVisible')}
          </Button>
          <Button type="button" size="sm" variant="outline" disabled={disabled || !visibleTools.some((tool) => selectedNames.has(tool.name))} onClick={clearVisible} className="h-7 px-2 text-[10px]">
            <X className="h-3 w-3" /> {t('agentConfig.tools.clearVisible')}
          </Button>
          <Button type="button" size="sm" variant="ghost" disabled={disabled || !baselineChanged} onClick={() => onChange([...resetSelection])} className="h-7 px-2 text-[10px]">
            <RotateCcw className="h-3 w-3" /> {t(resetKind === 'saved' ? 'agentConfig.tools.restoreSaved' : 'agentConfig.tools.restorePreset')}
          </Button>
          <Button type="button" size="sm" variant="ghost" disabled={forceOpen || orderedTiers.length === 0} onClick={toggleAllGroups} className="ml-auto h-7 px-2 text-[10px]">
            <ChevronsUpDown className="h-3 w-3" /> {t(everyGroupOpen ? 'agentConfig.tools.collapseAll' : 'agentConfig.tools.expandAll')}
          </Button>
        </div>
      </div>

      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain p-2">
        {loading ? (
          <p className="rounded border border-dashed py-8 text-center text-[10px] text-muted-foreground">
            {t('agentConfig.tools.loading')}
          </p>
        ) : (
          <div className="space-y-1.5">
            {orderedTiers.map((tier) => (
              <ToolGroup
                key={tier}
                tier={tier}
                tools={groups.get(tier) ?? []}
                selected={selectedNames}
                open={expandedTiers.has(tier)}
                forceOpen={forceOpen}
                inherited={inherited.has(tier)}
                disabled={disabled}
                onOpenChange={(open) => setExpandedTiers((current) => {
                  const next = new Set(current);
                  if (open) next.add(tier); else next.delete(tier);
                  return next;
                })}
                onToggle={toggle}
                onToggleGroup={toggleGroup}
              />
            ))}
            {visibleTools.length === 0 && (
              <p className="rounded border border-dashed py-8 text-center text-[10px] text-muted-foreground">
                {t(selectedOnly ? 'agentConfig.tools.noneSelected' : 'agentConfig.tools.noneFound')}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
