/**
 * Templates panel for the pipeline builder. Renders pre-defined node
 * blueprints grouped by category. Clicking a template inserts it on
 * the canvas (the builder generates id + position).
 *
 * Each template has a tooltip with a longer description. The icon set
 * is a minimal Lucide subset; missing icons fall back to `Sparkles`.
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Search,
  Wrench,
  ShieldCheck,
  FileText,
  GitMerge,
  Sparkles,
  FlaskConical,
  Pause,
  Bot,
  CheckCheck,
  Hand,
  ChevronDown,
  ChevronRight,
  Plus,
} from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../../../components/ui/tooltip.js';
import {
  PIPELINE_TEMPLATES,
  TEMPLATE_CATEGORIES,
  templatesByCategory,
  type PipelineTemplate,
} from './templates.js';

const ICON_MAP: Record<PipelineTemplate['icon'], React.ComponentType<{ className?: string }>> = {
  search: Search,
  wrench: Wrench,
  'shield-check': ShieldCheck,
  'file-text': FileText,
  'git-merge': GitMerge,
  sparkles: Sparkles,
  'flask-conical': FlaskConical,
  pause: Pause,
  bot: Bot,
  'check-check': CheckCheck,
  hand: Hand,
};

interface PipelineTemplatesPanelProps {
  onAdd: (template: PipelineTemplate) => void;
}

export function PipelineTemplatesPanel({ onAdd }: PipelineTemplatesPanelProps) {
  const { t } = useTranslation('agents');

  return (
    <TooltipProvider>
      <aside className="w-64 border-r overflow-y-auto bg-card/40 shrink-0">
        <div className="px-3 py-2 border-b sticky top-0 bg-card/95 backdrop-blur z-10">
          <div className="text-xs font-semibold">
            {t('pipelines.templates.heading', { defaultValue: 'Templates' })}
          </div>
          <div className="text-[10px] text-muted-foreground mt-0.5">
            {t('pipelines.templates.subheading', {
              defaultValue: 'Click to add a pre-configured stage',
            })}
          </div>
        </div>
        <div className="p-2 space-y-2">
          {TEMPLATE_CATEGORIES.map((cat) => (
            <CategoryGroup key={cat} category={cat} onAdd={onAdd} />
          ))}
        </div>
      </aside>
    </TooltipProvider>
  );
}

function CategoryGroup({
  category,
  onAdd,
}: {
  category: PipelineTemplate['category'];
  onAdd: (t: PipelineTemplate) => void;
}) {
  const { t } = useTranslation('agents');
  const [open, setOpen] = useState(true);
  const items = templatesByCategory(category);
  if (items.length === 0) return null;

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-1 px-1.5 py-1 text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <span className="font-medium">
          {t(`pipelines.templates.category.${category}`, { defaultValue: category })}
        </span>
        <span className="ml-auto opacity-60">{items.length}</span>
      </button>
      {open && (
        <div className="space-y-1 mt-1">
          {items.map((tpl) => (
            <TemplateCard key={tpl.key} template={tpl} onAdd={onAdd} />
          ))}
        </div>
      )}
    </div>
  );
}

function TemplateCard({
  template,
  onAdd,
}: {
  template: PipelineTemplate;
  onAdd: (t: PipelineTemplate) => void;
}) {
  const { t } = useTranslation('agents');
  const Icon = ICON_MAP[template.icon] ?? Sparkles;
  const labelKey = `pipelines.templates.items.${template.key}.label`;
  const descKey = `pipelines.templates.items.${template.key}.description`;
  const label = t(labelKey, { defaultValue: template.spec.label });
  const desc = t(descKey, { defaultValue: '' });

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => onAdd(template)}
          className="group w-full text-left px-2 py-1.5 rounded border border-transparent hover:border-border hover:bg-muted transition-colors flex items-center gap-2"
        >
          <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground group-hover:text-foreground" />
          <span className="text-xs font-medium truncate flex-1">{label}</span>
          <Plus className="h-3 w-3 opacity-0 group-hover:opacity-70" />
        </button>
      </TooltipTrigger>
      {desc && (
        <TooltipContent side="right" className="max-w-xs">
          <div className="text-xs">{desc}</div>
        </TooltipContent>
      )}
    </Tooltip>
  );
}
