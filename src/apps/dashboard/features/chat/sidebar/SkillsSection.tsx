import { useTranslation } from 'react-i18next';
import { Search, Sparkles, X } from 'lucide-react';
import { CollapsibleSection } from './CollapsibleSection.js';
import { useProjectSkills, type SessionSkill } from './useProjectSkills.js';
import { groupSkillsByNamespace } from '../../../../../core/coder/skills/namespace.js';
import { cn } from '../../../lib/utils.js';

interface SkillsSectionProps {
  sessionId: number;
  selected: string[];
  onToggleSelect: (skillId: string) => void;
}

export function SkillsSection({ sessionId, selected, onToggleSelect }: SkillsSectionProps) {
  const { t } = useTranslation('chat');
  const { skills, loading, error, search, setSearch } = useProjectSkills(sessionId);
  const selectedSet = new Set(selected);

  const grouped = groupSkillsByNamespace(
    skills.map((s) => ({ ...s, source: s.source, author: s.author })),
  );

  const headerExtra =
    selected.length > 0 ? (
      <span className="px-1.5 py-0.5 rounded bg-info/15 text-info text-[10px] font-medium">
        {selected.length}
      </span>
    ) : null;

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
          <div className="space-y-2">
            {[...grouped.entries()].map(([namespace, items]) => (
              <div key={namespace}>
                <div className="px-1 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                  {namespace} ({items.length})
                </div>
                <ul className="space-y-0.5">
                  {items
                    .slice()
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .map((skill) => (
                      <SkillRow
                        key={skill.id}
                        skill={skill as SessionSkill}
                        selected={selectedSet.has(skill.id)}
                        onToggle={() => onToggleSelect(skill.id)}
                      />
                    ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>
    </CollapsibleSection>
  );
}

function SkillRow({
  skill,
  selected,
  onToggle,
}: {
  skill: SessionSkill;
  selected: boolean;
  onToggle: () => void;
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
          onChange={onToggle}
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
}
