// Reasoning levels published by Z.AI for these models.
// https://docs.z.ai/devpack/latest-model#switch-effort-thinking-intensity
// https://docs.z.ai/guides/llm/glm-5.3
// https://docs.z.ai/guides/vlm/glm-5.3-flash
const GLM_REASONING = {
  canReason: true,
  supportedReasoningLevels: ['low', 'high', 'max'],
  defaultReasoningLevel: 'max',
};

export const ZAI_MODELS: Readonly<Record<string, typeof GLM_REASONING>> = {
  'glm-5.4': GLM_REASONING,
  'glm-5.3': GLM_REASONING,
  'glm-5.3-flash': GLM_REASONING,
  'glm-5.3-flashx': GLM_REASONING,
  'glm-5.3-flashx-legal': GLM_REASONING,
};

/** These model IDs require thinking and control its depth through the effort. */
export function getZaiModelReasoning(model: string) {
  const [id = ''] = model.trim().toLowerCase().split('::');
  return Object.hasOwn(ZAI_MODELS, id) ? ZAI_MODELS[id] : undefined;
}
