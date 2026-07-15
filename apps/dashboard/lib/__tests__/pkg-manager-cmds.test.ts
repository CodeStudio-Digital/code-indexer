import { describe, expect, it } from 'vitest';
import {
  MANAGER_KEY,
  MANAGER_OPTIONS,
  MANAGERS_FOR_KIND,
  updateCommand,
} from '../pkg-manager-cmds.js';

describe('pkg-manager-cmds', () => {
  it('maps each runtime to its settings key (php is fixed → none)', () => {
    expect(MANAGER_KEY.node).toBe('node');
    expect(MANAGER_KEY.python).toBe('python');
    expect(MANAGER_KEY.php).toBeUndefined();
    expect(MANAGER_KEY.java).toBe('java');
    expect(MANAGER_KEY.dotnet).toBeUndefined();
  });

  it('offers auto + the expected managers per runtime', () => {
    expect(MANAGER_OPTIONS.node).toEqual(['auto', 'npm', 'yarn', 'pnpm', 'bun']);
    expect(MANAGER_OPTIONS.python).toEqual(['auto', 'pip', 'poetry']);
    expect(MANAGER_OPTIONS.php).toEqual(['composer']);
    expect(MANAGER_OPTIONS.java).toEqual(['auto', 'maven', 'gradle']);
    expect(MANAGER_OPTIONS.dotnet).toEqual(['dotnet']);
  });

  it('groups managers by runtime for detect-group matching', () => {
    expect(MANAGERS_FOR_KIND.node).toContain('pnpm');
    expect(MANAGERS_FOR_KIND.php).toEqual(['composer']);
    expect(MANAGERS_FOR_KIND.python).toEqual(['pip', 'poetry']);
    expect(MANAGERS_FOR_KIND.java).toEqual(['maven', 'gradle']);
    expect(MANAGERS_FOR_KIND.dotnet).toEqual(['dotnet']);
  });

  it('derives the update command per manager', () => {
    expect(updateCommand('npm')).toBe('npm update');
    expect(updateCommand('yarn')).toBe('yarn upgrade');
    expect(updateCommand('pnpm')).toBe('pnpm update');
    expect(updateCommand('bun')).toBe('bun update');
    expect(updateCommand('composer')).toBe('composer update');
    expect(updateCommand('pip')).toBe('pip install --upgrade -r requirements.txt');
    expect(updateCommand('poetry')).toBe('poetry update');
    expect(updateCommand('maven')).toBe('mvn -U dependency:resolve');
    expect(updateCommand('gradle')).toBe('gradle build --refresh-dependencies -x test');
    expect(updateCommand('dotnet')).toBe('dotnet restore --force');
  });
});
