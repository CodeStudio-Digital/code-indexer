export const CODEX_APP_SERVER_DISABLED_FEATURES = Object.freeze([
  'shell_tool',
  'browser_use',
  'browser_use_external',
  'computer_use',
  'in_app_browser',
  'apps',
  'plugins',
  'multi_agent',
  'image_generation',
  'hooks',
  'skill_search',
  'tool_suggest',
] as const);

/** Minimal candidate argv. CodeStudio policy is resolved before this boundary. */
export function codexAppServerArguments(): readonly string[] {
  return Object.freeze([
    'app-server',
    '--stdio',
    ...CODEX_APP_SERVER_DISABLED_FEATURES.flatMap((feature) => ['--disable', feature]),
    '-c',
    'mcp_servers={}',
  ]);
}
