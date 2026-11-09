import type { WorkflowStepInput } from './workflow-types.js';

export const WORKFLOW_TEMPLATES = ['investigate_implement_verify', 'cross_check', 'migration'] as const;

/** Explicit opt-in starting plans. No auto-fan-out, extra budget or authority. */
export function workflowTemplate(name: string, task: string, files?: string[]): WorkflowStepInput[] {
  if (!WORKFLOW_TEMPLATES.includes(name as typeof WORKFLOW_TEMPLATES[number])) throw new Error('Unknown workflow template');
  if (!task.trim() || task.length > 8000) throw new Error('A bounded concrete task is required');
  if (name !== 'cross_check' && (!files?.length || files.some(file => typeof file !== 'string' || !file.trim()))) throw new Error('Declare file ownership before using a writing template');
  const investigate: WorkflowStepInput = { id: 'investigate', profile: 'explore', prompt: `Investigate this exact task, cite relevant files and contracts, identify the smallest sufficient change. Do not implement.\n${task}` };
  if (name === 'cross_check') return [investigate,
    { id: 'challenge', profile: 'review', prompt: `Independently inspect risks and counterexamples for this task; cite evidence. Do not edit.\n${task}` },
    { id: 'synthesis', profile: 'explore', depends_on: ['investigate', 'challenge'], prompt: `Reconcile the supplied findings. Separate confirmed evidence, disagreement and remaining uncertainty. Stop after delivering the answer.\n${task}` }];
  const migration = name === 'migration';
  return [investigate,
    { id: 'implement', profile: 'implement', files, depends_on: ['investigate'], prompt: `Implement the agreed scoped change using the investigation. Preserve unrelated work. ${migration ? 'Preserve existing data, add versioned compatibility, make writes restart-safe and provide rollback instructions. Do not perform a production migration.' : ''}\n${task}` },
    { id: 'verify', profile: 'verify', depends_on: ['implement'], prompt: `Verify the integrated changes against this task. Run only relevant checks once and report commands and results; do not broaden scope. ${migration ? 'Exercise legacy reading, interrupted migration and rollback in disposable local fixtures.' : ''}\n${task}`,
      acceptance: ['Relevant checks were actually executed against the integrated change; failures and unverified requirements are explicitly reported.'] }];
}
