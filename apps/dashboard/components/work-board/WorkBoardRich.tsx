import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog.js';
import { cn } from '../../lib/utils.js';

export type WorkBoardTone = 'neutral' | 'blue' | 'amber' | 'violet' | 'green' | 'red';

const TONE: Record<WorkBoardTone, string> = {
  neutral: 'border-border bg-muted/60 text-muted-foreground',
  blue: 'border-blue-500/30 bg-blue-500/10 text-blue-400',
  amber: 'border-amber-500/30 bg-amber-500/10 text-amber-400',
  violet: 'border-violet-500/30 bg-violet-500/10 text-violet-400',
  green: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
  red: 'border-red-500/30 bg-red-500/10 text-red-400',
};

export function WorkBoardBadge({ children, tone = 'neutral', className }: { children: ReactNode; tone?: WorkBoardTone; className?: string }) {
  return <span className={cn('inline-flex items-center rounded border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide', TONE[tone], className)}>{children}</span>;
}

export function WorkBoardCardContent({
  title,
  description,
  badges,
  leading,
  trailing,
  footer,
}: {
  title: ReactNode;
  description?: ReactNode;
  badges?: ReactNode;
  leading?: ReactNode;
  trailing?: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <>
      <div className="flex items-start gap-2">
        {leading}
        <div className="min-w-0 flex-1">
          <div className="line-clamp-2 text-[13px] font-semibold leading-[1.25]">{title}</div>
          {description && <div className="mt-1 line-clamp-2 text-[11px] leading-4 text-muted-foreground">{description}</div>}
        </div>
        {trailing}
      </div>
      {badges && <div className="mt-2 flex flex-wrap items-center gap-1">{badges}</div>}
      {footer && <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border/50 pt-2 text-[10px] text-muted-foreground">{footer}</div>}
    </>
  );
}

export function WorkBoardProgress({ value, max, tone = 'green' }: { value: number; max: number; tone?: 'green' | 'amber' | 'violet' }) {
  const percentage = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  const color = tone === 'amber' ? 'bg-amber-500' : tone === 'violet' ? 'bg-violet-500' : 'bg-emerald-500';
  return <div className="h-1.5 overflow-hidden rounded-full bg-muted"><div className={cn('h-full transition-[width]', color)} style={{ width: `${percentage}%` }} /></div>;
}

export function WorkBoardSection({ icon: Icon, title, count, action, children }: { icon?: LucideIcon; title: ReactNode; count?: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="mt-5">
      <div className="mb-2 flex items-center gap-1.5">
        {Icon && <Icon className="h-4 w-4 text-muted-foreground" />}
        <h4 className="text-xs font-semibold uppercase tracking-[0.06em] text-muted-foreground">{title}</h4>
        {count != null && <span className="text-[10px] text-muted-foreground">({count})</span>}
        {action && <div className="ml-auto">{action}</div>}
      </div>
      {children}
    </section>
  );
}

export function WorkBoardDetailDialog({ open, onClose, badges, title, subtitle, children, footer }: { open: boolean; onClose: () => void; badges?: ReactNode; title: ReactNode; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <Dialog open={open} onOpenChange={(value) => !value && onClose()}>
      <DialogContent className="max-h-[88vh] max-w-2xl overflow-y-auto p-0">
        <DialogHeader className="sticky top-0 z-10 border-b bg-background/95 px-6 pb-4 pt-5 backdrop-blur">
          {badges && <div className="flex flex-wrap items-center gap-1.5">{badges}</div>}
          <DialogTitle className="pr-6 leading-tight">{title}</DialogTitle>
          {subtitle && <div className="text-xs text-muted-foreground">{subtitle}</div>}
        </DialogHeader>
        <div className="px-6 py-4">{children}</div>
        {footer && <footer className="sticky bottom-0 flex items-center gap-2 border-t bg-background/95 px-6 py-3 backdrop-blur">{footer}</footer>}
      </DialogContent>
    </Dialog>
  );
}

export function WorkBoardToolbar({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex min-h-11 shrink-0 items-center gap-2 border-b border-border/70 bg-muted/10 px-3 py-1.5 text-xs', className)}>{children}</div>;
}
