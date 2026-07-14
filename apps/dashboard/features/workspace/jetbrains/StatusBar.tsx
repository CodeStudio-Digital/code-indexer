/**
 * Status bar at the very bottom of the Workspace — IDE convention.
 *
 * Surface: project · active file · unsaved count ·
 * indexed/total file + symbol totals · language label (with LSP
 * support indicator). The LSP indicator pulls double duty as a hint:
 * green for TS/JS (full IntelliSense), amber for everything else
 * (syntax highlight only).
 */

import { memo } from 'react';
import { Circle, FileText } from 'lucide-react';
import { FileIcon } from '../../../components/FileIcon.js';
import { useWorkspaceStore } from '../../../state/workspace.js';
import { apiCall } from '../../../lib/api-client.js';
import { useContributions, type ContribStatusBarItem } from '../../../state/contribution-registry.js';
import { ProjectSwitcher } from '../../../components/ProjectSwitcher.js';
import { StatusBarShell } from '../../../components/chrome/index.js';
import { IndexStatusSection } from './status-bar/IndexStatusSection.js';
import { LanguageChip } from './status-bar/LanguageChip.js';
import { LanguageLevelChip } from './status-bar/LanguageLevelChip.js';
import { AiCompleteChip } from './status-bar/AiCompleteChip.js';

interface StatusBarProps {
  projectId: number;
  projectName: string;
}

function StatusBarImpl({ projectId, projectName }: StatusBarProps) {
  const activeFilePath = useWorkspaceStore((s) => s.activeFilePath);
  const dirtyCount = useWorkspaceStore(
    (s) => s.openFiles.filter((f) => f.kind !== 'diff' && f.dirty && f.projectId === projectId).length,
  );
  // The indexing chip + file/symbol counters live in IndexStatusSection,
  // which owns the live subscription so progress frames re-render only that
  // small section. Git/branch actions now live exclusively in the top toolbar.
  const statusItems = useContributions((s) => s.statusBarItems);

  const runStatusItem = async (item: ContribStatusBarItem): Promise<void> => {
    if (!item.runsTool) return;
    await apiCall('plugins.invokeTool', {
      namespace: item.pluginNs,
      tool: item.runsTool,
      args: {},
      projectId,
    }).catch(() => undefined);
  };

  const leftStatusItems = statusItems
    .filter((item) => (item.alignment ?? 'left') === 'left')
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  const rightStatusItems = statusItems
    .filter((item) => item.alignment === 'right')
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

  return (
    <StatusBarShell>
      {/* Project name doubles as a quick switcher; opens upward (status bar
          hugs the bottom edge). */}
      <ProjectSwitcher
        currentProjectId={projectId}
        side="top"
        align="start"
        triggerClassName="inline-flex items-center gap-1 truncate rounded px-1 -mx-1 transition-colors hover:bg-muted/40 hover:text-foreground"
      >
        <Circle className="h-1.5 w-1.5 fill-green-500 text-green-500" />
        <span className="truncate max-w-[160px]">{projectName}</span>
      </ProjectSwitcher>
      {leftStatusItems.map((item) => (
        <button
          key={`${item.pluginNs}:${item.id}`}
          type="button"
          title={item.tooltip ?? item.label}
          onClick={() => void runStatusItem(item)}
          className="inline-flex items-center gap-1 rounded px-1 -mx-1 transition-colors hover:bg-muted/40 hover:text-foreground"
        >
          <span className="text-muted-foreground">{item.label}</span>
        </button>
      ))}
      <span className="opacity-40">·</span>
      <span className="inline-flex items-center gap-1 truncate max-w-[420px]">
        {activeFilePath ? (
          <FileIcon path={activeFilePath} className="h-2.5 w-2.5" />
        ) : (
          <FileText className="h-2.5 w-2.5 text-muted-foreground" />
        )}
        <span className="truncate">{activeFilePath ?? 'No file'}</span>
        {dirtyCount > 0 && (
          <span className="ml-1 text-foreground/80">({dirtyCount} unsaved)</span>
        )}
      </span>
      <span className="ml-auto inline-flex items-center gap-3">
        {rightStatusItems.map((item) => (
          <button
            key={`${item.pluginNs}:${item.id}`}
            type="button"
            title={item.tooltip ?? item.label}
            onClick={() => void runStatusItem(item)}
            className="inline-flex items-center gap-1 rounded px-1 -mx-1 transition-colors hover:bg-muted/40 hover:text-foreground"
          >
            <span>{item.label}</span>
          </button>
        ))}
        <IndexStatusSection projectId={projectId} />
        {/* Language-intelligence tier for the active file: built-in TS
            service / installed LSP server (green), structural-index
            fallback (sky) or syntax-only (amber). */}
        <LanguageChip projectId={projectId} activeFilePath={activeFilePath} />
        {/* Seletor de versão da linguagem (PHP/Python) — auto-oculta para as demais. */}
        <LanguageLevelChip projectId={projectId} activeFilePath={activeFilePath} />
        <span className="opacity-40">·</span>
        <AiCompleteChip />
      </span>
    </StatusBarShell>
  );
}

/** Memoized: only re-render when projectId/projectName change (parent churn). */
export const StatusBar = memo(StatusBarImpl);
