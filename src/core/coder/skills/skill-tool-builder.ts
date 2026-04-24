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

/**
 * Build discovery tools (`get_skills_list` + `get_skill_content`) for all active skills.
 * These are always registered regardless of contextMode and do not log usage.
 */
export function buildSkillDiscoveryTools(
  skills: ResolvedSkill[],
  templateCtx: SkillTemplateContext,
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
 */
export function buildInvokeSkillTool(
  skills: ResolvedSkill[],
  templateCtx: SkillTemplateContext,
  dbPath: string,
  sessionId: number,
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

      const toolRestriction = skill.allowedTools
        ? `\n\n**Tool restrictions**: For this skill, you should only use these tools: ${skill.allowedTools.join(', ')}`
        : '';

      return {
        content: `[Skill: ${skill.name}]\n\n${interpolated}${userInput ? `\n\nUser input: ${userInput}` : ''}${toolRestriction}`,
        isError: false,
      };
    },
  };
}
