import { expect, it } from 'vitest';
import { savedConnectionId } from '../api.js';
import { useSshSessions } from '../ssh-sessions.js';
import type { SshHost } from '../types.js';

it('keeps panes stable on focus and reconnect, and collapses when a sibling closes', () => {
  const s = useSshSessions.getState();
  const panes = () => useSshSessions.getState().panesByProject[83];
  for (const id of ['A', 'B']) s.add(83, { hostId: 'shared-host', terminalId: id, label: id });
  s.toggleSplit(83);
  expect(panes()).toEqual(['B', 'A']);
  s.setActive(83, 'A');
  expect(panes()).toEqual(['B', 'A']);
  s.add(83, { hostId: 'shared-host', terminalId: 'C', label: 'C' });
  expect(panes()).toEqual(['B', 'C']);
  s.swapTerminal(83, 'B', 'B2');
  expect(panes()).toEqual(['B2', 'C']);
  s.remove(83, 'C');
  expect(panes()).toEqual(['B2', 'A']);
  s.remove(83, 'A');
  expect(panes()).toBeUndefined();
  expect(useSshSessions.getState().activeByProject[83]).toBe('B2');
});

it('isolates equal local host row ids across projects and reuses a shared host', () => {
  const local = { id: 1, project_id: 10, is_shared: 0 } as SshHost;
  expect(savedConnectionId(local)).not.toBe(savedConnectionId({ ...local, project_id: 11 }));
  expect(savedConnectionId({ ...local, is_shared: 1 })).toBe(savedConnectionId({ ...local, project_id: 11, is_shared: 1 }));
});
