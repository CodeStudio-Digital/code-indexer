/**
 * Open-request tabs for the active collection — clicking a request opens (or
 * focuses) a tab; multiple stay open and each is closable, like the code editor's
 * file tabs. Mirrors features/workspace/EditorTabBar TabChip behavior (active
 * accent, hover-reveal close, middle-click close). The unsaved "Untitled" draft
 * is a tab too (negative id) and shows a dirty dot.
 */
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/utils.js';
import { METHOD_COLOR, pathOnly } from './collection/row-format.js';
import type { ApiRequest } from './types.js';

interface Props {
  requests: ApiRequest[];
  draftRequest: ApiRequest | null;
  draftDirty: boolean;
  openTabIds: number[];
  activeRequestId: number | null;
  onActivate: (id: number) => void;
  onClose: (id: number) => void;
}

interface TabInfo { name: string; method: string; dirty: boolean }

export function RequestTabBar({ requests, draftRequest, draftDirty, openTabIds, activeRequestId, onActivate, onClose }: Props) {
  const { t } = useTranslation('apiClient');

  if (openTabIds.length === 0) {
    return <div className="h-8 shrink-0 border-b flex items-center px-3 text-[11px] text-muted-foreground">{t('tabs.noRequestOpen')}</div>;
  }

  const resolve = (id: number): TabInfo | null => {
    if (id < 0) return draftRequest ? { name: draftRequest.name, method: draftRequest.method, dirty: draftDirty } : null;
    const r = requests.find((x) => x.id === id);
    return r ? { name: r.name || pathOnly(r.path_template), method: r.method, dirty: false } : null;
  };

  return (
    <div className="h-8 shrink-0 border-b flex items-stretch overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
      {openTabIds.map((id) => {
        const info = resolve(id);
        if (!info) return null;
        const active = id === activeRequestId;
        return (
          <div
            key={id}
            onClick={() => onActivate(id)}
            onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); onClose(id); } }}
            title={info.name}
            className={cn(
              // Shrink to fit the bar (each tab truncates with "…"); a min-width floor
              // keeps the method+close usable, and the row scrolls only past that point.
              'group/tab relative flex items-center gap-1.5 pl-2.5 pr-1 min-w-[96px] max-w-[200px] shrink cursor-pointer border-r border-border/40 text-xs select-none',
              active ? 'bg-background text-foreground' : 'text-muted-foreground hover:bg-muted/50',
            )}
          >
            {active && <div className="absolute left-0 right-0 top-0 h-0.5 bg-primary" />}
            <span className={cn('font-mono font-semibold text-[9px] shrink-0', METHOD_COLOR[info.method] ?? '')}>{info.method}</span>
            <span className="flex-1 min-w-0 truncate">{info.name}</span>
            {info.dirty && <span className="h-1.5 w-1.5 rounded-full bg-foreground/60 shrink-0 group-hover/tab:hidden" aria-hidden />}
            <button
              type="button"
              aria-label={t('tabs.closeAria', { name: info.name })}
              onClick={(e) => { e.stopPropagation(); onClose(id); }}
              className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground shrink-0 hidden group-hover/tab:inline-flex"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
