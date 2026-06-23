/**
 * DS Studio — react-ts workspace skeleton (deterministic string templates,
 * no CLI). Estrutura: npm workspaces com `app/` (galeria Vite, stamped) e
 * `pkg/` (a biblioteca — a única coisa publicada). Os arquivos da galeria
 * em si (App/registry/TokensPage) vivem em `templates-react-gallery.ts`.
 *
 * Dependências NÃO são pinadas aqui: o scaffold roda `npm install
 * --workspace app <deps>` depois de escrever o skeleton, então o npm
 * resolve as versões correntes — mesmo comportamento do fluxo builder
 * existente (create-vite + install de BUILDER_DEPS).
 */
import type { DsTemplateInput } from './types.js';

export function rootPackageJson(input: DsTemplateInput): string {
  return `${JSON.stringify(
    {
      name: input.slug,
      private: true,
      workspaces: ['app', 'pkg'],
      scripts: {
        // O dashboard sobe o preview com `npm run dev` na raiz
        // (useProjectDevServer) — precisa servir a galeria na porta pinada.
        dev: 'npm run dev --workspace app',
      },
    },
    null,
    2,
  )}\n`;
}

export function pkgPackageJson(input: DsTemplateInput): string {
  return `${JSON.stringify(
    {
      name: input.packageName,
      version: '0.0.0',
      type: 'module',
      main: './src/index.ts',
      types: './src/index.ts',
      exports: {
        '.': './src/index.ts',
        './tokens.css': './src/tokens.css',
        './*': './src/*',
      },
      files: ['src', 'docs.md', 'README.md'],
      sideEffects: ['**/*.css'],
      peerDependencies: {
        react: '>=18',
        'react-dom': '>=18',
      },
    },
    null,
    2,
  )}\n`;
}

/** Tokens shadcn-compatíveis (canais HSL) — fonte única de verdade do tema. */
export const PKG_TOKENS_CSS = String.raw`/*
 * Design tokens — the single source of truth for this design system.
 * Components and the gallery consume these via Tailwind (hsl(var(--token)))
 * or directly with var(--token). Change THESE values to retheme everything.
 */
:root {
  --background: 0 0% 100%;
  --foreground: 222.2 84% 4.9%;
  --card: 0 0% 100%;
  --card-foreground: 222.2 84% 4.9%;
  --popover: 0 0% 100%;
  --popover-foreground: 222.2 84% 4.9%;
  --primary: 222.2 47.4% 11.2%;
  --primary-foreground: 210 40% 98%;
  --secondary: 210 40% 96.1%;
  --secondary-foreground: 222.2 47.4% 11.2%;
  --muted: 210 40% 96.1%;
  --muted-foreground: 215.4 16.3% 46.9%;
  --accent: 210 40% 96.1%;
  --accent-foreground: 222.2 47.4% 11.2%;
  --destructive: 0 84.2% 60.2%;
  --destructive-foreground: 210 40% 98%;
  --border: 214.3 31.8% 91.4%;
  --input: 214.3 31.8% 91.4%;
  --ring: 222.2 84% 4.9%;
  --radius: 0.5rem;
}
.dark {
  --background: 222.2 84% 4.9%;
  --foreground: 210 40% 98%;
  --card: 222.2 84% 4.9%;
  --card-foreground: 210 40% 98%;
  --popover: 222.2 84% 4.9%;
  --popover-foreground: 210 40% 98%;
  --primary: 210 40% 98%;
  --primary-foreground: 222.2 47.4% 11.2%;
  --secondary: 217.2 32.6% 17.5%;
  --secondary-foreground: 210 40% 98%;
  --muted: 217.2 32.6% 17.5%;
  --muted-foreground: 215 20.2% 65.1%;
  --accent: 217.2 32.6% 17.5%;
  --accent-foreground: 210 40% 98%;
  --destructive: 0 62.8% 30.6%;
  --destructive-foreground: 210 40% 98%;
  --border: 217.2 32.6% 17.5%;
  --input: 217.2 32.6% 17.5%;
  --ring: 212.7 26.8% 83.9%;
}
`;

export const PKG_INDEX_TS = String.raw`/**
 * Public surface of the design system. Export every approved component:
 *
 *   export { Button } from './components/Button';
 */
export {};
`;

export function pkgDocsMd(input: DsTemplateInput): string {
  return [
    `# ${input.packageName}`,
    '',
    'Design system built with the DS Studio. Tokens-first: every color,',
    'radius and spacing lives in `src/tokens.css`.',
    '',
    '## Install',
    '',
    '```',
    `npm install ${input.packageName} --registry <local-registry-url>`,
    '```',
    '',
    'Import the tokens once at your app root:',
    '',
    '```ts',
    `import '${input.packageName}/tokens.css';`,
    '```',
    '',
    '## Components',
    '',
    '_None registered yet — they are documented here as they are approved._',
    '',
  ].join('\n');
}

export function appPackageJson(): string {
  return `${JSON.stringify(
    {
      name: 'app',
      private: true,
      type: 'module',
      scripts: { dev: 'vite', build: 'vite build' },
    },
    null,
    2,
  )}\n`;
}

export const APP_TSCONFIG_JSON = `${JSON.stringify(
  {
    compilerOptions: {
      target: 'ES2022',
      useDefineForClassFields: true,
      lib: ['ES2022', 'DOM', 'DOM.Iterable'],
      module: 'ESNext',
      moduleResolution: 'bundler',
      jsx: 'react-jsx',
      strict: true,
      skipLibCheck: true,
      noEmit: true,
      isolatedModules: true,
      baseUrl: '.',
      paths: {
        '@/*': ['./src/*'],
        '@ds': ['../pkg/src/index.ts'],
        '@ds/*': ['../pkg/src/*'],
      },
    },
    include: ['src', '../pkg/src'],
  },
  null,
  2,
)}\n`;

export function appIndexHtml(input: DsTemplateInput): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '  <head>',
    '    <meta charset="UTF-8" />',
    '    <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
    `    <title>${input.packageName} — gallery</title>`,
    '  </head>',
    '  <body>',
    '    <div id="root"></div>',
    '    <script type="module" src="/src/main.tsx"></script>',
    '  </body>',
    '</html>',
    '',
  ].join('\n');
}

export function rootGitignore(): string {
  return ['node_modules/', 'dist/', '*.tgz', '*.local', ''].join('\n');
}

export function rootReadme(input: DsTemplateInput): string {
  return [
    `# ${input.slug} — Design System workspace`,
    '',
    `- \`pkg/\` — the library (\`${input.packageName}\`). The only thing published.`,
    '- `app/` — live gallery served by the DS Studio preview (hot-reloads on pkg edits).',
    '- `import/` — optional raw reference material (read-only).',
    '',
    'Managed by the CodeStudio DS Studio — dev server: `npm run dev` (pinned port).',
    '',
  ].join('\n');
}
