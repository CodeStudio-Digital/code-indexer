import type DatabaseConstructor from 'better-sqlite3';

type DB = InstanceType<typeof DatabaseConstructor>;

export interface Migration {
  version: number;
  name: string;
  up: (db: DB) => void;
  /**
   * Opt-out do auto-wrap em `db.transaction()`. Necessário para
   * migrations que precisam toggar `PRAGMA foreign_keys = OFF` — esse
   * pragma é silenciosamente ignorado dentro de uma transação ativa
   * (`SQLITE_LOCKED` ao tentar DROP de tabelas com FK).
   *
   * Quando true, a migration é responsável por:
   *   1. PRAGMA foreign_keys = OFF (se precisar)
   *   2. Sua própria transação (BEGIN/COMMIT) ou `db.transaction()` interno
   *   3. PRAGMA foreign_key_check para verificar integridade
   *   4. PRAGMA foreign_keys = ON (restaurar)
   *
   * O runner ainda registra a versão em `schema_version` num INSERT
   * autônomo APÓS `up()` retornar com sucesso — então uma migration
   * que falha no meio precisa restaurar o estado ela mesma (ROLLBACK
   * + foreign_keys=ON) antes de propagar o erro.
   *
   * Usar com cautela: o ponto inteiro do wrap em transação é
   * atomicidade. Só dispense quando a operação não cabe (recreate-table
   * com FK, multi-step que precisa de PRAGMA fora-de-tx, etc).
   */
  outsideTransaction?: boolean;
}
