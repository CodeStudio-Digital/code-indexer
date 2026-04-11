/**
 * Master-only tools for the Company orchestrator.
 *
 * These are registered into the Master agent's ToolRegistry via runCoder's
 * companyContext integration. Subordinate agents never see them.
 */
import type { CoderTool, ToolResult, JsonSchema } from '../../core/tool.js';
import { ok, err } from '../../core/tool.js';
import type { CompanyOrchestrator } from '../../company/orchestrator.js';

export function buildMasterTools(orchestrator: CompanyOrchestrator): CoderTool[] {
  return [
    spawnSubordinateAgent(orchestrator),
    waitForSubordinates(orchestrator),
    resumeSubordinate(orchestrator),
    approveSubordinatePlan(orchestrator),
    abortSubordinateAgent(orchestrator),
    listSubordinates(orchestrator),
    listCompanyProjects(orchestrator),
    forwardToAgent(orchestrator),
  ];
}

// ─── spawn_subordinate_agent ───────────────────────────────────

function spawnSubordinateAgent(orchestrator: CompanyOrchestrator): CoderTool {
  const parameters: JsonSchema = {
    type: 'object',
    properties: {
      role: { type: 'string', description: 'Agent role name (e.g. "frontend", "backend", "qa", "po", "reviewer", "critic")' },
      task: { type: 'string', description: 'Task description for the subordinate agent' },
      project_id: { type: 'number', description: 'ID of the project this agent should work on (from list_company_projects)' },
      provider: { type: 'string', description: 'Optional LLM provider (e.g. "anthropic", "openai", "zai", "deepseek")' },
      model: { type: 'string', description: 'Optional model name' },
      tier: { type: 'string', enum: ['bootstrap', 'navigate', 'full'], description: 'Tool tier for the agent (default: navigate)' },
      skills: { type: 'array', items: { type: 'string' }, description: 'Optional skill IDs to enable for this agent. Skills provide specialized capabilities (e.g. code review, testing patterns).' },
      wait: { type: 'boolean', description: 'If true, block until the subordinate completes (default: false)' },
    },
    required: ['role', 'task', 'project_id'],
  };

  return {
    name: 'spawn_subordinate_agent',
    description: 'Delegate a task to a subordinate agent. The subordinate runs as a full coder session with write access, scoped to the specified project. The task MUST contain your synthesized research findings (specific file paths, functions, changes) — never copy-paste the user request. After calling this with wait=false, immediately call wait_for_subordinates.',
    parameters,
    source: 'native',
    handler: async (args) => {
      try {
        const role = args.role as string;
        // Apply template defaults if the LLM didn't specify provider/model/tier
        const defaults = orchestrator.getRoleDefaults(role);
        const result = await orchestrator.spawnSubordinate({
          role,
          task: args.task as string,
          projectId: args.project_id as number,
          provider: (args.provider as string | undefined) ?? defaults?.provider,
          model: (args.model as string | undefined) ?? defaults?.model,
          tier: (args.tier as 'bootstrap' | 'navigate' | 'full' | undefined) ?? (defaults?.tier as 'bootstrap' | 'navigate' | 'full' | undefined),
          skills: (args.skills as string[] | undefined) ?? defaults?.skills,
          wait: args.wait as boolean | undefined,
        });
        return ok(JSON.stringify(result, null, 2));
      } catch (e) {
        return err(`Failed to spawn subordinate: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
}

// ─── wait_for_subordinates ─────────────────────────────────────

function waitForSubordinates(orchestrator: CompanyOrchestrator): CoderTool {
  return {
    name: 'wait_for_subordinates',
    description:
      'Block your session until ALL currently-running subordinates complete. ' +
      'ALWAYS call this after spawning subordinates with wait=false — otherwise your session ' +
      'closes before their results arrive. Returns when all agents are done.',
    parameters: {
      type: 'object',
      properties: {
        timeout_minutes: {
          type: 'number',
          description: 'Max minutes to wait before giving up (default: 30)',
        },
      },
      required: [],
    },
    source: 'native',
    handler: async (args) => {
      const timeoutMs = ((args.timeout_minutes as number | undefined) ?? 30) * 60 * 1000;
      const pollMs = 3_000;
      const deadline = Date.now() + timeoutMs;

      if (!orchestrator.hasRunningSubordinates()) {
        return ok('No subordinates currently running — all done.');
      }

      while (orchestrator.hasRunningSubordinates()) {
        if (Date.now() >= deadline) {
          const subs = orchestrator.listSubordinates().filter((s) => s.status === 'running');
          return err(
            `Timed out after ${args.timeout_minutes ?? 30}min. Still running: ${subs.map((s) => s.role).join(', ')}. ` +
            `Use list_subordinates to check status or abort_subordinate_agent if needed.`,
          );
        }
        await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
      }

      const summary = orchestrator
        .listSubordinates()
        .map((s) => `  - ${s.role} (run=${s.agentRunId}): ${s.status}`)
        .join('\n');
      return ok(`All subordinates finished:\n${summary}\nCheck the board for their deliverables, then synthesize results.`);
    },
  };
}

// ─── approve_subordinate_plan ──────────────────────────────────

function approveSubordinatePlan(orchestrator: CompanyOrchestrator): CoderTool {
  const parameters: JsonSchema = {
    type: 'object',
    properties: {
      agent_run_id: { type: 'number', description: 'ID of the subordinate agent run' },
      approved: { type: 'boolean', description: 'Whether to approve (true) or reject (false) the plan' },
      feedback: { type: 'string', description: 'Optional feedback for the subordinate' },
    },
    required: ['agent_run_id', 'approved'],
  };

  return {
    name: 'approve_subordinate_plan',
    description: "Approve or reject a subordinate agent's pending plan. The subordinate is blocked until you respond. Check the board for the plan content.",
    parameters,
    source: 'native',
    handler: async (args) => {
      const agentRunId = args.agent_run_id as number;
      const approved = args.approved as boolean;
      const feedback = args.feedback as string | undefined;

      if (!orchestrator.hasPendingPlan(agentRunId)) {
        return err(`No pending plan found for agent_run_id ${agentRunId}. Use list_subordinates to check status.`);
      }

      const resolved = orchestrator.resolveSubordinatePlan(agentRunId, approved, feedback);
      if (!resolved) {
        return err(`Failed to resolve plan for agent_run_id ${agentRunId}`);
      }

      return ok(`Plan ${approved ? 'approved' : 'rejected'} for agent ${agentRunId}${feedback ? `. Feedback: ${feedback}` : ''}`);
    },
  };
}

// ─── abort_subordinate_agent ───────────────────────────────────

function abortSubordinateAgent(orchestrator: CompanyOrchestrator): CoderTool {
  const parameters: JsonSchema = {
    type: 'object',
    properties: {
      agent_run_id: { type: 'number', description: 'ID of the subordinate agent run to abort' },
      reason: { type: 'string', description: 'Optional reason for the abort' },
    },
    required: ['agent_run_id'],
  };

  return {
    name: 'abort_subordinate_agent',
    description: "Abort a running subordinate agent. This immediately stops the agent's execution.",
    parameters,
    source: 'native',
    handler: async (args) => {
      const agentRunId = args.agent_run_id as number;
      const aborted = orchestrator.abortSubordinate(agentRunId);
      if (!aborted) {
        return err(`Agent run ${agentRunId} not found or already stopped`);
      }
      return ok(`Agent ${agentRunId} aborted`);
    },
  };
}

// ─── list_subordinates ─────────────────────────────────────────

function listSubordinates(orchestrator: CompanyOrchestrator): CoderTool {
  return {
    name: 'list_subordinates',
    description: 'List all subordinate agents in this company session with their current status, role, project, and provider/model.',
    parameters: { type: 'object', properties: {}, required: [] },
    source: 'native',
    handler: async () => {
      const subs = orchestrator.listSubordinates();
      if (subs.length === 0) {
        return ok('No subordinate agents spawned yet.');
      }
      const lines = subs.map((s) =>
        `- agent_run_id=${s.agentRunId} role=${s.role} status=${s.status} projects=${JSON.stringify(s.projectIds)} provider=${s.provider} model=${s.model}`,
      );
      return ok(lines.join('\n'));
    },
  };
}

// ─── list_company_projects ─────────────────────────────────────

function listCompanyProjects(orchestrator: CompanyOrchestrator): CoderTool {
  return {
    name: 'list_company_projects',
    description: 'List all projects linked to this company session. Use project IDs when spawning subordinate agents.',
    parameters: { type: 'object', properties: {}, required: [] },
    source: 'native',
    handler: async () => {
      const projects = orchestrator.listProjects();
      const lines = projects.map((p) =>
        `- id=${p.id} name=${p.name}${p.label ? ` [${p.label}]` : ''} path=${p.rootPath}`,
      );
      return ok(lines.join('\n'));
    },
  };
}

// ─── forward_to_agent ──────────────────────────────────────────

function forwardToAgent(orchestrator: CompanyOrchestrator): CoderTool {
  const parameters: JsonSchema = {
    type: 'object',
    properties: {
      agent_run_id: { type: 'number', description: 'ID of the target subordinate agent' },
      message: { type: 'string', description: 'Message to forward to the agent' },
    },
    required: ['agent_run_id', 'message'],
  };

  return {
    name: 'forward_to_agent',
    description: "Send a task or message to a subordinate agent. If the agent is 'waiting' (finished previous task), it auto-reactivates with full context preserved. Use this to reuse agents instead of spawning new ones.",
    parameters,
    source: 'native',
    handler: async (args) => {
      const agentRunId = args.agent_run_id as number;
      const message = args.message as string;

      const sub = orchestrator.getSubordinate(agentRunId);
      const dbStatus = orchestrator.getSubordinateStatus(agentRunId);

      // Post to board first
      const roleName = sub?.role ?? `agent-${agentRunId}`;
      orchestrator.postToBoard('master', null, 'handoff',
        `[@${roleName}] ${message}`, [roleName]);

      const isRunning = orchestrator.isSubordinateRunning(agentRunId);

      // If the agent is actually running its event loop, push directly.
      if (isRunning && sub) {
        sub.runner.pushUserMessage(`[From Master]: ${message}`);
        return ok(`Message forwarded to ${roleName} (agent_run_id=${agentRunId})`);
      }

      // Otherwise, the agent is dead (waiting, completed, errored, aborted),
      // we must reactivate it via a new runCoder call.
      const reactivated = await orchestrator.reactivateSubordinate(agentRunId, `[From Master]: ${message}`);
      if (reactivated) {
        return ok(`Reactivated ${roleName} (agent_run_id=${agentRunId}) with new task. Agent is running again with full context preserved.`);
      }

      return err(`Agent run ${agentRunId} could not be reactivated. It might be in an unresumable state. Use spawn_subordinate_agent for a fresh agent.`);
    },
  };
}

// ─── resume_subordinate ────────────────────────────────────────

function resumeSubordinate(orchestrator: CompanyOrchestrator): CoderTool {
  const parameters: JsonSchema = {
    type: 'object',
    properties: {
      agent_run_id: { type: 'number', description: 'ID of the failed/aborted subordinate agent to resume' },
      message: { type: 'string', description: 'Optional message to send when resuming (default: "Continue your task")' },
    },
    required: ['agent_run_id'],
  };

  return {
    name: 'resume_subordinate',
    description: 'Resume a failed or aborted subordinate agent. Picks up from where it left off, keeping its full conversation history. Use this instead of spawning a new agent when you want to retry.',
    parameters,
    source: 'native',
    handler: async (args) => {
      try {
        const result = await orchestrator.resumeSubordinate(
          args.agent_run_id as number,
          args.message as string | undefined,
        );
        return ok(JSON.stringify(result, null, 2));
      } catch (e) {
        return err(`Failed to resume subordinate: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
}
