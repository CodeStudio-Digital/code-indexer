/**
 * spawn_agent — unified entry point that dispatches to the existing
 * `spawn_subagent` or `spawn_subordinate_agent` based on the `kind` arg.
 *
 * Final slice of the unified agent tree. Deliberately a THIN WRAPPER: it
 * does not change the semantics of either underlying spawn — it only gives
 * the model one path-shaped name to remember and a single schema to learn.
 * Both originals stay registered so callers that already know them keep
 * working byte-for-byte.
 *
 *   kind: 'ephemeral'  → runs inline as a read-only investigation subagent
 *                        (uses the spawn_subagent allowlist + lifecycle).
 *                        Available in any session.
 *   kind: 'persistent' → spawns a full coder subordinate inside a company
 *                        session. Available ONLY when the caller is the
 *                        master of a company session.
 *
 * Implementation-wise we look up the target tool from the registry and
 * invoke it. That preserves anything done to the originals at runtime
 * (filtering, policy gating, hooks) without us having to mirror it.
 */
import type { CoderTool, ToolResult, ToolContext } from '../core/tool.js';
import type { ToolRegistry } from '../core/registry.js';
import { ok, err } from '../core/tool.js';
import { maybeTerse } from './descriptions.js';

const SPAWN_AGENT_DESC =
  'Unified spawn dispatcher for the agent tree. Picks the right underlying spawn based on `kind`.\n' +
  '\n' +
  '`kind: "ephemeral"` → inline read-only investigation subagent (delegates to spawn_subagent). Cheap, returns a final summary string. Use for batched discovery you would otherwise run sequentially across turns.\n' +
  '`kind: "persistent"` → full coder subordinate (delegates to spawn_subordinate_agent). Master-only. Use when the work needs write access, plans/tasks, board posts, or survives the current tool call.\n' +
  '\n' +
  "USE: when you want one tool name to remember regardless of intent.\n" +
  "USE: persistent when the work fits a role you already have configured.\n" +
  "DON'T: spawn persistent for read-only exploration — use ephemeral; it is much cheaper.\n" +
  "DON'T: spawn ephemeral when the work needs to write code or interact with the user — it has no write tools and no plan/task lifecycle.";

export function buildSpawnAgentTool(registry: ToolRegistry): CoderTool {
  return {
    name: 'spawn_agent',
    description: maybeTerse(SPAWN_AGENT_DESC),
    source: 'native',
    parameters: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['ephemeral', 'persistent'],
          description: 'Lifecycle of the spawned agent. "ephemeral" runs inline and returns a summary; "persistent" spawns a full coder subordinate (master only).',
        },
        task: { type: 'string', description: 'Task description for the spawned agent.' },

        // ─── ephemeral fields (and shared with persistent-outside-Company) ───
        type: { type: 'string', enum: ['explore'], description: 'Ephemeral subagent type. Defaults to "explore". Ignored when kind="persistent".' },
        max_turns: { type: 'number', description: 'Max turns for the spawned subagent loop. Used by ephemeral and by persistent-outside-Company. Ignored in Company master sessions.' },
        files: { type: 'array', items: { type: 'string' }, description: 'When kind="persistent" outside a Company session, optional whitelist of project-relative paths the implement subagent may write to. Edits outside the list are refused. Ignored elsewhere.' },

        // ─── persistent-only fields (Company master) ───
        role: { type: 'string', description: 'Subordinate role (e.g. "frontend", "qa"). REQUIRED only when running inside a Company master session — outside Company, persistent maps to an implement subagent and `role` is ignored.' },
        project_id: { type: 'number', description: 'Project id to delegate to. Persistent only.' },
        provider: { type: 'string', description: 'LLM provider override. Persistent only; ignored when role is template-locked.' },
        model: { type: 'string', description: 'Model override. Persistent only; ignored when role is template-locked.' },
        tier: { type: 'string', enum: ['bootstrap', 'navigate', 'full'], description: 'Tool tier for the subordinate. Persistent only; ignored when role is template-locked.' },
        skills: { type: 'array', items: { type: 'string' }, description: 'Skill IDs. Persistent only; ignored when template-locked.' },
        kanban_card_id: { type: 'number', description: 'Persistent only. Auto-assigns the subordinate to a kanban card and prepends the card context.' },
        wait: { type: 'boolean', description: 'Persistent only. When true, blocks until the subordinate completes (default false).' },
        forward_user_attachments: { type: 'boolean', description: 'Persistent only. Forwards the user\'s most recent image attachments to the subordinate.' },
      },
      required: ['kind', 'task'],
      additionalProperties: false,
    },
    handler: async (args, ctx: ToolContext): Promise<ToolResult> => {
      const kind = args.kind;
      const task = String(args.task ?? '').trim();
      if (!task) return err('spawn_agent: task cannot be empty');

      if (kind === 'ephemeral') {
        const target = registry.get('spawn_subagent');
        if (!target) {
          return err('spawn_agent: spawn_subagent is not available in this session (CODER_DISABLE_SUBAGENTS=1 or master mode).');
        }
        return await registry.invoke('spawn_subagent', {
          type: typeof args.type === 'string' ? args.type : 'explore',
          task,
          max_turns: args.max_turns,
        }, ctx);
      }

      if (kind === 'persistent') {
        // Inside a Company master session, persistent → spawn_subordinate_agent
        // (full coder session inside the orchestrator, with kanban/board/etc.).
        const masterSpawn = registry.get('spawn_subordinate_agent');
        if (masterSpawn) {
          const role = typeof args.role === 'string' ? args.role.trim() : '';
          if (!role) return err('spawn_agent: in a company master session, kind="persistent" requires `role`.');
          return await registry.invoke('spawn_subordinate_agent', {
            role,
            task,
            project_id: args.project_id,
            provider: args.provider,
            model: args.model,
            tier: args.tier,
            skills: args.skills,
            kanban_card_id: args.kanban_card_id,
            wait: args.wait,
            forward_user_attachments: args.forward_user_attachments,
          }, ctx);
        }
        // Outside Company, persistent → an `implement` subagent. Same
        // process boundary as the parent runner (no separate session row),
        // but with a full read+write+shell toolset, an isolated context
        // window, and the parent's configured subagent provider/model
        // (set in admin under "Subagent target" — keeps cost off the
        // primary session quota when configured).
        const ephemeralImplement = registry.get('spawn_subagent');
        if (!ephemeralImplement) {
          return err('spawn_agent: neither spawn_subordinate_agent (master-only) nor spawn_subagent are available in this session.');
        }
        const filesArg = Array.isArray(args.files)
          ? (args.files as unknown[]).filter((f): f is string => typeof f === 'string')
          : undefined;
        return await registry.invoke('spawn_subagent', {
          type: 'implement',
          task,
          max_turns: args.max_turns,
          files: filesArg,
        }, ctx);
      }

      return err(`spawn_agent: unknown kind '${String(kind)}' — must be 'ephemeral' or 'persistent'.`);
    },
  };
}
