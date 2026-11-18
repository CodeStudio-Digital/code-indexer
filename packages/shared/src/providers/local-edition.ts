export const LOCAL_PROVIDER_KINDS = ['copilot', 'bedrock', 'openai', 'anthropic'] as const;
export type LocalProviderKind = (typeof LOCAL_PROVIDER_KINDS)[number];

const retiredProviders = new Set([
  'chatgpt', 'claude-code', 'cloudflare', 'codex', 'deepseek', 'fugu',
  'gemini', 'google', 'google-oauth', 'kimi-code', 'mistral', 'moonshot', 'openrouter', 'zai',
]);

export function isLocalProviderKind(kind: string): kind is LocalProviderKind {
  return LOCAL_PROVIDER_KINDS.some((value) => value === kind);
}

export function isRetiredProviderId(id: string): boolean {
  return retiredProviders.has(id.toLowerCase());
}

export function isRetiredPlugin(name: string): boolean {
  const normalized = name.toLowerCase();
  if (normalized === 'cloudflare' || normalized === 'podman') return true;
  if (!normalized.startsWith('provider-')) return false;
  const kind = normalized.slice('provider-'.length);
  return isLocalProviderKind(kind) || isRetiredProviderId(kind);
}
