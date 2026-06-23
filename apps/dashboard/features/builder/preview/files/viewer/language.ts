/**
 * Maps a file path to a Shiki language id. Returns `'text'` when the
 * extension is unknown — Shiki accepts it and just disables grammar
 * parsing, keeping the viewer robust for odd file types.
 */
const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'jsonc',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  md: 'markdown',
  mdx: 'mdx',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  sh: 'shellscript',
  bash: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  sql: 'sql',
  xml: 'xml',
  svg: 'xml',
  dockerfile: 'docker',
  makefile: 'makefile',
  lua: 'lua',
  swift: 'swift',
  vue: 'vue',
  svelte: 'svelte',
  graphql: 'graphql',
  gql: 'graphql',
  ini: 'ini',
  env: 'dotenv',
  diff: 'diff',
  patch: 'diff',
  prisma: 'prisma',
};

const BASENAME_TO_LANG: Record<string, string> = {
  Dockerfile: 'docker',
  Makefile: 'makefile',
  '.gitignore': 'ini',
  '.env': 'dotenv',
};

export function langFromPath(path: string): string {
  const base = path.split('/').pop() ?? path;
  if (BASENAME_TO_LANG[base]) return BASENAME_TO_LANG[base];
  const dot = base.lastIndexOf('.');
  if (dot < 0) return 'text';
  const ext = base.slice(dot + 1).toLowerCase();
  return EXT_TO_LANG[ext] ?? 'text';
}

export function isMarkdown(path: string): boolean {
  const l = langFromPath(path);
  return l === 'markdown' || l === 'mdx';
}
