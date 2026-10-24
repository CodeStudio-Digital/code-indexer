/**
 * Skill tool builder — registers the `invoke_skill` meta-tool.
 *
 * Instead of registering one tool per skill (which would inflate the tool list),
 * we register a single `invoke_skill` tool that dispatches to any active
 * tool-mode skill by ID. The tool description lists all available skill IDs
 * so the model knows what it can invoke.
 */
import type { CoderTool } from '@mcp/code-agent/core/tool.js';
import type { ResolvedSkill, SkillTemplateContext } from '@mcp/code-agent/skills/types.js';
import { interpolateSkillVars } from '@mcp/code-agent/skills/prompt-injector.js';
import { groupSkillsByNamespace } from '@mcp/code-agent/skills/namespace.js';
import type { InstalledNamespaceSummary } from '@mcp/code-agent/skills/agent-skills-installer.js';
import type { FsSessionStore } from '@mcp/session-storage/fs-store/fs-session-store.js';
import type { SessionId } from '@mcp/session-storage';

const SAMPLE_SKILL_IDS_PER_NAMESPACE = 5;

/**
 * Build discovery tools (`list_skill_namespaces` + `get_skills_list` +
 * `get_skill_content`) for all active skills. Always registered regardless
 * of contextMode; do not log usage.
 *
 * The three tools form a 3-level discovery hierarchy taught to the agent
 * via the system prompt:
 *   1. `list_skill_namespaces` — see installed packs (counts, repo, sample IDs)
 *   2. `get_skills_list({namespace})` — drill into a pack
 *   3. `get_skill_content({skill_id})` — load instructions
 *
 * `installedNamespaces` (optional) enriches `list_skill_namespaces` with
 * repo/commit metadata from agent-skills-installer. When omitted, the tool
 * still returns the namespace list with counts and sample IDs.
 *
 * `sessionStore` + `sessionId` are optional; when provided, the body returned
 * by `get_skill_content` is mirrored into the session input files (kind
 * `skill_content`) so the Input tab in the session details modal reflects
 * mid-conversation skill loads.
 */
