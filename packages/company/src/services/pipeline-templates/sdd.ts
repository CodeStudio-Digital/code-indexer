import type { PipelineGraph } from '@mcp/company-contracts/models/pipeline.js';

/**
 * Built-in SDD pipeline template.
 *
 * Stages:
 *   1. `spec`   — kind:'spec'. A spec-writer subordinate runs under built-in
 *                 `spec` agent (loads spec.txt, blocks mutating tools until
 *                 `submit_specification_to_master` is approved). `requires_confirmation`
 *                 keeps the executor paused on the human approval gate after the
 *                 spec node completes.
 *   2. `impl`   — kind:'agent'. The implementer derives tasks from the spec's
 *                 Implementation Plan section and executes them under build mode.
 *   3. `qa`     — kind:'validate'. Verdict-only subagent verifies each acceptance
 *                 criterion in the spec against the implemented change.
 *
 * Roles are referenced by name (`spec-writer`, `implementer`, `qa-validator`).
 * The session config or template must bind those role names to concrete
 * `CompanyRoleConfig` entries — the pipeline does not invent provider/model
 * combinations. When a role binding is missing the pipeline fails-loud at
 * spawn time (existing role-not-found path in `SubordinateLifecycle.spawn`).
 */
export function buildSddPipelineTemplate(): PipelineGraph {
  return {
    version: 1,
    nodes: [
      {
        id: 'spec',
        label: 'Specification',
        role: 'spec-writer',
        taskTemplate: '{{initial_input}}',
        kind: 'spec',
        requires_confirmation: true,
      },
      {
        id: 'impl',
        label: 'Implement',
        role: 'implementer',
        taskTemplate:
          'Implement the approved specification at {{vars.spec.output}}. ' +
          'Read the .mcp/specs/ file first, derive tasks from its "## Implementation Plan" section via submit_tasks, ' +
          'and execute each inside an execute_task scope.',
        kind: 'agent',
      },
      {
        id: 'qa',
        label: 'QA',
        role: 'qa-validator',
        taskTemplate: 'Verify the implementation against {{vars.spec.output}}.',
        kind: 'validate',
        validatorPrompt:
          'Verify each numbered acceptance criterion in the spec at {{vars.spec.output}} against the current workspace. ' +
          'Submit a single verdict: pass when every criterion is satisfied with observable evidence; fail otherwise with the failing criteria.',
      },
    ],
    edges: [
      { kind: 'linear', id: 'spec-impl', from: 'spec', to: 'impl' },
      { kind: 'linear', id: 'impl-qa', from: 'impl', to: 'qa' },
    ],
    startNodeId: 'spec',
  };
}

/** Stable name for the built-in template. Used by the master prompt's `start_pipeline(name='SDD', …)`. */
export const SDD_PIPELINE_NAME = 'SDD';
