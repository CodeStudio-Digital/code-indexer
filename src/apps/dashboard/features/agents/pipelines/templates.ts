/**
 * Pipeline templates — one-click building blocks for the visual editor.
 *
 * Each template is a partial `PipelineNode` (sans `id` and `position` —
 * the builder generates those at insert time). Grouped into categories
 * the templates panel renders as collapsible sections.
 */
import type { PipelineNode } from '../../../../../core/coder/company/types.js';

export type PipelineTemplateCategory =
  | 'investigation'
  | 'implementation'
  | 'validation'
  | 'documentation'
  | 'control';

export interface PipelineTemplate {
  /** Unique key — used for dedup and i18n lookup. */
  key: string;
  category: PipelineTemplateCategory;
  /** Lucide icon name as a string — resolved at render time. */
  icon:
    | 'search'
    | 'wrench'
    | 'shield-check'
    | 'file-text'
    | 'git-merge'
    | 'sparkles'
    | 'flask-conical'
    | 'pause'
    | 'bot'
    | 'check-check'
    | 'hand';
  /** Default-shape `PipelineNode`. `id` and `position` are filled in by the builder. */
  spec: Omit<PipelineNode, 'id' | 'position'>;
}

export const PIPELINE_TEMPLATES: PipelineTemplate[] = [
  // ─── Investigation ───────────────────────────────────────────
  {
    key: 'investigate',
    category: 'investigation',
    icon: 'search',
    spec: {
      label: 'Investigate',
      role: 'investigator',
      kind: 'agent',
      taskTemplate:
        'Investigate the following request and produce a summary the next stage can act on:\n\n{{initial_input}}',
      branchMode: 'linear',
    },
  },
  {
    key: 'gather-context',
    category: 'investigation',
    icon: 'sparkles',
    spec: {
      label: 'Gather context',
      role: 'investigator',
      kind: 'agent',
      taskTemplate:
        'Gather every relevant file and reference for the upstream task. Output: a list of file paths + a short relevance note for each.\n\n{{previous_output}}',
      branchMode: 'linear',
    },
  },

  // ─── Implementation ──────────────────────────────────────────
  {
    key: 'implement',
    category: 'implementation',
    icon: 'wrench',
    spec: {
      label: 'Implement',
      role: 'backend',
      kind: 'agent',
      taskTemplate:
        'Implement the change described below. Verify with tests/build/lint when relevant. Stop with a concise final summary.\n\n{{previous_output}}',
      branchMode: 'linear',
    },
  },
  {
    key: 'refactor',
    category: 'implementation',
    icon: 'git-merge',
    spec: {
      label: 'Refactor',
      role: 'backend',
      kind: 'agent',
      taskTemplate:
        'Refactor according to the upstream plan. Preserve external behavior; do not introduce features.\n\n{{previous_output}}',
      branchMode: 'linear',
    },
  },

  // ─── Validation ──────────────────────────────────────────────
  {
    key: 'validate-output',
    category: 'validation',
    icon: 'shield-check',
    spec: {
      label: 'Validate output',
      role: 'validator',
      kind: 'validate',
      taskTemplate: '{{previous_output}}',
      branchMode: 'pass-fail',
      validatorPrompt:
        'Pass when the upstream output is concrete, actionable, and clearly addresses the original task. Fail if it is vague, off-topic, or missing key details. Use review when the output is plausibly correct but the criteria are ambiguous.',
    },
  },
  {
    key: 'qa-gate',
    category: 'validation',
    icon: 'flask-conical',
    spec: {
      label: 'QA gate',
      role: 'validator',
      kind: 'validate',
      taskTemplate: '{{previous_output}}',
      branchMode: 'pass-fail',
      validatorPrompt:
        'Pass only when the upstream summary states tests/build/lint were run and all are green. Fail otherwise. Use review only when verification was attempted but partial.',
      validatorTools: ['read_file', 'git_status', 'git_diff'],
    },
  },
  {
    key: 'human-review',
    category: 'validation',
    icon: 'hand',
    spec: {
      label: 'Human review',
      role: 'validator',
      kind: 'agent',
      taskTemplate: 'Stage queued for human review:\n\n{{previous_output}}',
      branchMode: 'linear',
      requires_confirmation: true,
    },
  },

  // ─── Documentation ───────────────────────────────────────────
  {
    key: 'summarize',
    category: 'documentation',
    icon: 'file-text',
    spec: {
      label: 'Summarize',
      role: 'writer',
      kind: 'agent',
      taskTemplate:
        'Produce a concise, user-facing summary of the prior stage. Focus on what changed and what the user should do next.\n\n{{previous_output}}',
      branchMode: 'linear',
    },
  },
  {
    key: 'write-changelog',
    category: 'documentation',
    icon: 'file-text',
    spec: {
      label: 'Changelog entry',
      role: 'writer',
      kind: 'agent',
      taskTemplate:
        'Write a one-paragraph changelog entry from the prior stage. Tone: terse, technical, past tense.\n\n{{previous_output}}',
      branchMode: 'linear',
    },
  },

  // ─── Control flow ────────────────────────────────────────────
  {
    key: 'manual-checkpoint',
    category: 'control',
    icon: 'pause',
    spec: {
      label: 'Checkpoint',
      role: 'control',
      kind: 'agent',
      taskTemplate: 'Checkpoint reached. Output: "{{previous_output}}"',
      branchMode: 'linear',
      requires_confirmation: true,
    },
  },
  {
    key: 'classify',
    category: 'control',
    icon: 'check-check',
    spec: {
      label: 'Classify',
      role: 'classifier',
      kind: 'agent',
      taskTemplate:
        'Classify the upstream output. Last line MUST be one of: PASS / FAIL / REVIEW.\n\n{{previous_output}}',
      branchMode: 'pass-fail',
    },
  },
];

export const TEMPLATE_CATEGORIES: PipelineTemplateCategory[] = [
  'investigation',
  'implementation',
  'validation',
  'documentation',
  'control',
];

export function templatesByCategory(
  cat: PipelineTemplateCategory,
): PipelineTemplate[] {
  return PIPELINE_TEMPLATES.filter((t) => t.category === cat);
}
