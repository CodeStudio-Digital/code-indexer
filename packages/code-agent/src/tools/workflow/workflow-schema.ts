import type { JsonSchema } from '../../core/tool.js';
import { MICRO_AGENT_PROFILE_NAMES } from '../micro-agent-profiles.js';
import { WORKFLOW_MAX_STEPS } from './workflow-types.js';
import { WORKFLOW_TEMPLATES } from './workflow-templates.js';

export const WORKFLOW_DESC =
  'Run a declarative DAG of subagent steps (Ultra mode). Steps with satisfied `depends_on` run IN PARALLEL; ' +
  'dependents receive bounded digests of their prerequisites’ results. Per-step `profile` picks the toolset ' +
  '(explore/verify/review read-only, implement writes scoped to `files`, full unfiltered).\n' +
  'USE: for multi-step work with a real dependency structure — e.g. N parallel investigations feeding one implementation, then a verify step.\n' +
  'USE: `workflow({resume_workflow_id, retry_failed:true})` to relaunch failed/skipped steps of a previous run without redoing completed ones.\n' +
  'When integrations are pending, review with read_chat_changes and integrate_chat_changes through normal tools, then resume. Dependents wait for integration.\n' +
  "DON'T: wrap a single task — use spawn_agent.\n" +
  "DON'T: mirror an approved task list — execute_tasks already orchestrates it.\n" +
  'Token cost of every step IS billed to this session. Steps are capped at ' +
  `${WORKFLOW_MAX_STEPS}; results stream live to the Workflow card.`;

export const workflowSchema: JsonSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Short workflow name shown in the UI (3-6 words).' },
    template: { type: 'string', enum: [...WORKFLOW_TEMPLATES], description: 'Optional starting plan for a new workflow. Explicit steps take precedence; never use for a simple one-agent task.' },
    task: { type: 'string', description: 'Concrete objective for the selected template.' },
    files: { type: 'array', items: { type: 'string' }, description: 'Required write ownership for implementation/migration templates.' },
    steps: {
      type: 'array',
      minItems: 1,
      maxItems: WORKFLOW_MAX_STEPS,
      description: 'DAG steps. Order does not matter — `depends_on` decides the waves.',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Stable step id ([a-zA-Z0-9_-], max 40 chars).' },
          title: { type: 'string', description: 'Short visible step title.' },
          prompt: { type: 'string', description: 'Complete, self-contained subagent instructions.' },
          profile: {
            type: 'string',
            enum: MICRO_AGENT_PROFILE_NAMES,
            description: 'Micro-agent profile for this step (default explore).',
          },
          depends_on: {
            type: 'array',
            items: { type: 'string' },
            description: 'Ids of prerequisite steps. Their result digests are injected into this prompt.',
          },
          accept_partial: { type: 'array', items: { type: 'string' }, description: 'Explicit dependencies whose partial result is sufficient. Default: require completed.' },
          acceptance: { type: 'array', items: { type: 'string' }, description: 'Observable acceptance criteria; unresolved criteria make the result unverified.' },
          files: {
            type: 'array',
            items: { type: 'string' },
            description: 'Implement profile: paths this step may write to.',
          },
        },
        required: ['id', 'prompt'],
      },
    },
    resume_workflow_id: { type: 'string', description: 'Existing workflow id to resume instead of creating a new one.' },
    retry_failed: { type: 'boolean', description: 'With resume: reset failed/skipped steps to pending before running.' },
    expected_plan_revision: { type: 'integer', minimum: 1, description: 'Required when revising steps of a saved workflow. Completed steps and uncertain effects cannot be rewritten.' },
  },
  additionalProperties: false,
} as unknown as JsonSchema;
