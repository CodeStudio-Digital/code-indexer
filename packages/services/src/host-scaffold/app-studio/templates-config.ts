/**
 * Arquivos de configuração do template `cf-fullstack` — package.json,
 * wrangler.jsonc (header gerenciado), tsconfigs solution-style (app DOM +
 * worker workers-types), .gitignore e .dev.vars.
 *
 * Arquitetura oficial Cloudflare: `@cloudflare/vite-plugin` roda a SPA
 * (HMR) e o Worker (workerd/miniflare) no MESMO dev server/porta; D1 é
 * emulado localmente com estado em `.wrangler/state` — compartilhado com
 * `wrangler d1 migrations apply --local` (mesmo default de persistência).
 */
import type { AppTemplateInput, AppWorkspaceFile } from './types.js';
import { APP_STUDIO_SCAFFOLD_PROFILE } from './stack-profile.js';

function packageJson(i: AppTemplateInput): string {
  return `${JSON.stringify(
    {
      name: i.slug,
      private: true,
      type: 'module',
      scripts: {
        dev: 'vite dev',
        build: 'tsc -b && vite build',
        typecheck: 'tsc -b',
        test: 'npm run test:worker && npm run test:e2e',
        'test:worker': 'vitest run --config vitest.config.ts --passWithNoTests',
        'test:e2e': 'playwright test --pass-with-no-tests',
        preview: 'vite preview',
        deploy: 'npm run build && wrangler deploy',
        'db:migrate:local': 'wrangler d1 migrations apply DB --local',
        'db:migrate:remote': 'wrangler d1 migrations apply DB --remote',
      },
    },
    null,
    2,
  )}\n`;
}

function wranglerJsonc(i: AppTemplateInput): string {
  return `{
  // ── Managed by CodeStudio App Studio ──────────────────────────────
  // You may ADD "vars" and extra bindings below, but NEVER change:
  //   name, main, assets, or d1_databases[0].database_id
  // (the launch chain writes the real database_id at publish time).
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "${i.appSlug}",
  "main": "worker/index.ts",
  "compatibility_date": "${APP_STUDIO_SCAFFOLD_PROFILE.compatibilityDate}",
  "compatibility_flags": ["nodejs_compat"],
  "assets": {
    "not_found_handling": "single-page-application",
    "binding": "ASSETS",
    "run_worker_first": ["/api/*"]
  },
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "${i.appSlug}-db",
      "database_id": "APP-STUDIO-PLACEHOLDER",
      "migrations_dir": "migrations"
    }
  ],
  "observability": { "enabled": true }
}
`;
}

const TSCONFIG_ROOT = `{
  "files": [],
  "references": [{ "path": "./tsconfig.app.json" }, { "path": "./tsconfig.worker.json" }]
}
`;

const TSCONFIG_APP = `{
  "compilerOptions": {
    "tsBuildInfoFile": "./node_modules/.tmp/tsconfig.app.tsbuildinfo",
    "target": "ES2022",
    "useDefineForClassFields": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "moduleDetection": "force",
    "verbatimModuleSyntax": true,
    "types": ["vite/client"],
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "skipLibCheck": true,
    "noEmit": true,
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["src"]
}
`;

const TSCONFIG_WORKER = `{
  "compilerOptions": {
    "tsBuildInfoFile": "./node_modules/.tmp/tsconfig.worker.tsbuildinfo",
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "moduleDetection": "force",
    "verbatimModuleSyntax": true,
    "types": ["@cloudflare/workers-types"],
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["worker"]
}
`;

const GITIGNORE = `node_modules
dist
.wrangler
.dev.vars
.app-studio
*.local
npm-debug.log*
`;

const DEV_VARS = `# Local-only secrets (NEVER committed — .gitignore lists this file).
# The backend stage adds real entries when the app needs them, e.g.:
# BETTER_AUTH_SECRET=dev-only-change-me
`;

function indexHtml(i: AppTemplateInput): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${i.appName}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`;
}

function vitestConfig(): string {
  return `import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: { TEST_MIGRATIONS: await readD1Migrations('./migrations') },
      },
    })),
  ],
  test: { include: ['tests/worker/**/*.test.ts'] },
});
`;
}

function playwrightConfig(i: AppTemplateInput): string {
  const url = `http://127.0.0.1:${i.port}`;
  return `import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  use: { baseURL: process.env.APP_URL ?? '${url}', trace: 'retain-on-failure' },
  webServer: {
    command: 'npm run dev',
    url: process.env.APP_URL ?? '${url}',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
`;
}

export function buildConfigFiles(i: AppTemplateInput): AppWorkspaceFile[] {
  return [
    { path: 'package.json', contents: packageJson(i) },
    { path: 'wrangler.jsonc', contents: wranglerJsonc(i) },
    { path: 'tsconfig.json', contents: TSCONFIG_ROOT },
    { path: 'tsconfig.app.json', contents: TSCONFIG_APP },
    { path: 'tsconfig.worker.json', contents: TSCONFIG_WORKER },
    { path: '.gitignore', contents: GITIGNORE },
    { path: '.dev.vars', contents: DEV_VARS },
    { path: 'index.html', contents: indexHtml(i) },
    { path: 'vitest.config.ts', contents: vitestConfig() },
    { path: 'playwright.config.ts', contents: playwrightConfig(i) },
    { path: 'tests/worker/.gitkeep', contents: '' },
    { path: 'tests/e2e/.gitkeep', contents: '' },
  ];
}
