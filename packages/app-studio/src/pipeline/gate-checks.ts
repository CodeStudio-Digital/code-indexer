/**
 * Helpers compartilhados dos gates e do audit — leitura de fs, scan de
 * SQL/imports e spawn de scripts npm do workspace (typecheck/build). Tudo
 * barato e determinístico; os spawns rodam SÓ no submit de etapa (nunca
 * por turno) com timeout duro.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export function readIfExists(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  } catch {
    return null;
  }
}

/** Paths relativos (posix) dos arquivos sob `dir` que casam com o filtro. */
export function listFilesRecursive(dir: string, filter: RegExp): string[] {
  const found: string[] = [];
  const walk = (abs: string, rel: string): void => {
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const childAbs = join(abs, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(childAbs, childRel);
      else if (filter.test(entry.name)) found.push(childRel);
    }
  };
  walk(dir, '');
  return found;
}

/** Migrations SQL do workspace, ordenadas por nome (0001_, 0002_, …). */
export function listSqlMigrations(workspaceDir: string): string[] {
  try {
    return readdirSync(join(workspaceDir, 'migrations'))
      .filter((name) => name.endsWith('.sql'))
      .sort();
  } catch {
    return [];
  }
}

/** Concatenação normalizada de todas as migrations (p/ scans de conteúdo). */
export function readAllMigrationsSql(workspaceDir: string): string {
  return listSqlMigrations(workspaceDir)
    .map((name) => readIfExists(join(workspaceDir, 'migrations', name)) ?? '')
    .join('\n');
}

/** true se o SQL tem ao menos uma linha não-vazia que não seja comentário `--`. */
export function sqlHasStatements(sql: string): boolean {
  return sql
    .split(/\r?\n/)
    .map((l) => l.trim())
    .some((l) => l.length > 0 && !l.startsWith('--'));
}

/** `CREATE TABLE <name>` presente? Tolera IF NOT EXISTS, aspas e backticks. */
export function hasCreateTable(sql: string, tableName: string): boolean {
  const re = new RegExp(
    `create\\s+table\\s+(if\\s+not\\s+exists\\s+)?["'\`\\[]?${tableName}["'\`\\]]?\\b`,
    'i',
  );
  return re.test(sql);
}

/** Arquivos (relativos a `dir`) cujo conteúdo casa com `needle`. */
export function filesContaining(dir: string, fileFilter: RegExp, needle: RegExp): string[] {
  return listFilesRecursive(dir, fileFilter).filter((rel) => {
    const text = readIfExists(join(dir, rel));
    return text !== null && needle.test(text);
  });
}

export interface WorkspaceCommandResult {
  ok: boolean;
  code: number | null;
  /** Cauda do stdout+stderr (o consumidor é o agente — só o fim importa). */
  output: string;
}

const OUTPUT_TAIL_CHARS = 4000;

/**
 * Roda um script npm do workspace (`npm run <script>`) com timeout duro.
 * `shell: true` resolve npm.cmd no Windows.
 */
export function runWorkspaceScript(
  workspaceDir: string,
  script: string,
  timeoutMs = 120_000,
): Promise<WorkspaceCommandResult> {
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    const child = spawn('npm', ['run', script], {
      cwd: workspaceDir,
      shell: true,
      env: { ...process.env, NO_COLOR: '1' },
    });
    const finish = (ok: boolean, code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, code, output: output.slice(-OUTPUT_TAIL_CHARS) });
    };
    const timer = setTimeout(() => {
      output += `\n[gate] npm run ${script} timed out after ${timeoutMs}ms`;
      try {
        child.kill('SIGKILL');
      } catch {
        /* já morreu */
      }
      finish(false, null);
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.on('error', (err) => {
      output += `\n[gate] spawn error: ${err.message}`;
      finish(false, null);
    });
    child.on('close', (code) => finish(code === 0, code));
  });
}

/** Última(s) linha(s) úteis de um output de build p/ compor uma issue curta. */
export function summarizeOutput(output: string, maxChars = 700): string {
  const trimmed = output.trim();
  return trimmed.length <= maxChars ? trimmed : `…${trimmed.slice(-maxChars)}`;
}
