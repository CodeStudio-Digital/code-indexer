import { Activity, CheckSquare, Link2, Users } from 'lucide-react';
import { WorkBoardBadge, WorkBoardCard, WorkBoardCardContent, type WorkBoardTone } from '../../../components/work-board/index.js';
import type { AppWorkItemView } from '../app-studio-api.js';

const KIND_TONE: Record<AppWorkItemView['kind'], WorkBoardTone> = {
  research: 'blue', plan: 'violet', contract: 'amber', implement: 'blue', verify: 'green', release: 'violet', change: 'amber',
};

const STATUS_TONE: Partial<Record<AppWorkItemView['status'], WorkBoardTone>> = {
  ready: 'blue', running: 'amber', review: 'violet', done: 'green', blocked: 'red', stale: 'amber', cancelled: 'red',
};

export function AppWorkItemCard({ item, onOpen }: { item: AppWorkItemView; onOpen: () => void }) {
  const completedAcceptance = item.status === 'done'
    ? item.acceptance.length
    : Math.min(item.evidence.length, item.acceptance.length);

  return (
    <WorkBoardCard onClick={onOpen} blocked={item.status === 'blocked'} className={item.status === 'stale' ? 'border-amber-500/40' : undefined}>
      <WorkBoardCardContent
        title={item.title}
        description={item.outcome}
        leading={item.status === 'running' ? <span className="mt-1 h-2 w-2 shrink-0 animate-pulse rounded-full bg-amber-400" /> : item.status === 'review' ? <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-violet-400" /> : undefined}
        trailing={<span className="shrink-0 font-mono text-[9px] text-muted-foreground">{item.priority}</span>}
        badges={<><WorkBoardBadge tone={KIND_TONE[item.kind]}>{item.kind}</WorkBoardBadge><WorkBoardBadge tone={STATUS_TONE[item.status] ?? 'neutral'}>{item.status}</WorkBoardBadge>{item.slice_id && <WorkBoardBadge>{item.slice_id}</WorkBoardBadge>}</>}
        footer={<><span className="flex min-w-0 items-center gap-1"><Users className="h-3 w-3" /><span className="truncate">{item.run?.agent ?? item.owner_profile}</span></span><span className="flex items-center gap-1"><CheckSquare className="h-3 w-3" />{completedAcceptance}/{item.acceptance.length}</span>{item.depends_on.length > 0 && <span className="flex items-center gap-1"><Link2 className="h-3 w-3" />{item.depends_on.length}</span>}{item.run && <span className="ml-auto flex items-center gap-1 text-emerald-400"><Activity className="h-3 w-3" />{item.run.mode ?? 'run'}</span>}</>}
      />
      {item.blocked_reason && <p className="mt-2 line-clamp-2 rounded border border-red-500/20 bg-red-500/5 p-1.5 text-[9px] text-red-400">{item.blocked_reason}</p>}
    </WorkBoardCard>
  );
}
