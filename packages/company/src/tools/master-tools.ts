/**
 * Master-only tools for the Company orchestrator.
 *
 * These are registered into the Master agent's ToolRegistry via runCoder's
 * companyContext integration. Subordinate agents never see them.
 */
import type { CoderTool, ToolResult, JsonSchema } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import type { CompanyOrchestrator } from '@mcp/company/orchestrator.js';
import { attachmentsToBlocks } from '@mcp/code-agent/core/messages.js';
import { buildPipelineMasterTools } from '@mcp/company/tools/pipeline-tools.js';
import { resolveAgentRunId } from '@mcp/company/tools/path-resolution.js';
import { observeOutcome } from '@mcp/services/shadow-traffic/index.js';

/** FNV-1a hash — matches the producer in recommendations.ts so observed
 *  outcomes correlate with the shadow rows created at recommend-role time. */
function fnv1aHash(text: string): string {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16);
}

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
    listContainers(orchestrator),
    readContainerLogs(orchestrator),
    respondToInbox(orchestrator),
    ...buildPipelineMasterTools(orchestrator),
  ];
}

// ─── spawn_subordinate_agent ───────────────────────────────────

function spawnSubordinateAgent(orchestrator: CompanyOrchestrator): CoderTool {
  const parameters: JsonSchema = {
    type: 'object',
    properties: {
      role: { type: 'string', description: 'Agent role name (e.g. "frontend", "backend", "qa", "po", "reviewer", "critic")' },
      task: { type: 'string', description: 'Task description for the subordinate agent' },
      project_id: {
        type: 'number',
        description:
          'Project id to delegate to. OMIT when the role is bound to exactly one project in "PROJECTS AND THEIR AGENTS" — it auto-resolves. Required when the role is bound to multiple projects or has no binding. If provided and not in the role\'s binding, the tool rejects with the allowed ids.',
      },
      provider: {
        type: 'string',
        description:
          'LLM provider. IGNORED when the role is listed under YOUR TEAM in the system prompt — those roles are template-locked and always use their configured provider. For untemplated roles: must match an ALLOWED SUBORDINATE MODELS entry when a pool is configured; otherwise free-form.',
      },
      model: {
        type: 'string',
        description:
          'Model name. IGNORED when the role is template-locked. For untemplated roles: must pair with `provider` as a tuple listed in ALLOWED SUBORDINATE MODELS (when configured).',
      },
      tier: { type: 'string', enum: ['bootstrap', 'navigate', 'full'], description: 'Tool tier for the agent. IGNORED for template-locked roles (template tier wins). Default for untemplated: navigate.' },
      skills: { type: 'array', items: { type: 'string' }, description: 'Optional skill IDs. IGNORED for template-locked roles (template skills win).' },
      kanban_card_id: { type: 'number', description: 'Optional Kanban card ID. When provided, the card\'s full context (description, checklist, comments) is prepended to the task, the agent is auto-assigned to the card, and the card moves to in_progress.' },
      wait: { type: 'boolean', description: 'If true, block until the subordinate completes (default: false)' },
      forward_user_attachments: {
        type: 'boolean',
        description: 'When true, includes the images the user attached to their most recent message (e.g. design inspiration, screenshots) so the subordinate sees them natively. Set this whenever the user shared a visual that informs the task.',
      },
      thinking: {
        type: 'boolean',
        description: 'When true, the subordinate runs with extended thinking (deep reasoning) on providers that support it. Costs extra tokens — use only for genuinely hard tasks (complex debugging, critical design, deep analysis). Default: false.',
      },
    },
    required: ['role', 'task'],
  };

  return {
    name: 'spawn_subordinate_agent',
    description: 'Delegate a task to a subordinate agent. The subordinate runs as a full coder session with write access, scoped to the project the role is bound to. The task MUST contain your synthesized research findings (specific file paths, functions, changes) — never copy-paste the user request. Think project-first: pick a role from the target project\'s "Agents working here" list; omit project_id when the role has a single binding. After calling this with wait=false, immediately call wait_for_subordinates.',
    parameters,
    source: 'native',
    handler: async (args) => {
      try {
        const role = args.role as string;
        let kanbanCardId = args.kanban_card_id as number | undefined;
        let task = args.task as string;

        // P16 — Auto-create a kanban card when the master forgot to
        // pass `kanban_card_id`. This keeps the board the single
        // source of truth for "what's in flight" even when the master
        // skips the discipline. We skip auto-create for trivially
        // short tasks (likely status checks) so the board doesn't
        // pollute with one-liners. Auto-created cards carry a
        // distinguishing first comment so the operator can spot them.
        if (!kanbanCardId && task && task.trim().length >= 20) {
          try {
            const excerpt = task.replace(/\s+/g, ' ').trim().slice(0, 60);
            const autoCard = orchestrator.kanbanCreateCard({
              title: `${role}: ${excerpt}${task.length > 60 ? '…' : ''}`,
              description: task.length > 200 ? task.slice(0, 200) + '…' : task,
              column: 'in_progress',
              tag: null,
              created_by: 'master',
            });
            try {
              orchestrator.kanbanAddComment(
                autoCard.id,
                'system',
                null,
                '[AUTO] Card created on spawn because the master did not pass `kanban_card_id`. ' +
                  'Add detailed context comments BEFORE spawning next time so the subordinate has ' +
                  'file paths / decisions / acceptance criteria embedded in its briefing.',
              );
            } catch { /* comment is a nice-to-have */ }
            kanbanCardId = autoCard.id;
          } catch {
            // Auto-create failures must NOT block a spawn. The master
            // continues without a card — same behavior as before P16.
            kanbanCardId = undefined;
          }
        }

        // Inject Kanban card context into task if card_id provided
        if (kanbanCardId) {
          const cardContext = orchestrator.getCardContextForSubordinate(kanbanCardId);
          if (cardContext) {
            task = `## Kanban Card Context\n\n${cardContext}\n\n---\n\n## Task\n\n${task}`;
          }
        }

        // Template enforcement: when the role has an entry in the
        // session template, the configured provider/model/tier/skills
        // are LOCKED — the master's own arguments for those fields are
        // discarded. The template is a commitment from the operator,
        // not a suggestion. Roles with no template entry fall through
        // to master-provided values or pool defaults.
        const defaults = orchestrator.getRoleDefaults(role);
        const templateLocked = defaults !== null;
        const argProvider = args.provider as string | undefined;
        const argModel = args.model as string | undefined;
        const argTier = args.tier as 'bootstrap' | 'navigate' | 'full' | undefined;
        const argSkills = args.skills as string[] | undefined;

        if (templateLocked && (argProvider || argModel || argTier || argSkills)) {
          console.warn(
            `[company] Template-locked role '${role}': ignoring master-provided ` +
              `provider=${argProvider ?? '∅'} model=${argModel ?? '∅'} ` +
              `tier=${argTier ?? '∅'} skills=${argSkills ? argSkills.join(',') : '∅'}`,
          );
        }
        const forwardAtts = args.forward_user_attachments as boolean | undefined;
        const attachments = forwardAtts
          ? [...orchestrator.getMasterLastUserAttachments()]
          : undefined;

        const result = await orchestrator.spawnSubordinate({
          role,
          task,
          projectId: args.project_id as number | undefined,
          provider: templateLocked ? defaults!.provider : argProvider,
          model: templateLocked ? defaults!.model : argModel,
          tier: templateLocked
            ? (defaults!.tier as 'bootstrap' | 'navigate' | 'full' | undefined)
            : argTier,
          skills: templateLocked ? defaults!.skills : argSkills,
          wait: args.wait as boolean | undefined,
          roleOverride: defaults?.systemPromptOverride,
          temperature: defaults?.temperature,
          attachments: attachments && attachments.length > 0 ? attachments : undefined,
          thinking: args.thinking as boolean | undefined,
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

        // FeedbackCollector — backfill any role_pipeline counterfactual
        // rows whose query_hash matches THIS task. Records the actually-
        // spawned role + agentRunId as the true outcome so the analytics
        // can later compare against the shadow recommendations.
        if (result.agentRunId) {
          observeOutcome('role_pipeline', {
            queryHash: fnv1aHash(task),
            roleSpawned: role,
            agentRunId: result.agentRunId,
          });
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
      const deadline = Date.now() + timeoutMs;

      if (!orchestrator.hasRunningSubordinates()) {
        return ok('No subordinates currently running — all done.');
      }

      // Event-driven wait: we sleep until a subordinate signals it needs the
      // master's attention (question / plan / tasks) or transitions to a
      // terminal status (finished). Attention-triggering events make us
      // return immediately so the master can run a turn and consume the
      // `pushUserMessage` notification that HumanInTheLoop already queued.
      while (orchestrator.hasRunningSubordinates()) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          const subs = orchestrator.listSubordinates().filter((s) => s.status === 'running');
          return err(
            `Timed out after ${args.timeout_minutes ?? 30}min. Still running: ${subs.map((s) => s.role).join(', ')}. ` +
            `Use list_subordinates to check status or abort_subordinate_agent if needed.`,
          );
        }

        const event = await new Promise<
          | { kind: 'question' | 'plan' | 'tasks' | 'finished'; agentRunId: number; role: string }
          | { kind: 'timeout' }
        >((resolve) => {
          let done = false;
          const off = orchestrator.onSubordinateAttention((ev) => {
            if (done) return;
            // Inbox answers are subordinate↔subordinate signals; the
            // master doesn't need to wake for those.
            if (ev.kind === 'inbox_answered') return;
            done = true;
            clearTimeout(timer);
            off();
            resolve({ kind: ev.kind, agentRunId: ev.agentRunId, role: ev.role });
          });
          const timer = setTimeout(() => {
            if (done) return;
            done = true;
            off();
            resolve({ kind: 'timeout' });
          }, remaining);
        });

        if (event.kind === 'question' || event.kind === 'plan' || event.kind === 'tasks') {
          return ok(
            `Subordinate @${event.role} (run=${event.agentRunId}) needs your attention: posted a ${event.kind}. ` +
            `The notification with full details was already pushed to your message queue — read it next and respond with ` +
            `${event.kind === 'question' ? 'answer_subordinate_question' : event.kind === 'plan' ? 'approve_subordinate_plan' : 'approve_subordinate_tasks'}. ` +
            `Call wait_for_subordinates again after you respond to keep waiting for the others.`,
          );
        }
        // 'finished' or 'timeout' → re-check the loop condition.
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
      agent_run_id: { type: 'number', description: 'ID of the subordinate agent run. Equivalent to passing `path` — use whichever you have.' },
      path: { type: 'string', description: 'Agent path as returned by list_agents (e.g. "/root/master/qa-7"). Alternative to agent_run_id.' },
      approved: { type: 'boolean', description: 'Whether to approve (true) or reject (false) the plan' },
      feedback: { type: 'string', description: 'Optional feedback for the subordinate' },
    },
    required: ['approved'],
  };

  return {
    name: 'approve_subordinate_plan',
    description: "Approve or reject a subordinate agent's pending plan. Pass either agent_run_id or path. The subordinate is blocked until you respond. Check the board for the plan content.",
    parameters,
    source: 'native',
    handler: async (args) => {
      const target = resolveAgentRunId(args);
      if (!target.ok) return err(`approve_subordinate_plan: ${target.detail}`);
      const { agentRunId } = target;
      const approved = args.approved as boolean;
      const feedback = args.feedback as string | undefined;

      if (!orchestrator.hasPendingPlan(agentRunId)) {
        return err(`No pending plan found for agent_run_id ${agentRunId}. Use list_agents or list_subordinates to check status.`);
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
      agent_run_id: { type: 'number', description: 'ID of the subordinate agent run. Equivalent to passing `path`.' },
      path: { type: 'string', description: 'Agent path as returned by list_agents (e.g. "/root/master/qa-7"). Alternative to agent_run_id.' },
      answer: { type: 'string', description: 'Your answer to the subordinate\'s question' },
    },
    required: ['answer'],
  };

  return {
    name: 'answer_subordinate_question',
    description:
      "Answer a subordinate agent's pending question. Pass either agent_run_id or path. The subordinate is blocked until you respond. " +
      "If you don't know the answer, use ask_user to escalate to the human, then relay their response with this tool.",
    parameters,
    source: 'native',
    handler: async (args) => {
      const target = resolveAgentRunId(args);
      if (!target.ok) return err(`answer_subordinate_question: ${target.detail}`);
      const { agentRunId } = target;
      const answer = args.answer as string;

      if (!orchestrator.hasPendingQuestion(agentRunId)) {
        return err(`No pending question found for agent_run_id ${agentRunId}. Use list_agents or list_subordinates to check status.`);
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
      agent_run_id: { type: 'number', description: 'ID of the subordinate agent run. Equivalent to passing `path`.' },
      path: { type: 'string', description: 'Agent path as returned by list_agents (e.g. "/root/master/qa-7"). Alternative to agent_run_id.' },
      approved: { type: 'boolean', description: 'Whether to approve (true) or reject (false) the task list' },
      feedback: { type: 'string', description: 'Optional feedback for the subordinate' },
      execution_mode: {
        type: 'string',
        enum: ['inline', 'per-task', 'all-subagent', 'smart'],
        description: 'How the subordinate should execute tasks (default: inline)',
      },
    },
    required: ['approved'],
  };

  return {
    name: 'approve_subordinate_tasks',
    description:
      "Approve or reject a subordinate agent's pending task list. Pass either agent_run_id or path. The subordinate is blocked until you respond. " +
      "Check the board for the task list content.",
    parameters,
    source: 'native',
    handler: async (args) => {
      const target = resolveAgentRunId(args);
      if (!target.ok) return err(`approve_subordinate_tasks: ${target.detail}`);
      const { agentRunId } = target;
      const approved = args.approved as boolean;
      const feedback = args.feedback as string | undefined;
      const executionMode = args.execution_mode as string | undefined;

      if (!orchestrator.hasPendingTasks(agentRunId)) {
        return err(`No pending task list found for agent_run_id ${agentRunId}. Use list_agents or list_subordinates to check status.`);
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
      agent_run_id: { type: 'number', description: 'ID of the subordinate agent run to abort. Equivalent to passing `path`.' },
      path: { type: 'string', description: 'Agent path as returned by list_agents (e.g. "/root/master/qa-7"). Alternative to agent_run_id.' },
      reason: { type: 'string', description: 'Optional reason for the abort' },
    },
    required: [],
  };

  return {
    name: 'abort_subordinate_agent',
    description: "Abort a running subordinate agent. Pass either agent_run_id or path. This immediately stops the agent's execution.",
    parameters,
    source: 'native',
    handler: async (args) => {
      const target = resolveAgentRunId(args);
      if (!target.ok) return err(`abort_subordinate_agent: ${target.detail}`);
      const { agentRunId } = target;
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
      agent_run_id: { type: 'number', description: 'ID of the target subordinate agent. Equivalent to passing `path`.' },
      path: { type: 'string', description: 'Agent path as returned by list_agents (e.g. "/root/master/qa-7"). Alternative to agent_run_id.' },
      message: { type: 'string', description: 'Message to forward to the agent' },
      forward_user_attachments: {
        type: 'boolean',
        description: 'When true, includes the images the user attached to their most recent message so the subordinate sees them natively. Set this whenever the visual context matters for what you are forwarding.',
      },
      thinking: {
        type: 'boolean',
        description: 'When true, the subordinate runs the next turn with extended thinking (deep reasoning) on providers that support it. Costs extra tokens — use only for hard follow-ups (debugging, design pivots, critical reviews). Default: false.',
      },
    },
    required: ['message'],
  };

  return {
    name: 'forward_to_agent',
    description: "Send a task or message to a subordinate agent. Pass either agent_run_id or path. If the agent is 'waiting' (finished previous task), it auto-reactivates with full context preserved. Use this to reuse agents instead of spawning new ones.",
    parameters,
    source: 'native',
    handler: async (args) => {
      const target = resolveAgentRunId(args);
      if (!target.ok) return err(`forward_to_agent: ${target.detail}`);
      const agentRunId = target.agentRunId;
      const message = args.message as string;
      const forwardAtts = args.forward_user_attachments as boolean | undefined;
      const attachments = forwardAtts
        ? [...orchestrator.getMasterLastUserAttachments()]
        : [];
      const thinking = args.thinking as boolean | undefined;

      const sub = orchestrator.getSubordinate(agentRunId);
      const dbStatus = orchestrator.getSubordinateStatus(agentRunId);

      // Post to board first
      const roleName = sub?.role ?? `agent-${agentRunId}`;
      const boardSuffix = attachments.length > 0
        ? `\n\n_[${attachments.length} ${attachments.length === 1 ? 'attachment' : 'attachments'} forwarded]_`
        : '';
      orchestrator.postToBoard('master', null, 'handoff',
        `[@${roleName}] ${message}${boardSuffix}`, [roleName]);

      const isRunning = orchestrator.isSubordinateRunning(agentRunId);
      const prefixed = `[From Master]: ${message}`;

      // If the agent is actually running its event loop, push directly.
      if (isRunning && sub) {
        if (thinking !== undefined) sub.runner.setThinking(thinking);
        if (attachments.length > 0) {
          sub.runner.pushUserContent(attachmentsToBlocks(prefixed, attachments));
        } else {
          sub.runner.pushUserMessage(prefixed);
        }
        return ok(`Message forwarded to ${roleName} (agent_run_id=${agentRunId})`);
      }

      // Otherwise, the agent is dead (waiting, completed, errored, aborted),
      // we must reactivate it via a new runCoder call.
      const reactivated = await orchestrator.reactivateSubordinate(
        agentRunId,
        prefixed,
        attachments.length > 0 ? attachments : undefined,
        thinking,
      );
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
      thinking: {
        type: 'boolean',
        description: 'When true, the resumed subordinate runs with extended thinking (deep reasoning) on providers that support it. Costs extra tokens — use only when the retry needs deeper analysis than the first attempt. Default: false.',
      },
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
          args.thinking as boolean | undefined,
        );
        return ok(JSON.stringify(result, null, 2));
      } catch (e) {
        return err(`Failed to resume subordinate: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
}

// ─── list_containers ───────────────────────────────────────────

function listContainers(orchestrator: CompanyOrchestrator): CoderTool {
  return {
    name: 'list_containers',
    description:
      'Enumerate every sandbox container in this session (primary + each microservice) with a health snapshot: ' +
      'running state, last exit code, OOM flag, preview URL. Use this right after a subordinate reports completion ' +
      'on build-touching work (scaffolder, dependency install, dev-server config) to confirm the service actually ' +
      'came up. Pair with read_container_logs to diagnose anything that is stopped or crashed.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    source: 'native',
    handler: async () => {
      const primary = orchestrator.getSandboxBinding();
      const services = orchestrator.sandboxService.listServiceBindings();
      const entries: Array<{ serviceId: string; binding: import('@mcp/company/types.js').SandboxBinding }> = [];
      if (primary) entries.push({ serviceId: primary.serviceId ?? 'main', binding: primary });
      for (const s of services) entries.push({ serviceId: s.serviceId, binding: s.binding });

      if (entries.length === 0) {
        return ok('No sandbox is active for this session.');
      }

      const rows = await Promise.all(
        entries.map(async ({ serviceId, binding }) => {
          const [inspect, state] = await Promise.all([
            binding.driver.inspectContainer(binding.containerId).catch(() => ({
              exists: false,
              running: false,
              paused: false,
              labels: {} as Record<string, string>,
            })),
            binding.driver.getContainerState(binding.containerId).catch(() => null),
          ]);
          const status = !inspect.exists
            ? 'gone'
            : inspect.paused
              ? 'paused'
              : inspect.running
              ? 'running'
              : 'stopped';
          const parts: string[] = [];
          parts.push(`${serviceId.padEnd(12)} ${status}`);
          if (state) {
            if (state.exitCode !== null) parts.push(`exitCode=${state.exitCode}`);
            if (state.oomKilled) parts.push(`oomKilled=true`);
            if (state.finishedAt && !inspect.running) parts.push(`finishedAt=${state.finishedAt}`);
          }
          parts.push(`previewUrl=${binding.previewUrl}`);
          parts.push(`workdir=${binding.workdir}`);
          const line = parts.join(' ');
          const stateError = state?.error?.trim();
          return stateError
            ? `${line}\n  ↳ last state error: ${stateError}`
            : line;
        }),
      );
      const footer =
        '\nUse read_container_logs(service_id=<id>, tail=<n>) to inspect a specific container.';
      return ok(rows.join('\n') + footer);
    },
  };
}

// ─── respond_to_inbox ──────────────────────────────────────────

function respondToInbox(orchestrator: CompanyOrchestrator): CoderTool {
  return {
    name: 'respond_to_inbox',
    description:
      'Answer a queued message a subordinate addressed to you via send_to_master with kind="question". ' +
      'The `message_id` is shown in the [INBOX ...] block of the user turn that injected the message. ' +
      'The waiting subordinate unblocks immediately and receives your answer as the resolved value of its send_to_master call.',
    parameters: {
      type: 'object',
      properties: {
        message_id: {
          type: 'number',
          description: 'Id of the inbox message to answer (printed in the [INBOX ...] header).',
        },
        answer: { type: 'string', description: 'Your answer. Plain text — keep it focused.' },
      },
      required: ['message_id', 'answer'],
      additionalProperties: false,
    },
    source: 'native',
    handler: async (args) => {
      const messageId = Number(args.message_id);
      const answer = String(args.answer ?? '').trim();
      if (!Number.isFinite(messageId)) return err('message_id must be a number');
      if (!answer) return err('answer cannot be empty');
      const ok2 = orchestrator.inboxRespond(messageId, answer);
      if (!ok2) {
        return err(`Message ${messageId} is not answerable (not found or already terminal).`);
      }
      return ok(`Answered inbox message ${messageId}.`);
    },
  };
}

// ─── read_container_logs ───────────────────────────────────────

function readContainerLogs(orchestrator: CompanyOrchestrator): CoderTool {
  return {
    name: 'read_container_logs',
    description:
      'Tail stdout/stderr for one container in this session. Use after list_containers flags a service as ' +
      'stopped, crashed, or with a non-zero exit code. Include the relevant excerpt verbatim in the fix task ' +
      'you dispatch to a subordinate so it can reproduce and address the actual error.',
    parameters: {
      type: 'object',
      properties: {
        service_id: {
          type: 'string',
          description:
            "Target container. 'main' (or omitted) = primary master container. Any other value must be a " +
            'microservice id from list_containers.',
        },
        tail: {
          type: 'integer',
          description: 'Number of trailing log lines to return (default 200, max 2000).',
        },
      },
      required: [],
    },
    source: 'native',
    handler: async (args) => {
      const serviceId = ((args.service_id as string | undefined) ?? 'main').trim();
      const rawTail = args.tail as number | undefined;
      const tail = Math.min(
        2000,
        Math.max(1, Number.isFinite(rawTail as number) ? (rawTail as number) : 200),
      );
      const binding =
        serviceId === 'main' || serviceId === ''
          ? orchestrator.getSandboxBinding()
          : orchestrator.getSandboxServiceBinding(serviceId);
      if (!binding) {
        return err(
          `No container for service_id '${serviceId}'. Use list_containers to see what's available.`,
        );
      }
      const logs = await binding.driver.getContainerLogs(binding.containerId, tail);
      return ok(logs || '(no log output)');
    },
  };
}
