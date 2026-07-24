import type { CoderTool, ToolResult } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import { formatInterruptedResult } from '@mcp/code-agent/tools/interaction.js';
import { getRejectedSet, hashSpec } from './hash-ledger.js';
import { writeSpecToRepo } from './write-spec.js';
import { mirrorSpecToCompanyDrive } from './mirror-to-drive.js';
import { formatSpecResult } from './format-result.js';

const SUBMIT_SPEC_DESC =
  'Submit a feature/epic specification for human approval. Required in spec mode before any mutating tool. ' +
  'Writes `.mcp/specs/<slug>-<unix>.md`, mirrors it into the company drive when present, and BLOCKS until the user approves or requests changes. ' +
  'Rejected drafts are ledgered by content hash — cosmetic resubmits are refused.';

/**
 * Spec-mode tool: agent submits a written specification, the run pauses, the
 * host (CLI/SSE) collects user approval, and the runner resumes via
 * `runner.provideUserInput`. Mirrors `submit_plan` semantics with the spec
 * artifact persisted to disk + drive instead of an in-memory plan blob.
 */
export const submitSpec: CoderTool = {
  name: 'submit_spec',
  effectBoundary: 'filesystem',
  description: SUBMIT_SPEC_DESC,
  source: 'native',
  // Deliberately false: submit_spec is the approval primitive that must be
  // reachable while spec mode still blocks ordinary mutators. Its durable
  // artifact is fenced separately by effectBoundary.
  mutates: false,
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description:
          'Short human-readable feature name (becomes the file slug). Example: "auth-with-stripe-billing".',
      },
      body: {
        type: 'string',
        description:
          'Full spec markdown — 5 sections in order: ## Context, ## Requirements, ## Design, ## Acceptance Criteria, ## Implementation Plan. Persisted verbatim.',
      },
      parent_id: {
        type: 'string',
        description: 'Optional parent feature/epic id when this spec extends an existing one.',
      },
    },
    required: ['name', 'body'],
    additionalProperties: false,
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    const name = String(args.name ?? '').trim();
    const body = String(args.body ?? '').trim();
    if (!name) return err('spec name cannot be empty');
    if (!body) return err('spec body cannot be empty');
    const parentId = typeof args.parent_id === 'string' ? args.parent_id : undefined;

    const runner = ctx.runner;
    if (!runner) return err('submit_spec requires runner context');

    const rejected = getRejectedSet(runner);
    const hash = hashSpec(body);
    if (rejected.has(hash)) {
      return err(
        `This spec body was already rejected by the user in this session (hash=${hash}). ` +
          `Read the requested_changes feedback in the prior submit_spec tool_result and produce a materially different spec — ` +
          `do not re-submit with cosmetic tweaks.`,
      );
    }

    const written = await writeSpecToRepo(ctx, name, body);
    const mirror = await mirrorSpecToCompanyDrive(ctx, written.fileName, body);

    const id = `spec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    runner.emit('spec_posted', {
      type: 'spec',
      id,
      name,
      body,
      spec_path: written.relPath,
      parent_id: parentId,
      drive_path: mirror.drivePath,
    });

    const raw = await runner.waitForUserInput();
    let parsed: {
      approved?: boolean;
      requested_changes?: string;
      feedback?: string;
      aborted?: boolean;
      interrupted?: boolean;
      kind?: 'plan' | 'question' | 'tasks' | 'spec';
      agentRunId?: number;
      role?: string;
    };
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = { approved: false, requested_changes: raw };
    }
    const feedback = parsed.requested_changes ?? parsed.feedback;

    if (parsed.interrupted) {
      return err(formatInterruptedResult('submit_spec', parsed));
    }
    if (parsed.aborted) {
      return err('Spec review aborted by user.');
    }
    if (parsed.approved) {
      runner.approveSpec(written.relPath);
      rejected.clear();
      const transitioning = runner.agentId === 'spec';
      if (transitioning) {
        ctx.setSessionAgent?.('build');
      }
      const result: ToolResult = { content: formatSpecResult(true, written.relPath, feedback) };
      if (transitioning) {
        result.extraUserBlocks = [
          {
            type: 'text',
            text:
              `<system-reminder>Mode transition: Spec → Build. The spec at ${written.relPath} was approved. ` +
              `Derive tasks from its "## Implementation Plan" section, call submit_tasks with files+complexity per step, ` +
              `then call execute_tasks once to run them. The spec-mode gate is now released; mutating tools are unlocked.</system-reminder>`,
          },
        ];
      }
      return result;
    }
    rejected.add(hash);
    return ok(formatSpecResult(false, written.relPath, feedback));
  },
};

export const specTools: CoderTool[] = [submitSpec];
