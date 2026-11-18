import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { Info } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Popover, PopoverContent, PopoverTrigger } from '../../../components/ui/popover.js';
import type { TurnTokens } from '../../../lib/turn-tokens.js';
import type { TurnFramePart } from './transcript-segments.js';

const ActiveTurnInfo = createContext<{ current: (() => void) | null } | null>(null);

export function TurnInfoScope({ children }: { children: ReactNode }) {
  const active = useRef<(() => void) | null>(null);
  return <ActiveTurnInfo.Provider value={active}>{children}</ActiveTurnInfo.Provider>;
}

export function TurnFrame({ part, live, children }: { part?: TurnFramePart; live?: boolean; children: ReactNode }) {
  return <div className="chat-turn-frame" data-turn-frame={part ? '' : undefined} data-live={live || undefined}
    data-turn-start={part?.first || undefined} data-turn-end={part?.last || undefined}>
    {children}
    {part?.first && <TurnInfo tokens={part.tokens} />}
  </div>;
}

function TurnInfo({ tokens }: { tokens: TurnTokens }) {
  const { t } = useTranslation('chat');
  const [mode, setMode] = useState<'closed' | 'hover' | 'pinned'>('closed');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const active = useContext(ActiveTurnInfo);
  const close = useCallback(() => {
    clearTimeout(timer.current);
    setMode('closed');
  }, []);
  useEffect(() => () => {
    clearTimeout(timer.current);
    if (active?.current === close) active.current = null;
  }, [active, close]);
  function open(nextMode: 'hover' | 'pinned') {
    clearTimeout(timer.current);
    if (active && active.current !== close) {
      active.current?.();
      active.current = close;
    }
    setMode(current => current === 'pinned' ? current : nextMode);
  }
  const leave = (event: PointerEvent) => {
    if (event.pointerType !== 'mouse') return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setMode(current => current === 'hover' ? 'closed' : current), 140);
  };
  return <Popover open={mode !== 'closed'} onOpenChange={show => show ? open('pinned') : close()}>
    <PopoverTrigger asChild>
      <button type="button" data-turn-usage-trigger aria-label={t('messages.turnTokens')} className="chat-turn-info"
        onPointerEnter={event => { if (event.pointerType === 'mouse') open('hover'); }} onPointerLeave={leave} onClick={event => {
          if (mode === 'hover') { event.preventDefault(); open('pinned'); }
        }}>
        <Info aria-hidden="true" />
      </button>
    </PopoverTrigger>
    <PopoverContent side="right" align="center" sideOffset={4} collisionPadding={8}
      data-turn-usage aria-label={t('messages.turnTokens')} className="w-52 max-w-[calc(100vw-1rem)] border-primary/35 p-3 text-xs data-[state=closed]:hidden"
      onPointerEnter={() => clearTimeout(timer.current)} onPointerLeave={leave}
      onOpenAutoFocus={event => event.preventDefault()} onCloseAutoFocus={event => event.preventDefault()}>
      <TurnTokenDetails tokens={tokens} />
    </PopoverContent>
  </Popover>;
}

function TurnTokenDetails({ tokens }: { tokens: TurnTokens }) {
  const { t, i18n } = useTranslation('chat');
  const numbers = useMemo(() => new Intl.NumberFormat(i18n.resolvedLanguage), [i18n.resolvedLanguage]);
  return <>
    <p className="mb-2 font-medium text-foreground">{t('messages.turnTokens')}</p>
    <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-muted-foreground [&_dd]:text-right [&_dd]:tabular-nums [&_dd]:text-foreground">
      <dt>{t('metrics.tokens.input')}</dt><dd>{numbers.format(tokens.input_tokens)}</dd>
      <dt>{t('metrics.tokens.output')}</dt><dd>{numbers.format(tokens.output_tokens)}</dd>
      {!!tokens.cache_read_tokens && <><dt>{t('metrics.tokens.cacheRead')}</dt><dd>{numbers.format(tokens.cache_read_tokens)}</dd></>}
      {!!tokens.cache_creation_tokens && <><dt>{t('metrics.tokens.cacheCreation')}</dt><dd>{numbers.format(tokens.cache_creation_tokens)}</dd></>}
    </dl>
  </>;
}
