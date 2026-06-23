import type { CoderTool, ToolResult } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import {
  formatSpecResult,
  getRejectedSet,
  hashSpec,
  mirrorSpecToCompanyDrive,
  writeSpecToRepo,
} from '@mcp/code-agent/tools/spec/index.js';
import { maybeTerse } from '@mcp/code-agent/tools/descriptions.js';

const SUBMIT_SPECIFICATION_TO_MASTER_DESC =
  'Submit a feature/epic specification to the Master orchestrator for human approval.\n' +
  'Required in spec mode before any mutating tool — writes `.mcp/specs/<slug>-<unix>.md`, mirrors into the company drive, and BLOCKS until the human (via Master) approves or requests changes.\n' +
  "USE: as a spec-writer subordinate (SDD pipeline) once you've drafted the full 5-section spec.\n" +
  "DON'T: skip exploration and submit a thin spec — explore FIRST.";

/**
 * Subordinate variant of `submit_spec`. Lives in its own file so this
 * feature does not inflate the already-large `subordinate-tools.ts`. The
 * tool is appended to `buildSubordinateTools()`.
 *
 * Emits `spec_posted` with `forMaster: true` in the payload so the
 * orchestrator's master inbox router can relay the spec to the human
 * dashboard (mirror of how `submit_plan_to_master` reuses `plan_posted`).
 */
export const submitSpecificationToMaster: CoderTool = {
  name: 'submit_specification_to_master',
  description: maybeTerse(SUBMIT_SPECIFICATION_TO_MASTER_DESC),
  source: 'native',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Short human-readable feature name. Becomes the file slug.',
      },
      body: {
        type: 'string',
        description: 'Full spec markdown (5 sections: Context, Requirements, Design, Acceptance Criteria, Implementation Plan).',
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
    if (!runner) return err('submit_specification_to_master requires runner context');

    const rejected = getRejectedSet(runner);
    const hash = hashSpec(body);
    if (rejected.has(hash)) {
      return err(
        `This spec body was already rejected (hash=${hash}). Read the prior requested_changes and submit a materially different spec.`,
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
    let parsed: { approved?: boolean; requested_changes?: string; feedback?: string; aborted?: boolean };
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = { approved: false, requested_changes: raw };
    }
    const feedback = parsed.requested_changes ?? parsed.feedback;

    if (parsed.aborted) {
      return err('Spec review aborted by Master.');
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
              `<system-reminder>Mode transition: Spec → Build. The spec at ${written.relPath} was approved by the Master. ` +
              `Derive tasks from its "## Implementation Plan" via submit_tasks_to_master, then execute each per task scope.</system-reminder>`,
          },
        ];
      }
      return result;
    }
    rejected.add(hash);
    return ok(formatSpecResult(false, written.relPath, feedback));
  },
};
