import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';

interface AddRoleToProjectMenuProps {
  available: string[];
  onPick: (roleName: string) => void;
}

/**
 * Dropdown chip rendered next to a project row inside
 * `ProjectRolesBinding`. Closes on outside-click so it never traps focus.
 */
export function AddRoleToProjectMenu({ available, onPick }: AddRoleToProjectMenuProps) {
  const { t } = useTranslation('agents');
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-0.5 text-[9px] rounded-full border border-dashed px-1.5 py-0.5 text-muted-foreground hover:text-foreground hover:border-solid transition-colors"
        title={t('projectAgents.addRole', 'Add role')}
      >
        <Plus className="h-2 w-2" />
        <span>{t('projectAgents.addRole', 'Add role')}</span>
      </button>
      {open && (
        <div className="absolute z-10 mt-1 min-w-[120px] rounded-md border bg-popover shadow-md py-1 text-[10px]">
          {available.map((roleName) => (
            <button
              key={roleName}
              type="button"
              onClick={() => { onPick(roleName); setOpen(false); }}
              className="w-full text-left px-2 py-1 hover:bg-muted capitalize"
            >
              {roleName}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
