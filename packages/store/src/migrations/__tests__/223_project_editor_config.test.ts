import { describe, expect, it } from 'vitest';
import { projectEditorConfig223 } from '../223_project_editor_config.js';

describe('migration 223 project_editor_config', () => {
  it('creates an idempotent routed settings table without repository files', () => {
    const statements: string[] = [];
    const db = { exec: (sql: string) => { statements.push(sql); } };
    projectEditorConfig223.up(db as never);
    expect(statements.join('\n')).toContain('CREATE TABLE IF NOT EXISTS project_editor_config');
    expect(statements.join('\n')).toContain('settings_json TEXT');
    expect(statements.join('\n')).not.toContain('root_path');
  });
});
