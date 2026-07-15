/**
 * Right pane host: status line + response tabs (Body · Headers · Test Results ·
 * Cookies · Timing) + the "Set as expected" verify action. Delegates rendering to
 * the response/* components.
 */
import { useState, type ComponentType } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, Braces, List, FlaskConical, Cookie, Clock, BookmarkPlus } from 'lucide-react';
import { cn } from '../../lib/utils.js';
import type { SendResponse } from './types.js';
import { ResponseBody } from './response/ResponseBody.js';
import { ResponseHeaders } from './response/ResponseHeaders.js';
import { TestResultsTab } from './response/TestResultsTab.js';
import { CookiesTab } from './response/CookiesTab.js';
import { TimingTab } from './response/TimingTab.js';
import { formatBytes } from './response/format-body.js';

function statusColor(s: number): string {
  if (s < 300) return 'text-emerald-500';
  if (s < 400) return 'text-blue-500';
  if (s < 500) return 'text-amber-500';
  return 'text-red-500';
}

type Tab = 'body' | 'headers' | 'tests' | 'cookies' | 'timing';

type BadgeTone = 'primary' | 'danger' | 'success';
interface TabDef {
  id: Tab;
  label: string;
  Icon: ComponentType<{ className?: string }>;
  badge?: number;
  badgeTone?: BadgeTone;
}
const badgeClass = (tone?: BadgeTone): string =>
  tone === 'danger' ? 'text-red-500' : tone === 'success' ? 'text-emerald-500' : 'text-primary';

// Label slides in on hover/focus (collapsed) or stays out (expanded) — same
// animation as SidebarAction / AppShell NavButton. Classes are LITERAL so
// Tailwind's JIT generates them (no interpolation). Host element needs `group/act`.
const revealLabel = (expanded: boolean): string =>
  cn('overflow-hidden whitespace-nowrap transition-all duration-150 ease-out',
    expanded
      ? 'ml-1.5 max-w-[140px] opacity-100'
      : 'ml-0 max-w-0 opacity-0 group-hover/act:ml-1.5 group-hover/act:max-w-[140px] group-hover/act:opacity-100 group-focus-visible/act:ml-1.5 group-focus-visible/act:max-w-[140px] group-focus-visible/act:opacity-100');

interface Props {
  response: SendResponse | null;
  error: string | null;
  sending: boolean;
  verifiedStatus?: number | null;
  onMarkVerified?: (status: number) => void;
  /** Save the current response as a documentation example (saved-request only). */
  onSaveExample?: () => void;
}

export function ResponseViewer({ response, error, sending, verifiedStatus, onMarkVerified, onSaveExample }: Props) {
  const { t } = useTranslation('apiClient');
  const [tab, setTab] = useState<Tab>('body');

  if (sending) return <div className="h-full flex items-center justify-center text-xs text-muted-foreground">{t('response.sending')}</div>;
  if (error) return <div className="h-full flex items-start p-3 text-xs text-red-500 font-mono whitespace-pre-wrap">{error}</div>;
  if (!response) return <div className="h-full flex items-center justify-center text-xs text-muted-foreground">{t('response.emptyState')}</div>;

  const tests = response.tests ?? [];
  const failedTests = tests.filter((t) => !t.passed).length;
  const testBadge = failedTests || tests.length || response.updatedVars?.length || (response.scriptError ? 1 : 0) || undefined;
  const tabs: TabDef[] = [
    { id: 'body', label: t('response.tabBody'), Icon: Braces },
    { id: 'headers', label: t('response.tabHeaders'), Icon: List, badge: Object.keys(response.headers).length, badgeTone: 'primary' },
    { id: 'tests', label: t('response.tabTestResults'), Icon: FlaskConical, badge: testBadge, badgeTone: failedTests || response.scriptError ? 'danger' : 'success' },
    { id: 'cookies', label: t('response.tabCookies'), Icon: Cookie, badge: response.cookies?.length, badgeTone: 'primary' },
    { id: 'timing', label: t('response.tabTiming'), Icon: Clock },
  ];

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 px-3 h-10 border-b text-xs shrink-0">
        <span className={cn('font-mono font-semibold', statusColor(response.status))}>{response.status} {response.statusText}</span>
        <span className="text-muted-foreground">{response.ms} ms</span>
        <span className="text-muted-foreground">{formatBytes(response.size ?? response.body.length)}</span>
        {onMarkVerified && (
          <button
            type="button"
            onClick={() => onMarkVerified(response.status)}
            aria-label={t('response.markVerifiedTitle')}
            title={t('response.markVerifiedTitle')}
            className={cn(
              'group/act ml-auto inline-flex items-center h-6 rounded px-1 transition-colors',
              verifiedStatus === response.status ? 'text-emerald-500' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
            <span className={cn('text-xs', revealLabel(false))}>
              {verifiedStatus === response.status ? t('response.verified') : t('response.setAsExpected')}
            </span>
          </button>
        )}
        {onSaveExample && (
          <button
            type="button"
            onClick={onSaveExample}
            aria-label={t('response.saveExample')}
            title={t('response.saveExample')}
            className={cn('group/act inline-flex items-center h-6 rounded px-1 text-muted-foreground hover:text-foreground transition-colors', !onMarkVerified && 'ml-auto')}
          >
            <BookmarkPlus className="h-3.5 w-3.5 shrink-0" />
            <span className={cn('text-xs', revealLabel(false))}>{t('response.saveExample')}</span>
          </button>
        )}
      </div>
      <div className="flex items-center gap-0.5 px-2 border-b text-xs shrink-0">
        {tabs.map(({ id, label, Icon, badge, badgeTone }) => {
          const isActive = tab === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              aria-label={label}
              title={label}
              className={cn(
                'group/act relative flex items-center px-2 py-1.5 -mb-px border-b-2 transition-colors',
                isActive ? 'border-primary text-foreground font-medium' : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              <Icon className="h-3.5 w-3.5 shrink-0" />
              <span className={revealLabel(isActive)}>{label}</span>
              {badge != null && badge > 0 && (
                <span className={cn('ml-1 text-[10px] font-medium shrink-0', badgeClass(badgeTone))}>{badge}</span>
              )}
            </button>
          );
        })}
      </div>
      <div data-text-selectable className="flex-1 min-h-0">
        {tab === 'body' && <ResponseBody body={response.body} headers={response.headers} truncated={response.truncated} />}
        {tab === 'headers' && <div className="h-full overflow-auto"><ResponseHeaders headers={response.headers} /></div>}
        {tab === 'tests' && <TestResultsTab tests={response.tests} consoleLogs={response.consoleLogs} scriptError={response.scriptError} updatedVars={response.updatedVars} />}
        {tab === 'cookies' && <CookiesTab cookies={response.cookies} />}
        {tab === 'timing' && <TimingTab response={response} />}
      </div>
    </div>
  );
}
