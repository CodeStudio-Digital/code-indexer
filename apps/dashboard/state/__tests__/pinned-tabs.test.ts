import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  buildProjectPin,
  buildRailPin,
  buildSessionPin,
  describeCurrentPin,
} from '../pinned-tabs-describe.js';
import { computeActiveId } from '../pinned-tabs-activate.js';
import { usePinnedTabs } from '../pinned-tabs.js';
import type { ActiveView } from '../../lib/route-view.js';

function installStorage(): void {
  const m = new Map<string, string>();
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: {
      getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
    },
  };
}

const projectView = (projectId: number, sessionId: number | null = null): ActiveView => ({
  page: 'project',
  projectId,
  sessionId,
});

describe('pin builders', () => {
  it('project pin: deterministic id + route', () => {
    const p = buildProjectPin({ projectId: 42, name: 'poa-backend' });
    expect(p).toMatchObject({ kind: 'project', id: 'project:42', href: '/projects/42', label: 'poa-backend', icon: 'FolderGit2' });
  });

  it('rail pin: url carries ?tab=, label prefixes project name', () => {
    const p = buildRailPin({ projectId: 7, tabId: 'databases', label: 'Databases', projectName: 'poa' });
    expect(p).toMatchObject({ kind: 'rail', id: 'rail:7:databases', href: '/projects/7?tab=databases', tabId: 'databases' });
    expect(p.label).toBe('poa: Databases');
    expect(p.icon).toBe('Server');
  });

  it('session pins encode scope in id + href', () => {
    expect(buildSessionPin({ scope: 'project', sessionId: 5, projectId: 42, title: 'x' })).toMatchObject({
      id: 'session:project:5',
      href: '/projects/42?session=5',
    });
    expect(buildSessionPin({ scope: 'global', sessionId: 9 })).toMatchObject({
      id: 'session:global:9',
      href: '/global?session=9',
      label: 'Session 9',
    });
  });
});

describe('describeCurrentPin', () => {
  const base = { pathname: '/', search: '', activeProjectTab: null, names: {} };

  it('returns null on non-pinnable pages', () => {
    expect(describeCurrentPin({ ...base, view: { page: 'home', projectId: null, sessionId: null } })).toBeNull();
    expect(describeCurrentPin({ ...base, view: { page: 'admin', projectId: null, sessionId: null } })).toBeNull();
  });

  it('project with no session/tab → project pin', () => {
    const p = describeCurrentPin({ ...base, pathname: '/projects/42', view: projectView(42), names: { projectName: 'poa' } });
    expect(p?.kind).toBe('project');
  });

  it('project + live rail tab → rail pin (from active-surface)', () => {
    const p = describeCurrentPin({
      ...base,
      pathname: '/projects/42',
      view: projectView(42),
      activeProjectTab: { projectId: 42, tab: 'databases' },
    });
    expect(p?.kind).toBe('rail');
    expect(p?.href).toBe('/projects/42?tab=databases');
  });

  it('project + chat tab → project pin (chat is not a rail)', () => {
    const p = describeCurrentPin({
      ...base,
      pathname: '/projects/42',
      view: projectView(42),
      activeProjectTab: { projectId: 42, tab: 'chat' },
    });
    expect(p?.kind).toBe('project');
  });

  it('project + ?session → session pin', () => {
    const p = describeCurrentPin({ ...base, pathname: '/projects/42', search: '?session=5', view: projectView(42, 5) });
    expect(p).toMatchObject({ kind: 'session', scope: 'project', href: '/projects/42?session=5' });
  });

  it('company path → company session pin keeping the full href', () => {
    const path = '/company/sessions/12/main/work/board';
    const p = describeCurrentPin({ ...base, pathname: path, view: { page: 'agents', projectId: null, sessionId: null } });
    expect(p).toMatchObject({ kind: 'session', scope: 'company', id: 'session:company:12', href: path });
  });
});

describe('computeActiveId', () => {
  const project = buildProjectPin({ projectId: 42, name: 'poa' });
  const rail = buildRailPin({ projectId: 42, tabId: 'databases' });
  const session = buildSessionPin({ scope: 'project', sessionId: 5, projectId: 42 });
  const pins = [project, rail, session];

  it('highlights the project pin on a bare project view', () => {
    expect(
      computeActiveId(pins, { view: projectView(42), pathname: '/projects/42', search: '', activeProjectTab: null }),
    ).toBe('project:42');
  });

  it('highlights the rail pin when its tab is live', () => {
    expect(
      computeActiveId(pins, {
        view: projectView(42),
        pathname: '/projects/42',
        search: '',
        activeProjectTab: { projectId: 42, tab: 'databases' },
      }),
    ).toBe('rail:42:databases');
  });

  it('highlights the session pin when ?session matches', () => {
    expect(
      computeActiveId(pins, { view: projectView(42, 5), pathname: '/projects/42', search: '?session=5', activeProjectTab: null }),
    ).toBe('session:project:5');
  });

  it('no match on an unrelated page', () => {
    expect(
      computeActiveId(pins, { view: { page: 'home', projectId: null, sessionId: null }, pathname: '/', search: '', activeProjectTab: null }),
    ).toBeNull();
  });
});

describe('pinned-tabs store', () => {
  beforeEach(() => {
    installStorage();
    usePinnedTabs.getState().clear();
  });
  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window;
  });

  it('togglePin adds then removes by id', () => {
    const p = buildProjectPin({ projectId: 1 });
    usePinnedTabs.getState().togglePin(p);
    expect(usePinnedTabs.getState().isPinned('project:1')).toBe(true);
    usePinnedTabs.getState().togglePin(p);
    expect(usePinnedTabs.getState().isPinned('project:1')).toBe(false);
  });

  it('pin upserts (no duplicate id)', () => {
    usePinnedTabs.getState().pin(buildProjectPin({ projectId: 1, name: 'a' }));
    usePinnedTabs.getState().pin(buildProjectPin({ projectId: 1, name: 'b' }));
    const pins = usePinnedTabs.getState().pins;
    expect(pins).toHaveLength(1);
    expect(pins[0].label).toBe('b');
  });

  it('reorder moves a pin before another', () => {
    const s = usePinnedTabs.getState();
    s.pin(buildProjectPin({ projectId: 1 }));
    s.pin(buildProjectPin({ projectId: 2 }));
    s.pin(buildProjectPin({ projectId: 3 }));
    s.reorder('project:3', 'project:1');
    expect(usePinnedTabs.getState().pins.map((p) => p.id)).toEqual(['project:3', 'project:1', 'project:2']);
  });

  it('reorder with null appends to the end', () => {
    const s = usePinnedTabs.getState();
    s.pin(buildProjectPin({ projectId: 1 }));
    s.pin(buildProjectPin({ projectId: 2 }));
    s.reorder('project:1', null);
    expect(usePinnedTabs.getState().pins.map((p) => p.id)).toEqual(['project:2', 'project:1']);
  });
});
