import { describe, expect, it } from 'vitest';
import { normalizeMssqlModule } from '../mssql.js';

describe('mssql module loading', () => {
  it('normalizes the CommonJS namespace returned by native Node ESM', async () => {
    const api = normalizeMssqlModule(await import('mssql'));
    expect(api.ConnectionPool).toBeTypeOf('function');
    expect(api.Transaction).toBeTypeOf('function');
    expect(api.Request).toBeTypeOf('function');
  });

  it('also accepts bundler-synthesized named exports', () => {
    class Constructor {}
    const api = normalizeMssqlModule({
      ConnectionPool: Constructor,
      Transaction: Constructor,
      Request: Constructor,
    });
    expect(api.ConnectionPool).toBe(Constructor);
  });
});
