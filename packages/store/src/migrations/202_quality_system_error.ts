/**
 * Migration 202 — separa falha de INFRA do classifier de julgamento de
 * CONTEÚDO em `quality_classifications`.
 *
 * O verdict 'error' era sobrecarregado: o LLM julgando a saída do agente
 * como quebrada (classifier funcionando) E o classifier falhando (sem
 * binding, timeout, resposta unparseable, rate-limit). Telemetria jul/2026:
 * 31% de TODOS os veredictos eram 'error' e ~90% desses eram falha de infra
 * ("[failover] [parse] unparseable response", "[timeout] This operation was
 * aborted") — a aba Qualidade media a flakiness do binding, não o agente.
 *
 * O flag `systemError` já existia em memória (ClassificationVerdict) e era
 * DESCARTADO no insert. Esta coluna persiste a separação; consumidores
 * (distribuição de veredictos, effectiveness, enforcement) filtram
 * `system_error = 0` para enxergar só julgamentos reais.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function tableExists(db: DB, table: string): boolean {
  return !!db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(table);
}

function addColumnIfMissing(db: DB, table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export const qualitySystemError202: Migration = {
  version: 202,
  name: 'quality_system_error',
  up: (db: DB): void => {
    // `quality_classifications` ∈ CENTRAL_DROP_TABLES — os DBs por-projeto
    // rodam esta linhagem central mas TRIMam a tabela (project-db/trim/
    // drop-list.ts:49). Sem o guard, o ALTER estoura `no such table` e derruba
    // o boot do índice do projeto. Espelha o helper das migs 175/178.
    if (!tableExists(db, 'quality_classifications')) return;
    addColumnIfMissing(db, 'quality_classifications', 'system_error', 'INTEGER NOT NULL DEFAULT 0');
    // Backfill histórico best-effort: as falhas de sistema carregam marcadores
    // determinísticos no reason (prefixos emitidos por llm-classifier.ts).
    db.exec(`
      UPDATE quality_classifications
      SET system_error = 1
      WHERE verdict = 'error' AND (
        reason LIKE '[no_binding]%' OR
        reason LIKE '[parse]%' OR
        reason LIKE '[timeout]%' OR
        reason LIKE '[rate_limit]%' OR
        reason LIKE '[other]%' OR
        reason LIKE '[failover] [parse]%' OR
        reason LIKE '[failover] [timeout]%' OR
        reason LIKE '[failover] [rate_limit]%' OR
        reason LIKE '[failover] [other]%' OR
        reason LIKE 'pipeline rejection:%'
      )
    `);
  },
};
