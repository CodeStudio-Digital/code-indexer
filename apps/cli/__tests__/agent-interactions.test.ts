import { expect, it, vi } from 'vitest';
import { handleAgentInteraction } from '../commands/agent-interactions.js';

function fixture(answers: string[]) {
  const output: string[] = [];
  return { write: (text: string) => output.push(text), output,
    prompt: vi.fn(async () => answers.shift() ?? ''), respond: vi.fn(async () => {}) };
}
it('keeps the default negative for permissions and plans', async () => {
  const io = fixture(['', 'n']);
  await handleAgentInteraction('tool_approval_request', { toolUseId: 'one', toolName: 'write_file', riskClass: 'write', argsSummary: 'file' }, io);
  await handleAgentInteraction('plan', { plan: 'Implement' }, io);
  expect(io.respond.mock.calls).toEqual([
    ['tool-approval', { tool_use_id: 'one', approved: false }], ['plan-response', { approved: false }],
  ]);
});
it('preserves selected values and free text for a multi-question decision', async () => {
  const io = fixture(['2,1,2', 'custom choice']);
  await handleAgentInteraction('decision', { questions: [
    { id: 'many', question: 'Choose', multiSelect: true, options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }] },
    { id: 'one', question: 'Choose', options: [{ label: 'A', value: 'a' }] },
  ] }, io);
  expect(io.respond).toHaveBeenCalledWith('decide', { answers: { many: { selected: ['b', 'a'] }, one: { freeform: 'custom choice' } } });
});
it('preserves question options and approved task execution mode', async () => {
  const io = fixture(['2', 'yes', 'smart']);
  await handleAgentInteraction('question', { question: 'Mode?', options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }] }, io);
  await handleAgentInteraction('tasks_posted', { summary: 'Change', tasks: [
    { id: 'one', title: 'Read', suggested_mode: 'inline', estimated_complexity: 'small', depends_on: [], files: ['file'] },
  ] }, io);
  expect(io.respond.mock.calls).toEqual([['answer', { answer: 'b' }], ['tasks-response', { approved: true, execution_mode: 'smart' }]]);
});
it('does not retry an interaction whose acknowledgement was lost', async () => {
  const io = fixture(['yes']); io.respond.mockRejectedValueOnce(new Error('ACK lost'));
  await expect(handleAgentInteraction('tool_approval_request', { toolUseId: 'write' }, io)).rejects.toThrow('ACK lost');
  expect(io.respond).toHaveBeenCalledTimes(1);
});

it.each([
  ['question', { question: 'Choose?' }, 'answer'],
  ['plan', { plan: 'Review' }, 'plan-response'],
  ['decision', { questions: [{ id: 'one', question: 'Choose?', options: [{ label: 'A', value: 'a' }] }] }, 'decide'],
] as const)('preserves the native call identity for %s', async (event, data, endpoint) => {
  const io = fixture(['yes']);
  await handleAgentInteraction(event, { ...data, id: 'native-tool:durable-call' }, io);
  expect(io.respond).toHaveBeenCalledWith(endpoint, expect.objectContaining({ interaction_id: 'native-tool:durable-call' }));
});
