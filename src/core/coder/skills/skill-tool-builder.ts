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
