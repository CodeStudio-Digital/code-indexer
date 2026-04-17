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
    answerSubordinateQuestion(orchestrator),
    approveSubordinateTasks(orchestrator),
    abortSubordinateAgent(orchestrator),
    listSubordinates(orchestrator),
    listCompanyProjects(orchestrator),
    forwardToAgent(orchestrator),
    finalizeSubordinates(orchestrator),
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
      kanban_card_id: { type: 'number', description: 'Optional Kanban card ID. When provided, the card\'s full context (description, checklist, comments) is prepended to the task, the agent is auto-assigned to the card, and the card moves to in_progress.' },
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
        const kanbanCardId = args.kanban_card_id as number | undefined;

        // Inject Kanban card context into task if card_id provided
        let task = args.task as string;
        if (kanbanCardId) {
          const cardContext = orchestrator.getCardContextForSubordinate(kanbanCardId);
          if (cardContext) {
            task = `## Kanban Card Context\n\n${cardContext}\n\n---\n\n## Task\n\n${task}`;
          }
        }

        // Apply template defaults if the LLM didn't specify provider/model/tier
        const defaults = orchestrator.getRoleDefaults(role);
        const result = await orchestrator.spawnSubordinate({
          role,
          task,
          projectId: args.project_id as number,
          provider: (args.provider as string | undefined) ?? defaults?.provider,
          model: (args.model as string | undefined) ?? defaults?.model,
          tier: (args.tier as 'bootstrap' | 'navigate' | 'full' | undefined) ?? (defaults?.tier as 'bootstrap' | 'navigate' | 'full' | undefined),
          skills: (args.skills as string[] | undefined) ?? defaults?.skills,
          wait: args.wait as boolean | undefined,
        });

        // Auto-assign agent to Kanban card and move to in_progress
        if (kanbanCardId && result.agentRunId) {
          try {
            orchestrator.kanbanAssignAgent(kanbanCardId, result.agentRunId, role);
            const card = orchestrator.kanbanGetCard(kanbanCardId);
            if (card && (card.column === 'backlog' || card.column === 'todo')) {
              orchestrator.kanbanMoveCard(kanbanCardId, 'in_progress');
            }
          } catch { /* non-fatal — card ops shouldn't block spawn */ }
        }

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

// ─── answer_subordinate_question ──────────────────────────────

function answerSubordinateQuestion(orchestrator: CompanyOrchestrator): CoderTool {
  const parameters: JsonSchema = {
    type: 'object',
    properties: {
      agent_run_id: { type: 'number', description: 'ID of the subordinate agent run' },
      answer: { type: 'string', description: 'Your answer to the subordinate\'s question' },
    },
    required: ['agent_run_id', 'answer'],
  };

  return {
    name: 'answer_subordinate_question',
    description:
      "Answer a subordinate agent's pending question. The subordinate is blocked until you respond. " +
      "If you don't know the answer, use ask_user to escalate to the human, then relay their response with this tool.",
    parameters,
    source: 'native',
    handler: async (args) => {
      const agentRunId = args.agent_run_id as number;
      const answer = args.answer as string;

      if (!orchestrator.hasPendingQuestion(agentRunId)) {
        return err(`No pending question found for agent_run_id ${agentRunId}. Use list_subordinates to check status.`);
      }

      const resolved = orchestrator.resolveSubordinateQuestion(agentRunId, answer);
      if (!resolved) {
        return err(`Failed to resolve question for agent_run_id ${agentRunId}`);
      }

      return ok(`Question answered for agent ${agentRunId}. The subordinate will continue with your answer.`);
    },
  };
}

// ─── approve_subordinate_tasks ───────────────────────────────

