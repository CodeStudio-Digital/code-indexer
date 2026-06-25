export const TEXT_LIKE_EXTS = new Set([
  'txt', 'md', 'markdown', 'json', 'yaml', 'yml', 'csv', 'xml', 'html', 'css', 'svg',
  'ts', 'tsx', 'js', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'cpp', 'h', 'hpp',
  'sh', 'bash', 'sql', 'toml', 'ini', 'env', 'log',
]);

export const PROVIDERS = [
  { id: 'anthropic', label: 'Claude', defaultModel: 'claude-sonnet-4-6', accent: 'bg-orange-500' },
  { id: 'zai', label: 'ZAI / GLM', defaultModel: 'glm-5.1', accent: 'bg-info' },
  { id: 'openai', label: 'OpenAI', defaultModel: 'gpt-4o-mini', accent: 'bg-success' },
  { id: 'openrouter', label: 'OpenRouter', defaultModel: '~openai/gpt-latest', accent: 'bg-cyan-500' },
  { id: 'deepseek', label: 'DeepSeek', defaultModel: 'deepseek-chat', accent: 'bg-purple-500' },
];

export function providerAccent(id: string): string {
  return PROVIDERS.find((p) => p.id === id)?.accent ?? 'bg-primary';
}

export function providerLabel(id: string): string {
  return PROVIDERS.find((p) => p.id === id)?.label ?? id;
}

/**
 * Deterministic, stable accent colors for global-session virtual workspaces and
 * their linked projects — so the user can tell at a glance which conversation
 * belongs to which set of projects (sidebar group header, chat header, chips).
 * Hue is derived from the row id with golden-angle spacing (well-separated,
 * never collides for adjacent ids); returned as CSS `hsl()` strings for inline
 * `style` (Tailwind can't express an arbitrary runtime hue as a class).
 */
export interface AccentColor {
  /** Solid accent (dots, rings, left borders). */
  solid: string;
  /** Soft translucent fill (chip / header background). */
  soft: string;
  /** Readable on a dark surface (chip text). */
  text: string;
}

function accentFromHue(hue: number): AccentColor {
  const h = ((hue % 360) + 360) % 360;
  return {
    solid: `hsl(${h} 62% 55%)`,
    soft: `hsl(${h} 62% 50% / 0.16)`,
    text: `hsl(${h} 70% 78%)`,
  };
}

/** Color of a virtual workspace (the synthetic union project id). */
export function workspaceColor(syntheticProjectId: number): AccentColor {
  return accentFromHue(Math.round(syntheticProjectId * 137.508));
}

/** Color of a single linked project. Seeded apart from `workspaceColor` so a
 *  project's chip never matches its own workspace dot by coincidence. */
export function projectColor(projectId: number): AccentColor {
  return accentFromHue(Math.round(projectId * 137.508 + 60));
}

/** How many visual groups to show initially when opening a session. */
export const INITIAL_PAGE_SIZE = 30;
/** How many more groups to load when user clicks "Load earlier" or infinite scroll triggers. */
export const LOAD_MORE_SIZE = 40;
