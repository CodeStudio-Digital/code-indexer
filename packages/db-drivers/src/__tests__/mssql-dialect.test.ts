import { describe, it, expect } from 'vitest';
import { buildDdl } from '../ddl/build.js';
import { buildDml } from '../sql/dml.js';
import { quoteIdent, quoteRelation, placeholder } from '../sql/identifiers.js';
import { formatMssqlType } from '../mssql.js';

/**
 * Pure SQL Server dialect tests — verify the T-SQL strings without a live server
 * (the driver itself still needs a real instance to validate end-to-end).
 */
describe('mssql identifiers', () => {
  it('quotes with [brackets] and binds @pN', () => {
    expect(quoteIdent('mssql', 'my col]')).toBe('[my col]]]');
    expect(quoteRelation('mssql', 'dbo', 'Users')).toBe('[dbo].[Users]');
    expect(placeholder('mssql', 0)).toBe('@p0');
    expect(placeholder('mssql', 2)).toBe('@p2');
  });
});

describe('mssql type introspection', () => {
  it('preserves character, max and Unicode lengths', () => {
    expect(formatMssqlType('varchar', 120, 0, 0)).toBe('varchar(120)');
    expect(formatMssqlType('nvarchar', 510, 0, 0)).toBe('nvarchar(255)');
    expect(formatMssqlType('varbinary', -1, 0, 0)).toBe('varbinary(max)');
  });

  it('preserves precision and scale where T-SQL requires them', () => {
    expect(formatMssqlType('decimal', 18, 12, 4)).toBe('decimal(12,4)');
    expect(formatMssqlType('datetime2', 8, 0, 3)).toBe('datetime2(3)');
    expect(formatMssqlType('int', 4, 10, 0)).toBe('int');
  });
});

describe('mssql DML', () => {
  it('UPDATE is PK-scoped with @p placeholders', () => {
    const built = buildDml('mssql', { op: 'update', schema: 'dbo', table: 'Users', pk: { id: 1 }, values: { name: 'Ada' } });
    expect(built.sql).toContain('UPDATE [dbo].[Users] SET [name] = @p0');
    expect(built.sql).toContain('WHERE [id] = @p1');
    expect(built.params).toEqual(['Ada', 1]);
  });
});

describe('mssql DDL', () => {
  it('CREATE renders IDENTITY for auto-increment + table PK constraint', () => {
    const [sql] = buildDdl('mssql', 'create', {
      create: { schema: 'dbo', table: 'Users', columns: [
        { name: 'id', type: 'INT', primaryKey: true, autoIncrement: true, nullable: false },
        { name: 'email', type: 'NVARCHAR(255)' },
      ] },
    });
    expect(sql).toContain('CREATE TABLE [dbo].[Users]');
    expect(sql).toContain('[id] INT IDENTITY(1,1) NOT NULL');
    expect(sql).toContain('PRIMARY KEY ([id])');
  });

  it('ALTER add-column omits the COLUMN keyword; modify uses ALTER COLUMN', () => {
    const add = buildDdl('mssql', 'alter', { alter: { schema: 'dbo', table: 'Users', actions: [{ kind: 'addColumn', column: { name: 'age', type: 'INT' } }] } });
    expect(add[0]).toBe('ALTER TABLE [dbo].[Users] ADD [age] INT');
    const mod = buildDdl('mssql', 'alter', { alter: { schema: 'dbo', table: 'Users', actions: [{ kind: 'modifyColumn', name: 'age', column: { name: 'age', type: 'BIGINT', nullable: false } }] } });
    expect(mod[0]).toBe('ALTER TABLE [dbo].[Users] ALTER COLUMN [age] BIGINT NOT NULL');
  });

  it('renames go through sp_rename (bracket-quoted source); dropIndex is scoped to the table', () => {
    // sp_rename's source object is a string literal whose parts are bracket-quoted
    // so names with dots/special chars parse correctly; the new name stays bare.
    const rc = buildDdl('mssql', 'alter', { alter: { schema: 'dbo', table: 'Users', actions: [{ kind: 'renameColumn', from: 'email', to: 'mail' }] } });
    expect(rc[0]).toBe("EXEC sp_rename '[dbo].[Users].[email]', 'mail', 'COLUMN'");
    const rt = buildDdl('mssql', 'alter', { alter: { schema: 'dbo', table: 'Users', actions: [{ kind: 'renameTable', to: 'Accounts' }] } });
    expect(rt[0]).toBe("EXEC sp_rename '[dbo].[Users]', 'Accounts'");
    const di = buildDdl('mssql', 'alter', { alter: { schema: 'dbo', table: 'Users', actions: [{ kind: 'dropIndex', name: 'ix_email' }] } });
    expect(di[0]).toBe('DROP INDEX [ix_email] ON [dbo].[Users]');
  });
});
