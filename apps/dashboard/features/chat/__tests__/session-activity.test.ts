import { describe, it, expect } from 'vitest';
import { executingSessionIds } from '../session-activity.js';

describe('session running indicators', () => {
  const row = { id: 'a', status: 'in_progress', runtime_active: true, runtime_bus_id: 'old' };
  it('lets terminal SSE clear a stale list and poll for that run', () => {
    expect([...executingSessionIds([row], { a: { active: false, terminal: true, busId: 'old' } }, {
      active: [{ session_id: 'a', bus_id: 'old' }],
    })]).toEqual([]);
  });
  it('uses real worker activity for a chat never opened in this renderer', () => {
    expect([...executingSessionIds([row], {}, { active: [] })]).toEqual([]);
    expect([...executingSessionIds([{ ...row, runtime_active: false }], {}, null)]).toEqual([]);
  });
  it('does not hide a new run started by another surface', () => {
    expect([...executingSessionIds([row], { a: { active: false, terminal: true, busId: 'old' } }, {
      active: [{ session_id: 'a', bus_id: 'new' }],
    })]).toEqual(['a']);
  });
  it('shows local startup before the backend has admitted its worker', () => {
    expect([...executingSessionIds([row], { a: { active: true, terminal: false } }, { active: [] })]).toEqual(['a']);
  });
  it('does not mistake a client disconnect for worker completion', () => {
    expect([...executingSessionIds([row], { a: { active: false, terminal: false } }, {
      active: [{ session_id: 'a', bus_id: 'old' }],
    })]).toEqual(['a']);
  });
});
