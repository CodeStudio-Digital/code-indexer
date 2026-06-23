/**
 * Step 1 — pick a stack. Selectable cards grouped by category. Selecting
 * a card advances; the chosen id flows up to the wizard.
 */
import { useTranslation } from 'react-i18next';
import { Wifi } from 'lucide-react';
import { cn } from '../../../lib/utils.js';
import { Badge } from '../../../components/ui/badge.js';
import { TEMPLATES, TEMPLATE_GROUPS, type TemplateId } from './templates.js';

interface TemplateGridProps {
  selected: TemplateId | null;
  onSelect: (id: TemplateId) => void;
}

export function TemplateGrid({ selected, onSelect }: TemplateGridProps) {
  const { t } = useTranslation(['projects']);
  return (
    <div className="space-y-5 max-h-[55vh] overflow-y-auto pr-1">
      {TEMPLATE_GROUPS.map((group) => {
        const items = TEMPLATES.filter((tpl) => tpl.group === group);
        if (items.length === 0) return null;
        return (
          <div key={group} className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t(`wizard.group.${group}`)}
            </h3>
            <div className="grid gap-2 grid-cols-1 sm:grid-cols-2">
              {items.map((tpl) => {
                const Icon = tpl.icon;
                const isSelected = selected === tpl.id;
                return (
                  <button
                    key={tpl.id}
                    type="button"
                    onClick={() => onSelect(tpl.id)}
                    className={cn(
                      'flex items-start gap-3 rounded-lg border p-3 text-left transition-colors',
                      isSelected
                        ? 'border-primary bg-primary/5 ring-1 ring-primary'
                        : 'border-border hover:border-primary/40 hover:bg-accent',
                    )}
                  >
                    <div className="mt-0.5 h-9 w-9 shrink-0 rounded-md bg-primary/10 text-primary flex items-center justify-center">
                      <Icon className="h-5 w-5" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm font-medium">{t(`wizard.tpl.${tpl.id}.label`)}</span>
                        {tpl.needsNetwork && (
                          <Wifi className="h-3 w-3 text-muted-foreground" aria-label={t('wizard.needsNetwork')} />
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                        {t(`wizard.tpl.${tpl.id}.desc`)}
                      </p>
                      {tpl.requiresRepoUrl && (
                        <Badge variant="muted" className="mt-1.5 text-[10px]">
                          {t('wizard.needsRepoUrl')}
                        </Badge>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
