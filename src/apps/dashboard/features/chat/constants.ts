export const TEXT_LIKE_EXTS = new Set([
  'txt', 'md', 'markdown', 'json', 'yaml', 'yml', 'csv', 'xml', 'html', 'css', 'svg',
  'ts', 'tsx', 'js', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'cpp', 'h', 'hpp',
  'sh', 'bash', 'sql', 'toml', 'ini', 'env', 'log',
]);

export const PROVIDERS = [
  { id: 'anthropic', label: 'Claude', defaultModel: 'claude-sonnet-4-6', accent: 'bg-orange-500' },
  { id: 'zai', label: 'ZAI / GLM', defaultModel: 'glm-5.1', accent: 'bg-info' },
  { id: 'openai', label: 'OpenAI', defaultModel: 'gpt-4o-mini', accent: 'bg-success' },
  { id: 'deepseek', label: 'DeepSeek', defaultModel: 'deepseek-chat', accent: 'bg-purple-500' },
];

export function providerAccent(id: string): string {
  return PROVIDERS.find((p) => p.id === id)?.accent ?? 'bg-primary';
}

export function providerLabel(id: string): string {
  return PROVIDERS.find((p) => p.id === id)?.label ?? id;
}

/** How many visual groups to show initially when opening a session. */
export const INITIAL_PAGE_SIZE = 15;
/** How many more groups to load when user clicks "Load earlier". */
export const LOAD_MORE_SIZE = 20;
