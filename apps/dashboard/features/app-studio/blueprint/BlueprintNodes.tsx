/**
 * Nós do canvas Blueprint — cards leigo-friendly por kind (Tela, Dados,
 * Recurso, Login, Ação), com cor/ícone próprios e handles esquerda
 * (entrada) / direita (saída). O payload vem de specToGraph
 * (BlueprintNodeData); os tipos do React Flow são castados no Panel.
 */
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { useTranslation } from 'react-i18next';
import { Database, KeyRound, Layout, Puzzle, Zap, type LucideIcon } from 'lucide-react';
import type { BlueprintNodeData } from '@mcp/app-studio/blueprint/types.js';
import { cn } from '../../../lib/utils.js';

const STYLE: Record<BlueprintNodeData['kind'], { icon: LucideIcon; frame: string; chip: string }> = {
  screen: { icon: Layout, frame: 'border-sky-400/50 bg-sky-500/5', chip: 'bg-sky-500/15 text-sky-600' },
  entity: { icon: Database, frame: 'border-emerald-400/50 bg-emerald-500/5', chip: 'bg-emerald-500/15 text-emerald-600' },
  feature: { icon: Puzzle, frame: 'border-violet-400/50 bg-violet-500/5', chip: 'bg-violet-500/15 text-violet-600' },
  auth: { icon: KeyRound, frame: 'border-amber-400/50 bg-amber-500/5', chip: 'bg-amber-500/15 text-amber-600' },
  behavior: { icon: Zap, frame: 'border-rose-400/50 bg-rose-500/5', chip: 'bg-rose-500/15 text-rose-600' },
};

function Shell({
  data,
  selected,
  title,
  subtitle,
  children,
}: {
  data: BlueprintNodeData;
  selected?: boolean;
  title: string;
  subtitle?: string;
  children?: React.ReactNode;
}) {
  const { t } = useTranslation('appStudio');
  const { icon: Icon, frame, chip } = STYLE[data.kind];
  return (
    <div
      className={cn(
        'w-56 rounded-lg border-2 bg-card px-3 py-2 shadow-sm transition-shadow',
        frame,
        selected && 'shadow-md ring-2 ring-primary/50',
      )}
    >
      <Handle type="target" position={Position.Left} className="!h-2.5 !w-2.5 !bg-muted-foreground/60" />
      <div className="flex items-center gap-1.5">
        <span className={cn('grid h-5 w-5 shrink-0 place-items-center rounded', chip)}>
          <Icon className="h-3 w-3" />
        </span>
        <span className="text-[9px] uppercase tracking-wide text-muted-foreground">
          {t(`blueprint.kind.${data.kind === 'entity' ? 'entity' : data.kind}`)}
        </span>
      </div>
      <p className="mt-1 truncate text-sm font-semibold" title={title}>{title}</p>
      {subtitle && <p className="truncate text-[11px] text-muted-foreground" title={subtitle}>{subtitle}</p>}
      {children}
      <Handle type="source" position={Position.Right} className="!h-2.5 !w-2.5 !bg-muted-foreground/60" />
    </div>
  );
}

type Props = NodeProps & { data: BlueprintNodeData };

export function BlueprintNode({ data, selected }: Props) {
  const { t } = useTranslation('appStudio');
  switch (data.kind) {
    case 'screen':
      return (
        <Shell data={data} selected={selected} title={data.label} subtitle={data.purpose}>
          <div className="mt-1 flex gap-1">
            {data.primary && (
              <span className="rounded-full bg-sky-500/15 px-1.5 text-[9px] text-sky-600">{t('blueprint.homeBadge')}</span>
            )}
            {data.protected && (
              <span className="rounded-full bg-amber-500/15 px-1.5 text-[9px] text-amber-600">{t('blueprint.protectedBadge')}</span>
            )}
          </div>
        </Shell>
      );
    case 'entity':
      return (
        <Shell data={data} selected={selected} title={data.label}>
          <ul className="mt-1 space-y-0.5">
            {data.fields.slice(0, 4).map((f) => (
              <li key={f.name} className="truncate text-[10px] text-muted-foreground">
                {f.label} <span className="text-muted-foreground/50">· {f.type}</span>
              </li>
            ))}
            {data.fields.length > 4 && (
              <li className="text-[10px] text-muted-foreground/60">+{data.fields.length - 4}…</li>
            )}
          </ul>
        </Shell>
      );
    case 'feature':
      return <Shell data={data} selected={selected} title={data.label} subtitle={data.description} />;
    case 'auth':
      return (
        <Shell
          data={data}
          selected={selected}
          title={t('blueprint.authTitle')}
          subtitle={data.methods.join(' · ') || undefined}
        />
      );
    case 'behavior':
      return (
        <Shell data={data} selected={selected} title={data.label} subtitle={t(`blueprint.trigger.${data.trigger}`)}>
          <ul className="mt-1 space-y-0.5">
            {data.actions.map((a, i) => (
              <li key={i} className="truncate text-[10px] text-muted-foreground">
                {a.kind === 'save' && `${t('blueprint.action.save')} → ${a.entity}`}
                {a.kind === 'navigate' && `${t('blueprint.action.navigate')} → ${a.screen_id}`}
                {a.kind === 'notify' && `${t('blueprint.action.notify')}: "${a.message}"`}
              </li>
            ))}
          </ul>
        </Shell>
      );
  }
}

/** nodeTypes do React Flow — todos os kinds renderizam pelo mesmo componente. */
export const BLUEPRINT_NODE_TYPES = {
  screen: BlueprintNode,
  entity: BlueprintNode,
  feature: BlueprintNode,
  auth: BlueprintNode,
  behavior: BlueprintNode,
};
