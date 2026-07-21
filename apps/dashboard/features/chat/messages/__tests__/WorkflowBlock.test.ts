import { describe, expect, it } from 'vitest';
import { parseWorkflowResult } from '../WorkflowBlock.js';

const SAMPLE =
  '[workflow wf_ab12cd34 "audit auth": failed — 2/4 completed, 0 partial, 1 failed, 1 skipped, waves=3, input=1200 output=300]\n\n' +
  '### step scan — Scan repo [wave=1, profile=explore, status=completed, tools=12]\n' +
  'Found 3 auth entrypoints.\n\n---\n\n' +
  '### step review — Review findings [wave=1, profile=review, status=completed, tools=8]\n' +
  'Two real issues confirmed.\n\n---\n\n' +
  '### step fix — Fix issues [wave=2, profile=implement, status=failed, tools=40]\n' +
  'subagent hard timeout reached\n\n---\n\n' +
  '### step verify — Verify [wave=3, profile=verify, status=skipped]\n' +
  "dependency 'fix' did not complete\n\n---\n\n" +
  '[2 step(s) did not complete — workflow({resume_workflow_id:"wf_ab12cd34", retry_failed:true}) relaunches them reusing completed results.]';

describe('parseWorkflowResult', () => {
  it('rebuilds the workflow card state from the persisted tool result', () => {
    const run = parseWorkflowResult(SAMPLE);
    expect(run).not.toBeNull();
    expect(run!).toMatchObject({
      workflowId: 'wf_ab12cd34',
      name: 'audit auth',
      status: 'failed',
      totalWaves: 3,
      totalUsage: { input_tokens: 1200, output_tokens: 300 },
    });
    expect(run!.steps).toHaveLength(4);
    expect(run!.steps[0]).toMatchObject({
      id: 'scan', profile: 'explore', wave: 1, status: 'completed', toolCallCount: 12,
      summary: 'Found 3 auth entrypoints.',
    });
    expect(run!.steps[2]).toMatchObject({
      id: 'fix', status: 'failed', error: 'subagent hard timeout reached',
    });
    expect(run!.steps[3]).toMatchObject({ id: 'verify', status: 'skipped' });
  });

  it('returns null for non-workflow content', () => {
    expect(parseWorkflowResult('random text')).toBeNull();
    expect(parseWorkflowResult('[execute_tasks: 1 wave(s), 1 task(s), input=1 output=1]')).toBeNull();
  });
});
