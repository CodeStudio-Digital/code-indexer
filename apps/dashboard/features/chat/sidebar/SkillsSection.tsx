import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, Search, Sparkles, X } from 'lucide-react';
import { CollapsibleSection } from './CollapsibleSection.js';
import { useProjectSkills, type SessionSkill } from './useProjectSkills.js';
import { groupSkillsByNamespace } from '@mcp/code-agent/skills/namespace.js';
import { cn } from '../../../lib/utils.js';

interface SkillsSectionProps {
  sessionId: number;
  selected: string[];
  onToggleSelect: (skillId: string) => void;
}

export const SkillsSection = memo(function SkillsSection({ sessionId, selected, onToggleSelect }: SkillsSectionProps) {
  const { t } = useTranslation('chat');
  const { skills, loading, error, search, setSearch } = useProjectSkills(sessionId);
  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const grouped = useMemo(
    () => groupSkillsByNamespace(
      skills.map((s) => ({ ...s, source: s.source, author: s.author })),
    ),
    [skills],
  );

  const headerExtra =
    selected.length > 0 ? (
      <span className="px-1.5 py-0.5 rounded bg-info/15 text-info text-[10px] font-medium">
        {selected.length}
      </span>
    ) : null;

  const isSearching = search.trim().length > 0;

  return (
    <CollapsibleSection
      id="skills"
      sessionId={sessionId}
      title={t('skills.title')}
      icon={<Sparkles className="h-3.5 w-3.5 text-muted-foreground" />}
      headerExtra={headerExtra}
      defaultOpen={false}
    >
      <div className="px-2 py-2">
        <div className="relative mb-2">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('skills.search')}
            className="w-full text-xs pl-7 pr-7 py-1.5 rounded border bg-background focus:outline-none focus:ring-1 focus:ring-ring"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>

        {error && <div className="text-[11px] text-destructive px-1 py-1">{error}</div>}

        {loading && skills.length === 0 ? (
          <div className="text-[11px] text-muted-foreground px-1 py-2">{t('skills.loading')}</div>
        ) : skills.length === 0 ? (
          <div className="text-[11px] text-muted-foreground px-1 py-2">
            {search ? t('skills.noMatches') : t('skills.empty')}
          </div>
        ) : (
          <div className="space-y-1">
            {[...grouped.entries()].map(([namespace, items]) => (
              <SkillGroup
                key={namespace}
                sessionId={sessionId}
                namespace={namespace}
                items={items as SessionSkill[]}
                selectedSet={selectedSet}
                onToggleSelect={onToggleSelect}
                forceOpen={isSearching}
              />
            ))}
          </div>
        )}
      </div>
    </CollapsibleSection>
  );
});

/**
 * Collapsible subgroup inside the Skills section. Lighter visual treatment
 * than the top-level `CollapsibleSection` (no border, no sticky header) so
 * it nests cleanly. Persists open/closed state per (session, namespace) in
 * localStorage. Force-opens whenever the parent search field is non-empty
 * so search matches are never hidden inside a collapsed group.
 */
const SkillGroup = memo(function SkillGroup({
  sessionId,
  namespace,
  items,
  selectedSet,
  onToggleSelect,
  forceOpen,
}: {
  sessionId: number;
  namespace: string;
  items: SessionSkill[];
  selectedSet: Set<string>;
  onToggleSelect: (skillId: string) => void;
  forceOpen: boolean;
}) {
  const storageKey = `chat:sidebar:${sessionId}:skills:group:${namespace}`;
  const [open, setOpen] = useState<boolean>(() => readOpen(storageKey, false));

  useEffect(() => {
    setOpen(readOpen(storageKey, false));
  }, [storageKey]);

  const toggle = useCallback(() => {
    setOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(storageKey, next ? '1' : '0');
      } catch {
        /* ignore quota / unavailable */
      }
      return next;
    });
  }, [storageKey]);

  const isOpen = forceOpen || open;
  const sortedItems = useMemo(
    () => [...items].sort((a, b) => a.name.localeCompare(b.name)),
    [items],
  );
  const selectedInGroup = useMemo(
    () => sortedItems.reduce((n, skill) => (selectedSet.has(skill.id) ? n + 1 : n), 0),
    [selectedSet, sortedItems],
  );

  return (
    <div>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={isOpen}
        className="w-full flex items-center gap-1 px-1 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
      >
        <span className="shrink-0">
          {isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        </span>
        <span className="truncate">{namespace}</span>
        <span className="ml-auto flex items-center gap-1 normal-case tracking-normal">
          {selectedInGroup > 0 && (
            <span className="px-1 py-0 rounded bg-info/15 text-info text-[9px] font-medium">
              {selectedInGroup}/{items.length}
            </span>
          )}
          {selectedInGroup === 0 && <span className="text-[10px]">({items.length})</span>}
        </span>
      </button>
      {isOpen && (
        <ul className="space-y-0.5">
          {sortedItems.map((skill) => (
            <SkillRow
              key={skill.id}
              skill={skill}
              selected={selectedSet.has(skill.id)}
              onToggleSelect={onToggleSelect}
            />
          ))}
        </ul>
      )}
    </div>
  );
});

function readOpen(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    if (v === '1') return true;
    if (v === '0') return false;
  } catch {
    /* ignore */
  }
  return fallback;
}

const SkillRow = memo(function SkillRow({
  skill,
  selected,
  onToggleSelect,
}: {
  skill: SessionSkill;
  selected: boolean;
  onToggleSelect: (skillId: string) => void;
}) {
  return (
    <li>
      <label
        className={cn(
          'flex items-start gap-1.5 text-xs py-1 px-1 rounded cursor-pointer hover:bg-muted/50',
          selected && 'bg-info/10',
        )}
        title={skill.description || skill.id}
      >
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onToggleSelect(skill.id)}
          className="h-3 w-3 shrink-0 mt-0.5"
        />
        <Sparkles className="h-3.5 w-3.5 shrink-0 text-muted-foreground mt-0.5" />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1">
            <span
              className={cn(
                'truncate',
                selected ? 'text-foreground font-medium' : 'text-foreground',
              )}
            >
              {skill.name}
            </span>
            {skill.context_mode === 'tool' && (
              <span className="shrink-0 px-1 py-0 rounded bg-amber-500/15 text-amber-600 dark:text-amber-400 text-[9px] uppercase">
                tool
              </span>
            )}
          </span>
          {skill.description && (
            <span className="block truncate text-[10px] text-muted-foreground">
              {skill.description}
            </span>
          )}
        </span>
      </label>
    </li>
  );
});
