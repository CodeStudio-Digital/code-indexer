/**
 * Skill tool builder — registers the `invoke_skill` meta-tool.
 *
 * Instead of registering one tool per skill (which would inflate the tool list),
 * we register a single `invoke_skill` tool that dispatches to any active
 * tool-mode skill by ID. The tool description lists all available skill IDs
 * so the model knows what it can invoke.
 */
import type { CoderTool } from '../core/tool.js';
import type { ResolvedSkill, SkillTemplateContext } from './types.js';
import { interpolateSkillVars } from './prompt-injector.js';
import { SkillStore } from '../../../store/skill-store.js';
import type { SessionStore } from '../sessions/store.js';

/**
 * Build discovery tools (`get_skills_list` + `get_skill_content`) for all active skills.
 * These are always registered regardless of contextMode and do not log usage.
 *
 * `sessionStore` + `sessionId` are optional; when provided, the body returned
 * by `get_skill_content` is mirrored into `coder_session_inputs` (kind
 * `skill_content`) so the Input tab in the session details modal reflects
 * mid-conversation skill loads.
 */
export function buildSkillDiscoveryTools(
  skills: ResolvedSkill[],
  templateCtx: SkillTemplateContext,
  sessionStore?: SessionStore,
  sessionId?: number,
): CoderTool[] {
  const listTool: CoderTool = {
    name: 'get_skills_list',
    description:
      'List all available skills with their ID, name, and description. Call this to discover which skills are available before fetching their content with get_skill_content.',
    source: 'native',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
    handler: async () => ({
      content: JSON.stringify(
        skills.map((s) => ({
          id: s.id,
          name: s.name,
          description: s.description,
          slashCommand: s.slashCommand ?? null,
        })),
        null,
        2,
      ),
    }),
  };

  const contentTool: CoderTool = {
    name: 'get_skill_content',
    description:
      'Get the full instructions of a specific skill by ID. Use get_skills_list first to discover available skill IDs.',
    source: 'native',
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
          sessionStore.recordSessionInput({
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

  return [listTool, contentTool];
}

/**
 * Build the `invoke_skill` meta-tool for all tool-mode skills.
 *
 * `sessionStore`, when provided, mirrors the interpolated skill body into
 * `coder_session_inputs` (kind `skill_content`, source `invoke_skill:<id>`)
 * for the Input tab.
 */
export function buildInvokeSkillTool(
  skills: ResolvedSkill[],
  templateCtx: SkillTemplateContext,
  dbPath: string,
  sessionId: number,
  sessionStore?: SessionStore,
): CoderTool {
  // Build a concise catalog for the tool description
  const catalog = skills
    .map((s) => `  - \`${s.id}\`: ${s.description || s.name}`)
    .join('\n');

  return {
    name: 'invoke_skill',
    description: `Invoke a reusable skill by ID. Skills are pre-configured prompt instruction packages that guide your behavior for specific tasks.\n\nAvailable skills:\n${catalog}\n\nWhen invoked, the skill's instructions are returned for you to follow.`,
    source: 'native',
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
          sessionStore.recordSessionInput({
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

      // Log usage (fire-and-forget)
      try {
        const store = new SkillStore(dbPath);
        store.logSkillUsage({
          session_id: sessionId,
          skill_id: skillId,
          invoked_by: 'model',
          input_text: userInput || undefined,
          duration_ms: Date.now() - start,
        });
        store.close();
      } catch {
        // Non-critical — don't fail the tool call
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
