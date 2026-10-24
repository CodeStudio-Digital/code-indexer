import { cn } from '../../../../../lib/utils.js';
import type { OpenGitLog, OpenGitStash } from '../../../../../state/workspace.js';
import { GitLogView } from './GitLogView.js';
import { StashDetailView } from './StashDetailView.js';

type RetainedGitEditorTab = OpenGitLog | OpenGitStash;

/**
 * Retains navigation-heavy Git editor surfaces while sibling diffs are open.
 * Diffs intentionally stay on-demand: a large patch creates a large DOM tree,
 * while Log/Stash benefit substantially from preserving selection and scroll.
 */
export function GitEditorStack({
  tabs,
  activePath,
}: {
  tabs: RetainedGitEditorTab[];
  activePath: string | null;
}) {
  return (
    <>
      {tabs.map((tab) => {
        const active = tab.path === activePath;
        return (
          <div
            key={tab.path}
            aria-hidden={!active}
            data-git-editor-path={tab.path}
            className={cn(
              'absolute inset-0',
              active ? 'visible z-10' : 'invisible pointer-events-none z-0',
            )}
          >
            {tab.kind === 'git-log' ? <GitLogView tab={tab} /> : <StashDetailView tab={tab} />}
          </div>
        );
      })}
    </>
  );
}
