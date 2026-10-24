

import { createRequire } from 'node:module';
import type DatabaseConstructor from 'better-sqlite3';
import type { DB } from './semantic-store-types.js';
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof DatabaseConstructor;
export class SemanticConnection {
  readonly db: DB;
  private readonly ownsConnection: boolean;

  constructor(
    dbPathOrInstance: string | DB,
    options: { busyTimeoutMs?: number } = {},
  ) {
    if (typeof dbPathOrInstance === 'string') {
      this.db = new Database(dbPathOrInstance);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');
      this.ownsConnection = true;
    } else {
      this.db = dbPathOrInstance;
      this.ownsConnection = false;
    }
    if (options.busyTimeoutMs != null) {
      const timeout = Math.max(0, Math.trunc(options.busyTimeoutMs));
      this.db.pragma(`busy_timeout = ${timeout}`);
    }
  }

  /**
   * Run a small main-thread mutation with a connection-local busy ceiling.
   * SQLite's busy timeout is otherwise 5s, which is appropriate in workers but
   * can freeze Electron-main when a structural writer owns the central DB.
   * The previous value is restored even when SQLite throws.
   */
  withBusyTimeout<T>(busyTimeoutMs: number, operation: () => T): T {
    const timeout = Math.max(0, Math.trunc(busyTimeoutMs));
    const previous = Number(this.db.pragma('busy_timeout', { simple: true }));
    if (previous === timeout) return operation();
    this.db.pragma(`busy_timeout = ${timeout}`);
    try {
      return operation();
    } finally {
      this.db.pragma(`busy_timeout = ${previous}`);
    }
  }

  close(): void {
    if (this.ownsConnection) this.db.close();
  }
}
