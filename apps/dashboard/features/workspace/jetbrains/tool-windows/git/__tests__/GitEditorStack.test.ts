import { describe, expect, it } from 'vitest';
import type { OpenGitLog, OpenGitStash } from '../../../../../../state/workspace.js';
import { GitEditorStack } from '../GitEditorStack.js';

describe('GitEditorStack', () => {
  it('mantem log e stash montados e alterna somente a visibilidade', () => {
    const log: OpenGitLog = {
      kind: 'git-log',
      projectId: 7,
      path: 'gitlog:main',
      title: 'Log: main',
      branch: 'main',
      isRemote: false,
    };
    const stash: OpenGitStash = {
      kind: 'git-stash',
      projectId: 7,
      path: 'gitstash:stash@{0}',
      title: 'Stash 0',
      stashRef: 'stash@{0}',
    };

    const stack = GitEditorStack({ tabs: [log, stash], activePath: stash.path });
    const surfaces = stack.props.children as Array<{
      key: string;
      props: { 'aria-hidden': boolean; className: string };
    }>;

    expect(surfaces.map((surface) => surface.key)).toEqual([log.path, stash.path]);
    expect(surfaces[0].props['aria-hidden']).toBe(true);
    expect(surfaces[0].props.className).toContain('invisible');
    expect(surfaces[1].props['aria-hidden']).toBe(false);
    expect(surfaces[1].props.className).toContain('visible');
  });
});
