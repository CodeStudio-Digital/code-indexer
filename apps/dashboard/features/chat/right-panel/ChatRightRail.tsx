/**
 * Vertical activity rail on the RIGHT of an open coder session — the
 * counterpart to the VS Code activity bar. Each icon either toggles a
 * panel (Session state, Insights, Configuration, etc.) or fires a one-shot action
 * (Snapshots opens a modal directly).
 *
 * Layout: 40px width, sticky to the viewport right. Active icon shows a
 * primary-colored vertical bar on the inner edge — same indicator pattern
 * as the left `ProjectRail` in `ProjectView`, so the visual language is
 * consistent across rails.
 */
import { memo, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Bell,
  Bot,
  BookOpen,
  ChartNoAxesCombined,
  ClipboardList,
  Compass,
  GitCompare,
  HardDrive,
  MonitorPlay,
  ScrollText,
  Settings,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import { pluginWindowIcon } from '../../workspace/plugin-icon.js';
import type { ContribToolWindow } from '../../../state/contribution-registry.js';
import type { RightPanelId } from './types.js';
import { RailButton, RailContainer, RailSeparator } from '../../../components/chrome/index.js';

interface RailEntry {
  id: RightPanelId | 'snapshots';
  icon: LucideIcon;
  /** i18n key under `chat:` — built-in entries. */
  labelKey?: string;
  /** Literal label — plugin entries (title comes from the manifest). */
  label?: string;
  /** Snapshots is special: clicking opens a modal, not a panel. */
  kind: 'panel' | 'modal';
  /** Optional badge count — Snapshots uses it for pending hunks. */
  badge?: number;
}

interface ChatRightRailProps {
  sessionId: string;
  activePanelId: RightPanelId | null;
  onSelectPanel: (id: RightPanelId | null) => void;
  /** Fired when the user clicks the Snapshots icon. Optional. */
  onOpenSnapshots?: () => void;
  /** Pending snapshot count for the Snapshots badge. */
  pendingSnapshots?: number;
  /** Unread session-notification count for the Notifications badge. */
  unreadNotifications?: number;
  /** Plugin tool windows (side: 'right') — one rail icon each. */
  pluginWindows?: ContribToolWindow[];
  /** Whether the hosting project contributes its live preview to this rail. */
  previewAvailable?: boolean;
}

export const ChatRightRail = memo(function ChatRightRail({
  sessionId,
  activePanelId,
  onSelectPanel,
  onOpenSnapshots,
  pendingSnapshots,
  unreadNotifications,
  pluginWindows = [],
  previewAvailable = false,
}: ChatRightRailProps) {
  const { t } = useTranslation(['chat']);
  const [chapterCount, setChapterCount] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/coder/sessions/${sessionId}/chapters?limit=1`, { signal: controller.signal })
      .then((response) => response.ok ? response.json() : null)
      .then((page: { status?: { chapter_count?: number } } | null) => {
        if (!controller.signal.aborted) setChapterCount(page?.status?.chapter_count ?? 0);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [activePanelId, sessionId]);

  const pluginEntries = useMemo<RailEntry[]>(
    () =>
      pluginWindows
        .filter((w) => w.side === 'right')
        .map((w) => ({
          id: `plugin:${w.pluginNs}:${w.id}` as RightPanelId,
          icon: pluginWindowIcon(w.icon),
          label: w.title,
          kind: 'panel' as const,
        })),
    [pluginWindows],
  );

  // Grouped by purpose so the rail reads as intentional, not a flat dump:
  // context (what the agent is working with) → inspection (observe the run)
  // → plugins → a bottom-pinned Configuration cog (Skills + Tools tabs).
  const contextEntries = useMemo<RailEntry[]>(
    () => [
      { id: 'meta', icon: Compass, labelKey: 'rightRail.meta', kind: 'panel' },
      ...(previewAvailable
        ? [{ id: 'preview' as const, icon: MonitorPlay, labelKey: 'rightRail.preview', kind: 'panel' as const }]
        : []),
      { id: 'plans', icon: ClipboardList, labelKey: 'rightRail.plans', kind: 'panel' },
      { id: 'drive', icon: HardDrive, labelKey: 'rightRail.drive', kind: 'panel' },
      { id: 'chapters', icon: BookOpen, labelKey: 'rightRail.chapters', kind: 'panel', badge: chapterCount },
      { id: 'diagram', icon: Workflow, labelKey: 'rightRail.diagram', kind: 'panel' },
    ],
    [chapterCount, previewAvailable],
  );

  const inspectEntries = useMemo<RailEntry[]>(
    () => [
      { id: 'subagents', icon: Bot, labelKey: 'rightRail.subagents', kind: 'panel' },
      {
        id: 'notifications',
        icon: Bell,
        labelKey: 'rightRail.notifications',
        kind: 'panel',
        badge: unreadNotifications,
      },
      { id: 'collaboration', icon: Bot, labelKey: 'collaboration.title', kind: 'panel' },
      { id: 'insights', icon: ChartNoAxesCombined, labelKey: 'rightRail.insights', kind: 'panel' },
      { id: 'worker-log', icon: ScrollText, labelKey: 'rightRail.workerLog', kind: 'panel' },
      {
        id: 'snapshots',
        icon: GitCompare,
        labelKey: 'rightRail.snapshots',
        kind: 'modal',
        badge: pendingSnapshots,
      },
    ],
    [unreadNotifications, pendingSnapshots],
  );

  // Skills + Tools collapsed into one bottom-pinned cog (VS Code "Manage" pattern).
  const configEntry: RailEntry = {
    id: 'config',
    icon: Settings,
    labelKey: 'rightRail.config',
    kind: 'panel',
  };

  const renderEntry = (entry: RailEntry) => {
    const active = entry.kind === 'panel' && activePanelId === entry.id;
    const label = entry.label ?? t(`chat:${entry.labelKey}`, entry.id);
    const handleClick = () => {
      if (entry.kind === 'modal') {
        if (entry.id === 'snapshots') onOpenSnapshots?.();
        return;
      }
      // Toggle: clicking the active panel closes it.
      onSelectPanel(active ? null : (entry.id as RightPanelId));
    };
    return (
      <RailButton
        key={entry.id}
        icon={entry.icon}
        label={label}
        side="right"
        role="toggle"
        active={active}
        onClick={handleClick}
        badge={entry.badge}
      />
    );
  };

  return (
    <RailContainer side="right" aria-label="Session tools">
      {contextEntries.map(renderEntry)}
      <RailSeparator />
      {inspectEntries.map(renderEntry)}
      {pluginEntries.length > 0 && <RailSeparator />}
      {pluginEntries.map(renderEntry)}
      <div className="mt-auto flex flex-col items-center gap-0.5 pt-1">
        <RailSeparator />
        {renderEntry(configEntry)}
      </div>
    </RailContainer>
  );
});
