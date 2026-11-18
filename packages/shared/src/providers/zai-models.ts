// Published by Z.AI for both Chat Completions and the GLM Coding Plan.
// https://docs.z.ai/guides/llm/glm-5.3
// https://docs.z.ai/guides/vlm/glm-5.3-flash
const GLM_53_REASONING = {
  canReason: true,
  supportedReasoningLevels: ['low', 'high', 'max'],
  defaultReasoningLevel: 'max',
};

export const ZAI_MODELS: Readonly<Record<string, typeof GLM_53_REASONING>> = {
  'glm-5.3': GLM_53_REASONING,
  'glm-5.3-flash': GLM_53_REASONING,
  'glm-5.3-flashx': GLM_53_REASONING,
  'glm-5.3-flashx-legal': GLM_53_REASONING,
};

/** These model IDs require thinking and control its depth through the effort. */
export function getZaiModelReasoning(model: string) {
  const [id = ''] = model.trim().toLowerCase().split('::');
  return Object.hasOwn(ZAI_MODELS, id) ? ZAI_MODELS[id] : undefined;
}
