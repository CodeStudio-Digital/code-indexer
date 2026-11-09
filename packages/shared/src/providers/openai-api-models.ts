/** Public API metadata, verified against the official model pages on 2026-11-06.
 * GET /v1/models supplies availability/IDs, not context or reasoning controls.
 * Keep these values separate from the account-specific ChatGPT/Codex catalog.
 * Source for each entry: https://developers.openai.com/api/docs/models/<model-id>
 */
export interface OpenAIApiModelMetadata {
  contextWindow: number;
  maxTokens: number;
  canReason: boolean;
  supportsAttachments: boolean;
  inputModalities: string[];
  supportedReasoningLevels: string[] | null;
  defaultReasoningLevel: string | null;
  applyPatchToolType?: 'freeform';
}

const HIGH = ['low', 'medium', 'high', 'xhigh', 'max'];
const ALL = ['none', ...HIGH];
const STANDARD = ['none', 'low', 'medium', 'high', 'xhigh'];
function reasoning(levels: string[], defaultLevel = 'medium', contextWindow = 1_050_000): OpenAIApiModelMetadata {
  return { contextWindow, maxTokens: 128_000, canReason: true, supportsAttachments: true,
    inputModalities: ['text', 'image'], supportedReasoningLevels: [...levels], defaultReasoningLevel: defaultLevel };
}
function gpt41(): OpenAIApiModelMetadata {
  return { contextWindow: 1_047_576, maxTokens: 32_768, canReason: false,
    supportsAttachments: true, inputModalities: ['text', 'image'], supportedReasoningLevels: null, defaultReasoningLevel: null };
}

export const OPENAI_API_MODELS: Readonly<Record<string, OpenAIApiModelMetadata>> = {
  'gpt-6.1-sol': reasoning(HIGH),
  'gpt-6.1-terra': reasoning(ALL),
  'gpt-6-astra': reasoning(HIGH),
  'gpt-6-sol': reasoning(ALL),
  'gpt-6-luna': reasoning(ALL),
  'gpt-5.6': reasoning(ALL), // documented alias of gpt-5.6-sol
  'gpt-5.6-sol': { ...reasoning(ALL), applyPatchToolType: 'freeform' },
  'gpt-5.6-terra': { ...reasoning(ALL), applyPatchToolType: 'freeform' },
  'gpt-5.6-luna': { ...reasoning(ALL), applyPatchToolType: 'freeform' },
  'gpt-5.5': reasoning(STANDARD),
  'gpt-5.5-pro': reasoning(['medium', 'high', 'xhigh'], 'high'),
  'gpt-5.4': reasoning(STANDARD, 'none'),
  'gpt-5.4-pro': reasoning(['medium', 'high', 'xhigh']),
  'gpt-5.4-mini': reasoning(STANDARD, 'none', 400_000),
  'gpt-5.4-nano': reasoning(STANDARD, 'none', 400_000),
  'gpt-5.2': reasoning(STANDARD, 'none', 400_000),
  'gpt-5.2-pro': reasoning(['medium', 'high', 'xhigh'], 'medium', 400_000),
  'gpt-5.3-codex': reasoning(['low', 'medium', 'high', 'xhigh'], 'medium', 400_000),
  'gpt-5.2-codex': reasoning(['low', 'medium', 'high', 'xhigh'], 'medium', 400_000),
  'gpt-5.1': reasoning(['none', 'low', 'medium', 'high'], 'none', 400_000),
  'gpt-5': reasoning(['minimal', 'low', 'medium', 'high'], 'medium', 400_000),
  'gpt-5-mini': reasoning(['minimal', 'low', 'medium', 'high'], 'medium', 400_000),
  'gpt-5-nano': reasoning(['minimal', 'low', 'medium', 'high'], 'medium', 400_000),
  'gpt-5-pro': { ...reasoning(['high'], 'high', 400_000), maxTokens: 272_000 },
  'gpt-4.1': gpt41(),
  'gpt-4.1-mini': gpt41(),
  'gpt-4.1-nano': gpt41(),
};

/** Only exact model IDs and their dated snapshots inherit published metadata.
 * A suffix such as -pro, -mini, -chat-latest or -experimental is a distinct model.
 */
export function getOpenAIApiModelMetadata(modelId: string): OpenAIApiModelMetadata | undefined {
  return OPENAI_API_MODELS[modelId] ?? OPENAI_API_MODELS[modelId.replace(/-\d{4}-\d{2}-\d{2}$/, '')];
}

export function isPublicOpenAIApi(kind: string | undefined, baseUrl: string | null | undefined): boolean {
  if (kind !== 'openai') return false;
  if (!baseUrl) return true;
  try { return new URL(baseUrl).hostname === 'api.openai.com'; } catch { return false; }
}
