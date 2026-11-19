/** Capabilities verified for the native Codex Responses models we expose.
 * Keep unknown/custom backends opt-in rather than guessing from a GPT prefix.
 */
const CODEX_RESPONSES_MODELS = new Set([
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-6-astra',
  'gpt-6-sol',
  'gpt-6-luna',
  'gpt-6.1-sol',
  'gpt-6.1-terra',
]);

export function supportsCodexSessionCapabilities(model: string): boolean {
  return CODEX_RESPONSES_MODELS.has(model.toLowerCase());
}
