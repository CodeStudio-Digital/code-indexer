/** Shared underline tab bar (Postman-style) for the request + response panes. */
import { cn } from '../../lib/utils.js';

export interface SubTabDef<T extends string> {
  id: T;
  label: string;
  /** Small count/badge after the label. */
  badge?: number;
  badgeTone?: 'primary' | 'danger' | 'success';
}

interface Props<T extends string> {
  tabs: SubTabDef<T>[];
  active: T;
  onChange: (id: T) => void;
  className?: string;
}

export function SubTabs<T extends string>({ tabs, active, onChange, className }: Props<T>) {
  return (
    <div className={cn('flex items-center gap-0.5 px-2 border-b text-xs', className)}>
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          className={cn(
            'relative px-2.5 py-1.5 -mb-px border-b-2 transition-colors capitalize',
            active === t.id ? 'border-primary text-foreground font-medium' : 'border-transparent text-muted-foreground hover:text-foreground',
          )}
        >
          {t.label}
          {t.badge != null && t.badge > 0 && (
            <span className={cn('ml-1 text-[10px] font-medium',
              t.badgeTone === 'danger' ? 'text-red-500' : t.badgeTone === 'success' ? 'text-emerald-500' : 'text-primary')}>
              {t.badge}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
