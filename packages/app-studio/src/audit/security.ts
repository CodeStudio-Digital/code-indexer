/**
 * Auditoria de segurança determinística do workspace App Studio — evidência
 * obrigatória do card verificador (errors) + avisos não-bloqueantes (warnings).
 * Checks baratos regex/fs; o consumidor das mensagens é o agente verificador.
 * Cobre os erros que um app gerado para leigo não
 * pode ter: segredo hardcoded, SQL concatenado (D1 exige .bind()), CORS
 * aberto com auth, rota desprotegida e wrangler.jsonc quebrado.
 */
import { join } from 'node:path';
import type { AppSpec } from '../spec/types.js';
import { parseJsonc } from '../jsonc.js';
import { filesContaining, listFilesRecursive, readIfExists } from '../verification/workspace-checks.js';

export interface SecurityAuditResult {
  errors: string[];
  warnings: string[];
}

const CODE_FILE = /\.(ts|tsx)$/;
/** Atribuição de credencial a literal longo (não pega process.env/c.env). */
const SECRET_LITERAL = /(?:api[_-]?key|secret|token|password|senha)\s*[:=]\s*['"`][A-Za-z0-9_\-./+]{12,}['"`]/i;
// Injeção de SQL — detecção por PALAVRA-CHAVE, não só interpolação colada em
// prepare()/exec(): o padrão mais comum gerado por LLM monta a query numa
// VARIÁVEL (`const q = \`SELECT ... ${x}\`; db.prepare(q)`), que a checagem
// antiga (interpolação direta dentro de prepare) deixava passar.
const SQL_KW = 'select|insert|update|delete|from|where|values|set';
/** Template literal contendo SQL E `${…}` — query montada dinamicamente. */
const SQL_TEMPLATE = new RegExp('`(?=[^`]*\\b(?:' + SQL_KW + ')\\b)[^`]*\\$\\{', 'is');
/** String SQL seguida de `+` — concatenação. */
const SQL_CONCAT = new RegExp("['\"][^'\"]*\\b(?:" + SQL_KW + ")\\b[^'\"]*['\"]\\s*\\+", 'is');
const CORS_WILDCARD = /origin\s*:\s*['"`]\*['"`]/;

interface WranglerD1Binding {
  binding?: string;
  database_id?: string;
}
interface WranglerConfig {
  name?: string;
  main?: string;
  d1_databases?: WranglerD1Binding[];
}

function scanCodeFiles(dir: string, issues: string[], label: string): void {
  for (const rel of listFilesRecursive(dir, CODE_FILE)) {
    const text = readIfExists(join(dir, rel));
    if (!text) continue;
    if (SECRET_LITERAL.test(text)) {
      issues.push(
        `${label}/${rel}: hardcoded credential-looking literal — move it to .dev.vars (dev) / wrangler secret (prod) and read from env.`,
      );
    }
    if (SQL_TEMPLATE.test(text) || SQL_CONCAT.test(text)) {
      issues.push(
        `${label}/${rel}: SQL built by string interpolation/concatenation — D1 queries must use placeholders (?) with .bind(...).`,
      );
    }
  }
}

export function runSecurityAudit(workspaceDir: string, spec: AppSpec | null): SecurityAuditResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // (a) segredos hardcoded + (c) SQL por concatenação — src/ e worker/.
  scanCodeFiles(join(workspaceDir, 'src'), errors, 'src');
  scanCodeFiles(join(workspaceDir, 'worker'), errors, 'worker');

  // (b) .dev.vars precisa estar gitignored.
  const gitignore = readIfExists(join(workspaceDir, '.gitignore')) ?? '';
  if (!gitignore.split(/\r?\n/).some((line) => line.trim() === '.dev.vars')) {
    errors.push('.gitignore does not list `.dev.vars` — local secrets would be committed.');
  }

  // (d) CORS wildcard: erro com auth ligada, aviso sem.
  const corsOffenders = filesContaining(join(workspaceDir, 'worker'), CODE_FILE, CORS_WILDCARD);
  if (corsOffenders.length > 0) {
    const msg = `worker/${corsOffenders.join(', worker/')}: cors({ origin: '*' }) — restrict to the app's own origin.`;
    if (spec?.auth.enabled) errors.push(msg);
    else warnings.push(msg);
  }

  // (e) telas protegidas exigem middleware de auth no worker (receita do
  // template nomeia o guard `requireAuth`).
  if (spec?.auth.enabled && (spec.auth.protected_screen_ids?.length ?? 0) > 0) {
    const guarded = filesContaining(join(workspaceDir, 'worker'), CODE_FILE, /requireAuth/);
    if (guarded.length === 0) {
      errors.push(
        'auth has protected screens but no worker route uses the `requireAuth` middleware — protect the API routes, not only the UI.',
      );
    }
  }

  // (f) wrangler.jsonc parseia e tem o binding DB quando o app usa banco.
  const wranglerRaw = readIfExists(join(workspaceDir, 'wrangler.jsonc'));
  if (!wranglerRaw) {
    errors.push('wrangler.jsonc not found at the workspace root.');
  } else {
    const config = parseJsonc<WranglerConfig>(wranglerRaw);
    if (!config) {
      errors.push('wrangler.jsonc does not parse — fix the JSON (comments are allowed).');
    } else if (spec?.database.required) {
      const db = (config.d1_databases ?? []).find((b) => b.binding === 'DB');
      if (!db) errors.push('wrangler.jsonc is missing the d1_databases binding "DB" the app requires.');
    }
  }

  // Aviso: worker lê env vars mas .dev.vars não existe (dev local quebra).
  const readsEnv = filesContaining(join(workspaceDir, 'worker'), CODE_FILE, /\benv\.[A-Z][A-Z0-9_]+/).length > 0;
  if (readsEnv && readIfExists(join(workspaceDir, '.dev.vars')) === null) {
    warnings.push('worker reads env vars but .dev.vars is missing — local dev may fail.');
  }

  return { errors, warnings };
}
