import { describe, expect, it } from 'vitest';
import { shallow } from 'zustand/shallow';
import { applyAgentEvent, AGENT_PREVIEW_LIMIT } from '../agentEvent.js';
import { INITIAL_STREAM_STATE } from '../../types.js';
import { selectStreamSummary, selectAgentTextPreview } from '../../selectors.js';
import type { CompanyStore } from '../../store-types.js';

const master = { agent: 'master', agentRunId: 'master-run' };
const sub = { agent: 'builder', agentRunId: 'sub-run' };
const asStore = (slot: typeof INITIAL_STREAM_STATE) => ({ streams: new Map([['session', slot]]) }) as CompanyStore;

describe('Company preview isolation', () => {
  it('bounds 10,000 deltas and leaves shell snapshots unchanged after materialization', () => {
    let state = applyAgentEvent(INITIAL_STREAM_STATE, { ...master, event: 'text_delta', data: { text: 'start' } });
    const initialAgent = state.masterState;
    const initialSummary = selectStreamSummary(asStore(state), 'session');
    let canonical = 'start';
    for (let i = 0; i < 10_000; i++) {
      const text = `delta ${i}.`;
      canonical += text;
      state = applyAgentEvent(state, { ...master, event: 'text_delta', data: { text } });
      expect(state.agentTextPreviews.get('master')!.length).toBeLessThanOrEqual(AGENT_PREVIEW_LIMIT);
    }
    expect(state.agentTextPreviews.get('master')).toBe(canonical.slice(-AGENT_PREVIEW_LIMIT));
    expect(state.masterState).toBe(initialAgent);
    expect(shallow(selectStreamSummary(asStore(state), 'session'), initialSummary)).toBe(true);
    expect(canonical.length).toBeGreaterThan(90_000);
  });

  it('isolates agents, clears the completed message tail, and preserves tool/status updates', () => {
    let state = applyAgentEvent(INITIAL_STREAM_STATE, { ...master, event: 'text_delta', data: { text: 'master' } });
    state = applyAgentEvent(state, { ...sub, event: 'text_delta', data: { text: 'x'.repeat(100_000) + 'end' } });
    expect(state.agentTextPreviews.size).toBe(2);
    expect(selectAgentTextPreview(asStore(state), 'session', 'master')).toBe('master');
    expect(selectAgentTextPreview(asStore(state), 'session', 'sub-run')).toBe('x'.repeat(78) + 'end');
    const summary = selectStreamSummary(asStore(state), 'session');
    state = applyAgentEvent(state, { ...sub, event: 'tool_call_start', data: { id: 'tool', name: 'read_file' } });
    expect(shallow(selectStreamSummary(asStore(state), 'session'), summary)).toBe(false);
    state = applyAgentEvent(state, { ...sub, event: 'message_complete', data: { usage: { input_tokens: 4, output_tokens: 8 } } });
    expect(selectAgentTextPreview(asStore(state), 'session', 'sub-run')).toBe('');
    expect(selectAgentTextPreview(asStore(state), 'session', 'master')).toBe('master');
    expect(state.subordinateStates.get('sub-run')?.usage?.output_tokens).toBe(8);
    state = applyAgentEvent(state, { ...sub, event: 'text_delta', data: { text: 'next turn' } });
    expect(selectAgentTextPreview(asStore(state), 'session', 'sub-run')).toBe('next turn');
  });
});
