/**
 * Residency bounds for the session-keyed diagram store.
 *
 * The store holds full mxGraph XML per session. Before the cap it grew for the
 * life of the renderer, so these tests pin the two properties that matter:
 * idle sessions are evicted past the cap, and a session whose panel is open
 * (has subscribers) is never evicted out from under it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getDiagram,
  setDiagramXml,
  subscribeDiagram,
} from '../diagram-store.js';

/** Module state is process-global; each test uses a fresh session-id range. */
let nextBase = 1_000;
beforeEach(() => {
  nextBase += 1_000;
});

describe('diagram store residency', () => {
  it('keeps the most recent sessions and drops the oldest past the cap', () => {
    const ids = Array.from({ length: 10 }, (_, i) => nextBase + i);
    for (const id of ids) setDiagramXml(id, `d-${id}.drawio`, `<mxGraph id="${id}"/>`);

    // 10 written, 8 resident: the two least-recently-written are gone.
    expect(getDiagram(ids[0])).toBeNull();
    expect(getDiagram(ids[1])).toBeNull();
    for (const id of ids.slice(2)) {
      expect(getDiagram(id), `session ${id} should still be resident`).not.toBeNull();
    }
  });

  it('re-writing a session refreshes its recency instead of aging out', () => {
    const ids = Array.from({ length: 8 }, (_, i) => nextBase + i);
    for (const id of ids) setDiagramXml(id, 'a.drawio', `<mxGraph id="${id}"/>`);

    // Touch the oldest, then push two new sessions past the cap.
    setDiagramXml(ids[0], 'a.drawio', '<mxGraph id="refreshed"/>');
    setDiagramXml(nextBase + 100, 'b.drawio', '<mxGraph/>');
    setDiagramXml(nextBase + 101, 'c.drawio', '<mxGraph/>');

    expect(getDiagram(ids[0])?.xml).toBe('<mxGraph id="refreshed"/>');
    expect(getDiagram(ids[1])).toBeNull(); // aged out in its place
  });

  it('never evicts a session that still has subscribers', () => {
    const watched = nextBase;
    setDiagramXml(watched, 'watched.drawio', '<mxGraph id="watched"/>');
    const unsubscribe = subscribeDiagram(watched, () => undefined);

    // Flood well past the cap; the watched panel is on screen and must survive.
    for (let i = 1; i <= 20; i++) {
      setDiagramXml(nextBase + i, `d${i}.drawio`, '<mxGraph/>');
    }
    expect(getDiagram(watched)?.xml).toBe('<mxGraph id="watched"/>');

    // Once the panel closes it becomes evictable like any other idle entry.
    unsubscribe();
    for (let i = 21; i <= 40; i++) {
      setDiagramXml(nextBase + i, `d${i}.drawio`, '<mxGraph/>');
    }
    expect(getDiagram(watched)).toBeNull();
  });

  it('still notifies subscribers on write', () => {
    const id = nextBase;
    const seen = vi.fn();
    const unsubscribe = subscribeDiagram(id, seen);
    setDiagramXml(id, 'x.drawio', '<mxGraph/>');
    expect(seen).toHaveBeenCalledTimes(1);

    setDiagramXml(id, 'x.drawio', '<mxGraph/>'); // identical → still a no-op
    expect(seen).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});
