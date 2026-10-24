/**
 * approve_subordinate_plans (C4) — batch companion to the singular
 * `approve_subordinate_plan`. When the ApprovalBatcher aggregates N pending
 * plans into one summary, the master answers them in ONE call instead of N
 * LLM round-trips.
 *
 * Batch semantics are PER-ITEM (mirrors kanban-batch's runBatch): each
 * approval either yields its success line or its error line; a missing /
 * already-resolved plan fails only that entry. The call is `isError` only
 * when EVERY item failed. Delegates to the exact same resolution path as the
 * singular tool (`orchestrator.resolveSubordinatePlan`).
 *
 * Name deliberately starts with `approve_subordinate` so the existing
 * master-filter prefix allowlist keeps it (proven in master-filter.test.ts).
 */
import type { CoderTool } from "@mcp/code-agent/core/tool.js";
import type { JsonSchema } from "@mcp/provider-sdk";
import { ok, err } from "@mcp/agent-runtime-host/tool-result.js";
import type { CompanyOrchestrator } from '@mcp/company/orchestrator.js';

const MAX_BATCH = 15;

interface ApprovalEntry {
  agent_run_id: string;
  approved: boolean;
  feedback?: string;
}

/** Resolve one approval — returns the human-readable outcome line. Throws on failure. */
function approveOne(orchestrator: CompanyOrchestrator, entry: ApprovalEntry): string {
  const { agent_run_id: agentRunId, approved, feedback } = entry;
  if (!orchestrator.hasPendingPlan(agentRunId)) {
    throw new Error(
      `No pending plan for agent_run_id ${agentRunId} (already resolved, or never submitted).`,
    );
  }
  const resolved = orchestrator.resolveSubordinatePlan(agentRunId, approved, feedback);
  if (!resolved) {
    throw new Error(`Failed to resolve plan for agent_run_id ${agentRunId}.`);
  }
  return `agent ${agentRunId}: plan ${approved ? 'APPROVED' : 'REJECTED'}${feedback ? ` — ${feedback}` : ''}`;
}

export function approveSubordinatePlansTool(orchestrator: CompanyOrchestrator): CoderTool {
  const parameters: JsonSchema = {
    type: 'object',
    properties: {
      approvals: {
        type: 'array',
        description:
          `Per-plan decisions (max ${MAX_BATCH}). Each entry: {agent_run_id (required), ` +
          'approved (required), feedback?}.',
        items: {
          type: 'object',
          properties: {
            agent_run_id: { type: 'string', description: 'UUID of the subordinate agent run whose plan is pending.' },
            approved: { type: 'boolean', description: 'Approve (true) or reject (false) this plan.' },
            feedback: { type: 'string', description: 'Optional feedback relayed to the subordinate.' },
          },
          required: ['agent_run_id', 'approved'],
        },
      },
    },
    required: ['approvals'],
  };

  return {
    name: 'approve_subordinate_plans',
    description:
      'Approve or reject SEVERAL pending subordinate plans in one call — use this when the ' +
      '[SYSTEM] summary lists multiple plans awaiting review, instead of calling ' +
      `approve_subordinate_plan once per agent. Per-item semantics (max ${MAX_BATCH}): a failed ` +
      'entry (e.g. plan already resolved) reports that item and the rest still apply.',
    parameters,
    source: 'native',
    handler: async (args) => {
      const raw = args.approvals;
      if (!Array.isArray(raw) || raw.length === 0) {
        return err(`\`approvals\` must be a non-empty array (max ${MAX_BATCH}).`);
      }
      if (raw.length > MAX_BATCH) {
        return err(`Too many entries (${raw.length}, max ${MAX_BATCH}). Split into two calls.`);
      }

      const lines: string[] = [];
      let failures = 0;
      for (let i = 0; i < raw.length; i++) {
        const entry = raw[i] as Partial<ApprovalEntry> | null;
        try {
          if (
            entry == null || typeof entry !== 'object' ||
            typeof entry.agent_run_id !== 'string' || typeof entry.approved !== 'boolean'
          ) {
            throw new Error('entry must be {agent_run_id: UUID, approved: boolean, feedback?}.');
          }
          lines.push(`[${i + 1}/${raw.length}] ${approveOne(orchestrator, entry as ApprovalEntry)}`);
        } catch (e) {
          failures += 1;
          lines.push(`[${i + 1}/${raw.length}] FAILED: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      const summary = `${raw.length - failures}/${raw.length} resolved${failures ? `, ${failures} failed` : ''}`;
      const body = [summary, ...lines].join('\n');
      return failures === raw.length ? err(body) : ok(body);
    },
  };
}