export function buildSkillDiscoveryTools(
  skills: ResolvedSkill[],
  templateCtx: SkillTemplateContext,
  sessionStore?: FsSessionStore,
  sessionId?: SessionId,
  installedNamespaces?: InstalledNamespaceSummary[],
): CoderTool[] {
  const installedByName = new Map<string, InstalledNamespaceSummary>();
  if (installedNamespaces) {
    for (const ns of installedNamespaces) installedByName.set(ns.namespace, ns);
  }

  const namespacesTool: CoderTool = {
    name: 'list_skill_namespaces',
    description:
      'List all skill packs (namespaces) available in this session, with counts, repo origin, and a few sample skill IDs to hint at each pack\'s theme. Call this first when starting a new task to choose which pack to explore. Then call get_skills_list({namespace}) to see specific skills inside a pack, and get_skill_content({skill_id}) to load instructions before doing the work.',
    source: 'native',
    mutates: false, parallelSafe: true, riskLevel: 'read',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
    handler: async () => {
      const grouped = groupSkillsByNamespace(skills);
      const namespaces = [...grouped.entries()].map(([namespace, items]) => {
        const sampleSkillIds = [...items]
          .sort((a, b) => a.id.localeCompare(b.id))
          .slice(0, SAMPLE_SKILL_IDS_PER_NAMESPACE)
          .map((s) => s.id);
        const installed = installedByName.get(namespace);
        return {
          namespace,
          count: items.length,
          repo: installed?.repo ?? null,
          commit: installed?.commit ?? null,
          sampleSkillIds,
        };
      });
      return {
        content: JSON.stringify(
          {
            totalSkills: skills.length,
            namespaces,
          },
          null,
          2,
        ),
      };
    },
  };

  const listTool: CoderTool = {
    name: 'get_skills_list',
    description:
      'List skills, optionally filtered to a single namespace. Pass `namespace` (from list_skill_namespaces) to drill into one pack and get the full set of {id, name, description, slashCommand}. Without `namespace` you get a compact overview {totalSkills, byNamespace[{namespace, count}]} — call list_skill_namespaces instead for richer metadata (repo, sample IDs). After picking a skill, call get_skill_content with its ID to load full instructions.',
    source: 'native',
    mutates: false, parallelSafe: true, riskLevel: 'read',
    parameters: {
      type: 'object',
      properties: {
        namespace: {
          type: 'string',
          description:
            'Optional. Filter to one namespace. Use the namespace name from list_skill_namespaces (e.g. "user", "builtin", "anthropic-skills"). Omit for a compact overview.',
        },
      },
      required: [],
      additionalProperties: false,
    },
    handler: async (args) => {
      const requested = typeof args.namespace === 'string' && args.namespace.length > 0
        ? args.namespace
        : null;
      const grouped = groupSkillsByNamespace(skills);

      if (!requested) {
        const byNamespace = [...grouped.entries()].map(([namespace, items]) => ({
          namespace,
          count: items.length,
        }));
        return {
          content: JSON.stringify(
            {
              totalSkills: skills.length,
              byNamespace,
              hint: 'Call list_skill_namespaces for richer metadata (repo, sample IDs) or get_skills_list({namespace: "X"}) to see skills inside a pack.',
            },
            null,
            2,
          ),
        };
      }

      const items = grouped.get(requested);
      if (!items || items.length === 0) {
        const valid = [...grouped.keys()];
        return {
          content: `Namespace "${requested}" not found or has no active skills. Available namespaces: ${valid.join(', ')}. Call list_skill_namespaces to see counts and sample IDs.`,
          isError: true,
        };
      }

      const sortedItems = [...items].sort((a, b) => a.id.localeCompare(b.id));
      return {
        content: JSON.stringify(
          {
            namespace: requested,
            count: sortedItems.length,
            skills: sortedItems.map((s) => ({
              id: s.id,
              name: s.name,
              description: s.description,
              slashCommand: s.slashCommand ?? null,
            })),
          },
          null,
          2,
        ),
      };
    },
  };

  const contentTool: CoderTool = {
    name: 'get_skill_content',
    description:
      'Get the full instructions of a specific skill by ID. Use get_skills_list first to discover available skill IDs.',
    source: 'native',
    mutates: false, parallelSafe: false, riskLevel: 'read',
    outputPolicy: { mode: 'authoritative', reducer: 'none', recovery: 'output_store', preserveOnError: true },
    parameters: {
      type: 'object',
      properties: {
        skill_id: { type: 'string', description: 'ID of the skill to retrieve.' },
      },
      required: ['skill_id'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const skill = skills.find((s) => s.id === (args.skill_id as string));
      if (!skill) {
        return {
          content: `Skill "${args.skill_id}" not found. Use get_skills_list to see available IDs.`,
          isError: true,
        };
      }
      const fullCtx: SkillTemplateContext = { ...templateCtx, TIMESTAMP: new Date().toISOString() };
      const body = interpolateSkillVars(skill.promptBody, fullCtx);
      if (sessionStore && sessionId != null) {
        try {
          await sessionStore.recordSessionInput({
            session_id: sessionId,
            kind: 'skill_content',
            source_label: `skill:${skill.id}`,
            content: body,
            meta: {
              skill_name: skill.name,
              source: skill.source,
              allowed_tools: skill.allowedTools ?? null,
            },
          });
        } catch {
          // Logging is best-effort — never fail the tool call.
        }
      }
      return {
        content: JSON.stringify(
          {
            id: skill.id,
            name: skill.name,
            promptBody: body,
            allowedTools: skill.allowedTools ?? null,
            source: skill.source,
          },
          null,
          2,
        ),
      };
    },
  };

  return [namespacesTool, listTool, contentTool];
}

/**
 * Build the `invoke_skill` meta-tool for all tool-mode skills.
 *
 * `sessionStore`, when provided, mirrors the interpolated skill body into
 * the session input files (kind `skill_content`, source `invoke_skill:<id>`)
 * for the Input tab.
 */
export function buildInvokeSkillTool(
  skills: ResolvedSkill[],
  templateCtx: SkillTemplateContext,
  sessionId: SessionId,
  sessionStore?: FsSessionStore,
): CoderTool {
  // Build a concise catalog for the tool description
  const catalog = skills
    .map((s) => `  - \`${s.id}\`: ${s.description || s.name}`)
    .join('\n');

  return {
    name: 'invoke_skill',
    description: `Invoke a reusable skill by ID. Skills are pre-configured prompt instruction packages that guide your behavior for specific tasks.\n\nAvailable skills:\n${catalog}\n\nWhen invoked, the skill's instructions are returned for you to follow.`,
    source: 'native',
    mutates: false, parallelSafe: false, riskLevel: 'read',
    outputPolicy: { mode: 'authoritative', reducer: 'none', recovery: 'output_store', preserveOnError: true },
    parameters: {
      type: 'object',
      properties: {
        skill_id: {
          type: 'string',
          description: 'ID of the skill to invoke.',
          enum: skills.map((s) => s.id),
        },
        input: {
          type: 'string',
          description: 'Optional input text or context for the skill invocation.',
        },
      },
      required: ['skill_id'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const skillId = args.skill_id as string;
      const userInput = typeof args.input === 'string' ? args.input : '';
      const start = Date.now();

      const skill = skills.find((s) => s.id === skillId);
      if (!skill) {
        return {
          content: `Error: skill "${skillId}" not found. Available: ${skills.map((s) => s.id).join(', ')}`,
          isError: true,
        };
      }

      const fullCtx: SkillTemplateContext = { ...templateCtx, USER_INPUT: userInput, TIMESTAMP: new Date().toISOString() };
      const interpolated = interpolateSkillVars(skill.promptBody, fullCtx);

      if (sessionStore) {
        try {
          await sessionStore.recordSessionInput({
            session_id: sessionId,
            kind: 'skill_content',
            source_label: `invoke_skill:${skill.id}`,
            content: interpolated,
            meta: {
              skill_name: skill.name,
              source: skill.source,
              user_input: userInput || null,
              allowed_tools: skill.allowedTools ?? null,
            },
          });
        } catch {
          // best-effort
        }
      }

      // Session-scoped usage belongs to the bundle, never SQLite.
      if (sessionStore) {
        try {
          await sessionStore.appendSessionEvent(
            sessionId,
            'skill_usage',
            {
              skill_id: skillId,
              invoked_by: 'model',
              input_text: userInput || null,
              duration_ms: Date.now() - start,
              outcome: 'success',
            },
            `skill-usage:${skillId}:${start}`,
          );
        } catch {
          // Non-critical — don't fail the tool call.
        }
      }

      const toolRestriction = skill.allowedTools && skill.allowedTools.length > 0
        ? [
            '',
            '---',
            '## TOOL RESTRICTION (mandatory)',
            '',
            `For this task, restrict yourself to ONLY the following tools:`,
            ...skill.allowedTools.map((t) => `- \`${t}\``),
            '',
            'Calling tools outside this list is a contract violation: the user explicitly tagged this skill with `allowed-tools` because the workflow only needs that subset. Stay in scope. If you genuinely need a tool outside the list (e.g. a search you didn\'t plan for), STOP and ask the master via `ask_master` before reaching for it.',
          ].join('\n')
        : '';

      return {
        content: `[Skill: ${skill.name}]\n\n${interpolated}${userInput ? `\n\nUser input: ${userInput}` : ''}${toolRestriction}`,
        isError: false,
      };
    },
  };
}
