/**
 * Arquivos do Worker (API Hono) + banco do template `cf-fullstack`. Com
 * `assets.run_worker_first: ["/api/*"]` o Worker só vê /api — todo o
 * resto é servido como asset estático (SPA fallback pelo
 * `not_found_handling`). `migrations/` nasce VAZIA de .sql: o agente cria
 * `0001_init.sql` a partir das entities da spec na etapa database.
 */
import type { AppTemplateInput, AppWorkspaceFile } from './types.js';

const WORKER_ENV_TS = `/** Bindings do Worker (espelha wrangler.jsonc). */
export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
}
`;

const WORKER_INDEX_TS = `import { Hono } from 'hono';
import { api } from './api';
import type { Env } from './env';

const app = new Hono<{ Bindings: Env }>();
app.route('/api', api);

export default app;
`;

const WORKER_API_TS = `import { Hono } from 'hono';
import type { Env } from './env';

export const api = new Hono<{ Bindings: Env }>();

/** Health check — a launch chain confere este endpoint após o deploy. */
api.get('/health', (c) => c.json({ ok: true }));

// Exemplo de leitura no D1 (substitua na etapa backend — SEMPRE .bind()):
// api.get('/pedidos', async (c) => {
//   const { results } = await c.env.DB
//     .prepare('SELECT * FROM pedidos WHERE id = ?')
//     .bind(1)
//     .all();
//   return c.json(results);
// });
`;

const MIGRATIONS_README = `# migrations/

Migrations SQL do banco D1, aplicadas em ordem de nome
(\`0001_init.sql\`, \`0002_...sql\`).

Regras:
- O schema SÓ muda por uma NOVA migration — nunca edite uma migration
  já aplicada (local ou remoto).
- A etapa database cria \`0001_init.sql\` a partir das entities da spec.
- Aplique localmente com a tool \`app_provision_db\` (ou
  \`npm run db:migrate:local\`).
`;

const SEED_SQL = `-- Seed de dados de exemplo do preview local (etapa database).
-- Escreva INSERTs realistas para as tabelas da spec — o painel
-- "Seus dados" e as telas do preview mostram estas linhas.
`;

export function buildWorkerFiles(_i: AppTemplateInput): AppWorkspaceFile[] {
  return [
    { path: 'worker/env.ts', contents: WORKER_ENV_TS },
    { path: 'worker/index.ts', contents: WORKER_INDEX_TS },
    { path: 'worker/api.ts', contents: WORKER_API_TS },
    { path: 'migrations/README.md', contents: MIGRATIONS_README },
    { path: 'seeds/seed.sql', contents: SEED_SQL },
  ];
}