function approveSubordinateTasks(orchestrator: CompanyOrchestrator): CoderTool {
  const parameters: JsonSchema = {
    type: 'object',
    properties: {
      agent_run_id: { type: 'number', description: 'ID of the subordinate agent run' },
      approved: { type: 'boolean', description: 'Whether to approve (true) or reject (false) the task list' },
      feedback: { type: 'string', description: 'Optional feedback for the subordinate' },
      execution_mode: {
        type: 'string',
        enum: ['inline', 'per-task', 'all-subagent', 'smart'],
        description: 'How the subordinate should execute tasks (default: inline)',
      },
    },
    required: ['agent_run_id', 'approved'],
  };

  return {
    name: 'approve_subordinate_tasks',
    description:
      "Approve or reject a subordinate agent's pending task list. The subordinate is blocked until you respond. " +
      "Check the board for the task list content.",
    parameters,
    source: 'native',
    handler: async (args) => {
      const agentRunId = args.agent_run_id as number;
      const approved = args.approved as boolean;
      const feedback = args.feedback as string | undefined;
      const executionMode = args.execution_mode as string | undefined;

      if (!orchestrator.hasPendingTasks(agentRunId)) {
        return err(`No pending task list found for agent_run_id ${agentRunId}. Use list_subordinates to check status.`);
      }

      const resolved = orchestrator.resolveSubordinateTasks(agentRunId, approved, feedback, executionMode);
      if (!resolved) {
        return err(`Failed to resolve tasks for agent_run_id ${agentRunId}`);
      }

      return ok(`Task list ${approved ? 'approved' : 'rejected'} for agent ${agentRunId}${feedback ? `. Feedback: ${feedback}` : ''}`);
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
    description:
      'List all subordinate agents with their status. Shows which agents are available (status="waiting") ' +
      'for reuse via forward_to_agent. ALWAYS call this before spawning to check if an existing agent can be reused.',
    parameters: {
      type: 'object',
      properties: {
        filter: {
          type: 'string',
          enum: ['all', 'available', 'running'],
          description: 'Filter: "all" (default), "available" (waiting/completed — can receive forward_to_agent), "running" (currently executing)',
        },
      },
      required: [],
    },
    source: 'native',
    handler: async (args) => {
      let subs = orchestrator.listSubordinates();
      const filter = (args.filter as string | undefined) ?? 'all';
      if (filter === 'available') {
        subs = subs.filter((s) => ['waiting', 'completed'].includes(s.status));
      } else if (filter === 'running') {
        subs = subs.filter((s) => ['running', 'working'].includes(s.status));
      }
      if (subs.length === 0) {
        if (filter === 'available') return ok('No available subordinates. Spawn a new one.');
        return ok('No subordinate agents spawned yet.');
      }
      const lines = subs.map((s) =>
        `- agent_run_id=${s.agentRunId} role=${s.role} status=${s.status}` +
        ` coder_session_id=${s.coderSessionId}` +
        ` projects=${JSON.stringify(s.projectIds)}` +
        ` provider=${s.provider} model=${s.model}` +
        (s.statusMessage ? ` last_message="${s.statusMessage}"` : '') +
        (s.isAlive ? ' [ALIVE]' : '') +
        (['waiting', 'completed'].includes(s.status) ? ' [AVAILABLE for forward_to_agent]' : ''),
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

function finalizeSubordinates(orchestrator: CompanyOrchestrator): CoderTool {
  return {
    name: 'finalize_subordinates',
    description:
      'Permanently shut down all subordinate agents after confirming with the user. ' +
      'Call this when you believe ALL work is complete. This asks the user for confirmation — ' +
      'if they say yes, all subordinates are aborted and marked completed. ' +
      'If they say no, subordinates remain alive/waiting for future tasks.',
    parameters: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: 'Brief summary of all completed work to present to the user for confirmation.',
        },
      },
      required: ['summary'],
    },
    source: 'native',
    handler: async (args, ctx) => {
      const summary = args.summary as string;
      const runner = ctx.runner;
      if (!runner) return err('finalize_subordinates requires runner context');

      const id = `finalize_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      runner.emit('question_posted', {
        type: 'question',
        id,
        question:
          `All work appears complete. Here is a summary:\n\n${summary}\n\n` +
          `Shall I finalize and shut down all subordinate agents?\n` +
          `- **Yes** = permanent shutdown, session complete\n` +
          `- **No** = keep agents alive for future tasks`,
        options: [
          { label: 'Yes, finalize all', value: 'yes' },
          { label: 'No, keep agents alive', value: 'no' },
        ],
        allowFreeform: true,
      });

      const answer = await runner.waitForUserInput();
      let parsed: { aborted?: boolean; interrupted?: boolean; answer?: string };
      try { parsed = JSON.parse(answer); } catch { parsed = { answer }; }
      if (parsed.aborted) return err('Finalization cancelled by user.');
      if (parsed.interrupted) {
        return err(
          'finalize_subordinates was interrupted: a subordinate agent is blocked waiting for your response. ' +
          'Use answer_subordinate_question() or approve_subordinate_tasks() to unblock them first, ' +
          'then call finalize_subordinates again when ready.',
        );
      }

      const userAnswer = (parsed.answer ?? answer).toLowerCase().trim();
      const isYes = userAnswer.startsWith('yes') || userAnswer === 'y' || userAnswer.includes('finalize');

      if (isYes) {
        const results = orchestrator.finalizeAllSubordinates();
        orchestrator.postToBoard('master', orchestrator.getMasterAgentRunId(), 'deliverable',
          `All ${results.finalized + results.alreadyStopped} subordinate agent(s) finalized. Session complete.\n\n${summary}`);
        return ok(`Finalized ${results.finalized} running + ${results.alreadyStopped} idle subordinate(s). Session is complete.`);
      } else {
        return ok(
          'Finalization cancelled. All subordinate agents remain in their current state. ' +
          'You can continue using forward_to_agent to send them new tasks, or spawn new subordinates.',
        );
      }
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
