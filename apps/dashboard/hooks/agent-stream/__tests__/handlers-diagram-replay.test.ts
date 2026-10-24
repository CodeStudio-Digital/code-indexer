import { afterEach, expect, it, vi } from 'vitest';
import { createEventHandlers } from '../handlers.js';

afterEach(() => vi.unstubAllGlobals());
it('replays old diagram export events without commanding a renderer or filesystem effect', () => {
  const dispatchEvent = vi.fn();
  vi.stubGlobal('window', { dispatchEvent });
  const handlers = createEventHandlers({ sid: '00000000-0000-4000-8000-000000000001', blocks: [], toolIndex: new Map(),
    flush: vi.fn(), flushNow: vi.fn(), updateSession: vi.fn() });
  for (let replay = 0; replay < 3; replay++) handlers.diagram_export_request({ path: 'diagrams/old.drawio', format: 'png' }, 'diagram_export_request');
  expect(dispatchEvent).not.toHaveBeenCalled();
});
