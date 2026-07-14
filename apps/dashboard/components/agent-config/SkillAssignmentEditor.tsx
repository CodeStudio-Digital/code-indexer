import { useState } from 'react';
import { ChevronDown, Search, Sparkles } from 'lucide-react';
import { Badge } from '../ui/badge.js';

export interface SkillAssignmentOption {
  id: string;
  name: string;
  description: string;
  context_mode: string;
  slash_command: string | null;
  source: string;
  author?: string | null;
}

function skillGroupName(skill: SkillAssignmentOption): string {
  if (skill.source === 'imported' && skill.author) return skill.author;
  return skill.source === 'builtin' ? 'builtin' : 'user';
}

function CollapsibleSkillGroup({
  name,
  skills,
  selected,
  forceOpen,
  compact,
  onToggleSkill,
}: {
  name: string;
  skills: SkillAssignmentOption[];
  selected: Set<string>;
  forceOpen: boolean;
  compact: boolean;
  onToggleSkill: (skillId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const selectedCount = skills.filter((skill) => selected.has(skill.id)).length;
  return (
    <details
      open={forceOpen || open}
      onToggle={(event) => { if (!forceOpen) setOpen(event.currentTarget.open); }}
      className="group rounded border border-border/70 bg-muted/15"
    >
      <summary className={`flex cursor-pointer list-none items-center gap-1.5 select-none ${compact ? 'px-2 py-1.5' : 'px-2.5 py-2'}`}>
        <Badge variant="outline" className="h-4 max-w-[65%] truncate text-[9px] uppercase">{name}</Badge>
        <span className="text-[9px] text-muted-foreground">{selectedCount > 0 ? `${selectedCount} selecionada${selectedCount === 1 ? '' : 's'} · ` : ''}{skills.length}</span>
        <ChevronDown className="ml-auto h-3 w-3 text-muted-foreground transition-transform group-open:rotate-180" />
      </summary>
      <div className={`flex flex-wrap gap-1 border-t border-border/60 ${compact ? 'p-2' : 'p-2.5'}`}>
        {skills.map((skill) => {
          const active = selected.has(skill.id);
          const label = skill.slash_command ? `/${skill.slash_command}` : skill.name;
          return (
            <button
              type="button"
              key={skill.id}
              onClick={() => onToggleSkill(skill.id)}
              title={skill.description}
              aria-pressed={active}
              className={`rounded-full border px-2 py-0.5 text-[10px] transition-colors ${active ? 'border-primary/40 bg-primary/10 text-primary' : 'border-border bg-muted/50 text-muted-foreground hover:border-foreground/30'}`}
            >
              {label}
            </button>
          );
        })}
      </div>
    </details>
  );
}

export function SkillAssignmentEditor({ skills, selected, onChange, compact = false }: { skills: SkillAssignmentOption[]; selected: string[]; onChange: (skills: string[]) => void; compact?: boolean }) {
  const [query, setQuery] = useState('');
  if (skills.length === 0) return <p className="rounded border border-dashed p-2 text-center text-[10px] text-muted-foreground">Nenhuma skill disponível neste projeto.</p>;

  const selectedIds = new Set(selected);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleSkills = normalizedQuery
    ? skills.filter((skill) => [skill.id, skill.name, skill.description, skill.slash_command ?? '', skill.author ?? '', skill.source].some((value) => value.toLocaleLowerCase().includes(normalizedQuery)))
    : skills;
  const groups = new Map<string, SkillAssignmentOption[]>();
  for (const skill of visibleSkills) {
    const key = skillGroupName(skill);
    groups.set(key, [...(groups.get(key) ?? []), skill]);
  }
  const order = ['user', 'builtin', ...[...groups.keys()].filter((key) => key !== 'user' && key !== 'builtin').sort()];
  const toggle = (skillId: string) => onChange(selectedIds.has(skillId) ? selected.filter((candidate) => candidate !== skillId) : [...selected, skillId].sort());

  return (
    <div className={compact ? 'space-y-1.5' : 'space-y-2'}>
      <div className="flex items-center gap-1 text-[10px] font-medium text-muted-foreground"><Sparkles className="h-3 w-3" />Skills atribuídas <span className="ml-auto">{selected.length}</span></div>
      <label className="relative block">
        <Search className={`pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground ${compact ? 'h-3 w-3' : 'h-3.5 w-3.5'}`} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Buscar por nome, comando ou origem…"
          className={`${compact ? 'h-7 pl-7 text-[10px]' : 'h-8 pl-8 text-xs'} w-full rounded border bg-background pr-2`}
        />
      </label>
      <div className="space-y-1.5">
        {order.filter((key) => groups.has(key)).map((key) => (
          <CollapsibleSkillGroup
            key={key}
            name={key}
            skills={groups.get(key) ?? []}
            selected={selectedIds}
            forceOpen={normalizedQuery.length > 0}
            compact={compact}
            onToggleSkill={toggle}
          />
        ))}
        {visibleSkills.length === 0 && <p className="rounded border border-dashed py-2 text-center text-[10px] text-muted-foreground">Nenhuma skill encontrada.</p>}
      </div>
    </div>
  );
}
