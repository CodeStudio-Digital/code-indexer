/**
 * workflow-result-parser — rebuilds a WorkflowRunState from the persisted
 * `workflow` tool result text so the card survives reloads (same contract as
 * parseExecuteTasksResult). Header + `### step` sections; the trailing resume
 * hint lives in its own `---` section and is skipped by the step regex.
 */
import type { WorkflowRunState, WorkflowStepView } from '../../../hooks/useAgentStream.js';

export function parseWorkflowResult(content: string): WorkflowRunState | null {
  const header = content.match(
    /^\[workflow\s+(\S+)\s+"([^"]*)":\s+(\w+)\s+—\s+(\d+)\/(\d+)\s+completed,\s+(\d+)\s+partial,\s+(\d+)\s+failed,\s+(\d+)\s+skipped,\s+waves=(\d+),\s+input=(\d+)\s+output=(\d+)\]/,
  );
  if (!header) return null;
  const sections = content.slice(header[0].length).trim().split(/\n\n---\n\n/g).filter(Boolean);
  const steps: WorkflowStepView[] = [];
  for (const rawSection of sections) {
    const match = rawSection.trim().match(/^###\s+step\s+(\S+)\s+(?:—|-)\s+(.+?)\s+\[([^\]]+)\]\s*\n?([\s\S]*)$/);
    if (!match) continue;
    const meta: Record<string, string> = {};
    for (const part of match[3].split(',')) {
      const eq = part.indexOf('=');
      if (eq > 0) meta[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    }
    const status = normalizeStepStatus(meta.status);
    const body = match[4].trim();
    steps.push({
      id: match[1].trim(),
      title: match[2].trim(),
      profile: meta.profile ?? 'explore',
      dependsOn: [],
      wave: readInt(meta.wave) ?? 1,
      status,
      toolCallCount: readInt(meta.tools) ?? undefined,
      summary: status === 'failed' || status === 'skipped' ? undefined : body || undefined,
      error: status === 'failed' || status === 'skipped' ? body || undefined : undefined,
    });
  }
  if (steps.length === 0) return null;
  return {
    workflowId: header[1],
    name: header[2] || 'workflow',
    status: normalizeRunStatus(header[3]),
    totalWaves: readInt(header[9]) ?? Math.max(1, ...steps.map((s) => s.wave)),
    steps,
    totalUsage: {
      input_tokens: Number(header[10] ?? 0),
      output_tokens: Number(header[11] ?? 0),
    },
  };
}

function normalizeStepStatus(raw: string | undefined): WorkflowStepView['status'] {
  if (raw === 'pending' || raw === 'running' || raw === 'completed' || raw === 'partial' || raw === 'failed' || raw === 'skipped') {
    return raw;
  }
  return 'completed';
}

function normalizeRunStatus(raw: string | undefined): WorkflowRunState['status'] {
  if (raw === 'running' || raw === 'completed' || raw === 'partial' || raw === 'failed' || raw === 'aborted') {
    return raw;
  }
  return 'completed';
}

function readInt(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}
