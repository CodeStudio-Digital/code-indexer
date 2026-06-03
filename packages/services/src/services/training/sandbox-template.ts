/**
 * Base file templates for the validator sandbox (a real shadcn + Vite project).
 * Written into `{dataDir}/training/sandbox/<profile>/` at provision time, then
 * `npm install` + `shadcn add --all` fill in node_modules + components. NOTHING
 * here is committed as an installed project — only these text blueprints.
 */
export const SANDBOX_DEPS = {
  dependencies: {
    react: '^18.3.1',
    'react-dom': '^18.3.1',
    'class-variance-authority': '^0.7.1',
    clsx: '^2.1.1',
    'tailwind-merge': '^2.6.0',
    'tailwindcss-animate': '^1.0.7',
    'lucide-react': '^0.460.0',
    recharts: '^2.13.0',
    'react-hook-form': '^7.54.0',
    '@hookform/resolvers': '^3.9.1',
    zod: '^3.24.1',
    '@tanstack/react-table': '^8.20.5',
    'date-fns': '^4.1.0',
  },
  devDependencies: {
    '@types/react': '^18.3.12',
    '@types/react-dom': '^18.3.1',
    '@vitejs/plugin-react': '^4.3.4',
    autoprefixer: '^10.4.20',
    postcss: '^8.4.49',
    tailwindcss: '^3.4.17',
    typescript: '^5.6.3',
    vite: '^5.4.11',
  },
} as const;

const TSCONFIG = {
  compilerOptions: {
    target: 'ES2020', useDefineForClassFields: true,
    lib: ['ES2020', 'DOM', 'DOM.Iterable'], module: 'ESNext', skipLibCheck: true,
    moduleResolution: 'bundler', allowImportingTsExtensions: true, resolveJsonModule: true,
    isolatedModules: true, noEmit: true, jsx: 'react-jsx', strict: true,
    noUnusedLocals: false, noUnusedParameters: false, baseUrl: '.',
    paths: { '@/*': ['./src/*'] },
  },
  include: ['src'],
};

const COMPONENTS_JSON = {
  $schema: 'https://ui.shadcn.com/schema.json', style: 'default', rsc: false, tsx: true,
  tailwind: { config: 'tailwind.config.js', css: 'src/index.css', baseColor: 'slate', cssVariables: true },
  aliases: { components: '@/components', utils: '@/lib/utils', ui: '@/components/ui' },
};

const INDEX_CSS = `@tailwind base;
@tailwind components;
@tailwind utilities;
@layer base {
  :root {
    --background:0 0% 100%; --foreground:222.2 84% 4.9%;
    --card:0 0% 100%; --card-foreground:222.2 84% 4.9%;
    --popover:0 0% 100%; --popover-foreground:222.2 84% 4.9%;
    --primary:222.2 47.4% 11.2%; --primary-foreground:210 40% 98%;
    --secondary:210 40% 96.1%; --secondary-foreground:222.2 47.4% 11.2%;
    --muted:210 40% 96.1%; --muted-foreground:215.4 16.3% 46.9%;
    --accent:210 40% 96.1%; --accent-foreground:222.2 47.4% 11.2%;
    --destructive:0 84.2% 60.2%; --destructive-foreground:210 40% 98%;
    --border:214.3 31.8% 91.4%; --input:214.3 31.8% 91.4%; --ring:222.2 84% 4.9%;
    --radius:0.5rem;
  }
  .dark {
    --background:222.2 84% 4.9%; --foreground:210 40% 98%;
    --card:222.2 84% 4.9%; --card-foreground:210 40% 98%;
    --popover:222.2 84% 4.9%; --popover-foreground:210 40% 98%;
    --primary:210 40% 98%; --primary-foreground:222.2 47.4% 11.2%;
    --secondary:217.2 32.6% 17.5%; --secondary-foreground:210 40% 98%;
    --muted:217.2 32.6% 17.5%; --muted-foreground:215 20.2% 65.1%;
    --accent:217.2 32.6% 17.5%; --accent-foreground:210 40% 98%;
    --destructive:0 62.8% 30.6%; --destructive-foreground:210 40% 98%;
    --border:217.2 32.6% 17.5%; --input:217.2 32.6% 17.5%; --ring:212.7 26.8% 83.9%;
  }
  * { border-color: hsl(var(--border)); }
  body { background: hsl(var(--background)); color: hsl(var(--foreground)); }
}`;

const TAILWIND_CONFIG = `/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: { extend: {
    colors: {
      border: 'hsl(var(--border))', input: 'hsl(var(--input))', ring: 'hsl(var(--ring))',
      background: 'hsl(var(--background))', foreground: 'hsl(var(--foreground))',
      primary: { DEFAULT: 'hsl(var(--primary))', foreground: 'hsl(var(--primary-foreground))' },
      secondary: { DEFAULT: 'hsl(var(--secondary))', foreground: 'hsl(var(--secondary-foreground))' },
      destructive: { DEFAULT: 'hsl(var(--destructive))', foreground: 'hsl(var(--destructive-foreground))' },
      muted: { DEFAULT: 'hsl(var(--muted))', foreground: 'hsl(var(--muted-foreground))' },
      accent: { DEFAULT: 'hsl(var(--accent))', foreground: 'hsl(var(--accent-foreground))' },
      popover: { DEFAULT: 'hsl(var(--popover))', foreground: 'hsl(var(--popover-foreground))' },
      card: { DEFAULT: 'hsl(var(--card))', foreground: 'hsl(var(--card-foreground))' },
    },
    borderRadius: { lg: 'var(--radius)', md: 'calc(var(--radius) - 2px)', sm: 'calc(var(--radius) - 4px)' },
  } },
  plugins: [require('tailwindcss-animate')],
};`;

/** relativePath -> content for the non-package base files. */
export function baseFiles(): Record<string, string> {
  return {
    'tsconfig.json': JSON.stringify(TSCONFIG, null, 2),
    'components.json': JSON.stringify(COMPONENTS_JSON, null, 2),
    'tailwind.config.js': TAILWIND_CONFIG,
    'postcss.config.js': "export default { plugins: { tailwindcss: {}, autoprefixer: {} } };\n",
    'vite.config.ts':
      "import { fileURLToPath, URL } from 'node:url';\nimport react from '@vitejs/plugin-react';\nimport { defineConfig } from 'vite';\nexport default defineConfig({ plugins: [react()], resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } } });\n",
    'index.html':
      '<!doctype html><html lang="en"><head><meta charset="UTF-8"/><title>sandbox</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>\n',
    'src/index.css': INDEX_CSS,
    'src/lib/utils.ts':
      "import { clsx, type ClassValue } from 'clsx';\nimport { twMerge } from 'tailwind-merge';\nexport function cn(...inputs: ClassValue[]) { return twMerge(clsx(inputs)); }\n",
    'src/main.tsx':
      "import { StrictMode } from 'react';\nimport { createRoot } from 'react-dom/client';\nimport './index.css';\nimport { App } from './App';\ncreateRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);\n",
    'src/App.tsx':
      "export function App() { return <div>sandbox</div>; }\n",
  };
}

/** package.json content (deps injected). */
export function packageJson(): string {
  return JSON.stringify({
    name: 'mcp-train-sandbox', private: true, version: '0.0.0', type: 'module',
    scripts: { typecheck: 'tsc --noEmit', build: 'vite build' },
    dependencies: SANDBOX_DEPS.dependencies, devDependencies: SANDBOX_DEPS.devDependencies,
  }, null, 2);
}
