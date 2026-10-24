import { afterEach, expect, it } from 'vitest';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { AgentMessage } from '../../core/messages.js';
import type { ResumableAgentState } from '../subagent-resume-registry.js';
import { renderTranscriptDigest, renderTranscriptDigestAsync, transcriptBudget } from '../subagent-transcript-digest.js';
import { readSpilledTranscriptAsync } from '../subagent-transcript-spill.js';
import { renderAgentTranscriptAsync } from '../read-agent-transcript.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('subagent-digest-test-')) throw new Error('Unsafe cleanup');
    await rm(root, { recursive: true, force: true });
  }
});
function state(): ResumableAgentState {
  return { agentIndex: 0, label: 'inspect', task: 'inspect a fixture', profileId: 'explore', maxTurns: 0,
    limits: { maxToolCalls: 80, timeoutMs: 840_000, stallMs: 90_000 }, reason: 'completed',
    toolCallCount: 1, usage: { input_tokens: 1, output_tokens: 2 }, attempt: 1, capturedAt: 0,
    approxBytes: 0, finalText: 'Retained final conclusion' };
}
const messages = (): AgentMessage[] => [
  { role: 'assistant', content: [{ type: 'tool_use', id: 'call', name: 'read_file', input: { path: 'entry.ts' } }] },
  { role: 'tool', content: [{ type: 'tool_result', tool_use_id: 'call', content: 'export const result = 1' }] },
];
function largeTranscript(): AgentMessage[] {
  return Array.from({ length: 10_000 }, (_, index) => ({ role: 'assistant', content: [{ type: 'text', text: `event ${index} ${'data '.repeat(100)}` }] }));
}

it('keeps chronological tool names and final text identically in sync and async rendering', async () => {
  const expected = renderTranscriptDigest(state(), messages());
  expect(expected).toContain('→ read_file {"path":"entry.ts"}');
  expect(expected).toContain('← read_file');
  expect(expected).toContain('[final] Retained final conclusion');
  expect(await renderTranscriptDigestAsync(state(), messages())).toBe(expected);
});
it.each([NaN, Infinity, -1, 2_000, 60_000, 1_000_000])('bounds large transcripts with max_chars=%s and keeps the tail', async maximum => {
  const result = await renderTranscriptDigestAsync(state(), largeTranscript(), maximum);
  expect(result.length).toBeLessThanOrEqual(transcriptBudget(maximum));
  expect(result).toContain('earlier event(s) elided');
  expect(result).toContain('event 9999');
  expect(result).toContain('[final] Retained final conclusion');
});
it('lets cancellation run before a large digest completes', async () => {
  const abort = new AbortController();
  const timer = setImmediate(() => abort.abort(new Error('cancel digest')));
  try { await expect(renderTranscriptDigestAsync(state(), largeTranscript(), 2_000, abort.signal)).rejects.toThrow(); }
  finally { clearImmediate(timer); }
});
it('bounds the final-report fallback and untrusted metadata too', async () => {
  const result = await renderAgentTranscriptAsync({ ...state(), label: 'label'.repeat(20_000),
    task: 'task'.repeat(20_000), finalText: 'final'.repeat(20_000) }, { maxChars: 2_000 });
  expect(result.length).toBeLessThanOrEqual(2_000);
  expect(result).toContain('[final]');
});
it('bounds huge input/result excerpts without serializing the omitted object graph', () => {
  const input: Record<string, unknown> = { path: 'entry.ts', content: 'x'.repeat(1024 * 1024) };
  Object.defineProperty(input, 'later', { enumerable: true, get: () => { throw new Error('fixture getter'); } });
  const transcript: AgentMessage[] = [{ role: 'assistant', content: [{ type: 'tool_use', id: 'big', name: 'read_file', input }] },
    { role: 'tool', content: [{ type: 'tool_result', tool_use_id: 'big', content: ' '.repeat(1024 * 1024) }] }];
  expect(renderTranscriptDigest(state(), transcript, 2_000).length).toBeLessThanOrEqual(2_000);
});
it('reads retained bundle entities asynchronously and falls back for oversized files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'subagent-digest-test-')); roots.push(root);
  const path = join(root, 'transcript.json');
  await writeFile(path, JSON.stringify({ kind: 'subagent_transcript', data: { messages: messages() } }));
  expect(await readSpilledTranscriptAsync(path)).toEqual(messages());
  expect(await renderAgentTranscriptAsync({ ...state(), spillPath: path })).toContain('→ read_file');
  const handle = await open(path, 'w');
  try { await handle.truncate(64 * 1024 * 1024 + 1); } finally { await handle.close(); }
  expect(await readSpilledTranscriptAsync(path)).toBeNull();
  expect(await renderAgentTranscriptAsync({ ...state(), spillPath: path })).toContain('[final] Retained final conclusion');
  const abort = new AbortController(); abort.abort(new Error('cancel read'));
  await expect(readSpilledTranscriptAsync(path, abort.signal)).rejects.toThrow('cancel read');
});
