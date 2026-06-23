/** DbExecutor implemented over Cloudflare D1. Parameterized statements only —
 *  the SAME repositories run on this in prod and on a better-sqlite3 executor in
 *  unit tests. Mirrors `worker-market/src/catalog.ts` binding style. */
import type { DbExecutor, SqlStatement } from '@cloudstudio/cloud-kernel';

export function createD1Executor(db: D1Database): DbExecutor {
  const prep = (sql: string, params?: readonly unknown[]) =>
    params && params.length ? db.prepare(sql).bind(...(params as unknown[])) : db.prepare(sql);

  return {
    async first<T>(sql: string, params?: readonly unknown[]) {
      return (await prep(sql, params).first<T>()) ?? null;
    },
    async all<T>(sql: string, params?: readonly unknown[]) {
      const res = await prep(sql, params).all<T>();
      return res.results ?? [];
    },
    async run(sql: string, params?: readonly unknown[]) {
      const res = await prep(sql, params).run();
      return { rowsAffected: res.meta?.changes ?? 0 };
    },
    async batch(statements: readonly SqlStatement[]) {
      await db.batch(statements.map((s) => prep(s.sql, s.params)));
    },
  };
}
