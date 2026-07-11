import { describe, expect, it } from 'vitest';
import {
  nextMigrationFilename,
  normalizeMigrationSlug,
  validateAppMigrationSql,
} from '../database/migration.js';

describe('App Studio migration contract', () => {
  it('normalizes names and increments the highest migration number', () => {
    expect(normalizeMigrationSlug('Adicionar responsável ao Clube')).toBe('adicionar_responsavel_ao_clube');
    expect(nextMigrationFilename(['0001_init.sql', '0007_index.sql'], 'Club owner')).toBe('0008_club_owner.sql');
  });

  it('accepts DDL and rejects empty, data-only and unsafe scripts', () => {
    expect(validateAppMigrationSql('CREATE TABLE clubes (id INTEGER PRIMARY KEY);')).toBeNull();
    expect(validateAppMigrationSql('-- comment only')).toContain('at least one SQL statement');
    expect(validateAppMigrationSql('INSERT INTO clubes VALUES (1);')).toContain('schema migration');
    expect(validateAppMigrationSql("ATTACH DATABASE 'x' AS external; CREATE TABLE x(id INTEGER);")).toContain('unsafe');
    expect(validateAppMigrationSql('PRAGMA foreign_keys = OFF; CREATE TABLE x(id INTEGER);')).toContain('destructive');
    expect(validateAppMigrationSql('DROP TABLE clubes;')).toContain('destructive');
    expect(validateAppMigrationSql('ALTER TABLE clubes RENAME TO clubes_anterior;')).toContain('destructive');
  });
});
