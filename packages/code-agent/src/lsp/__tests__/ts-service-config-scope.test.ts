import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TsLanguageService } from '../ts-service.js';

let root: string;
let project: string;
let service: TsLanguageService | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ts-config-scope-'));
  project = join(root, 'child');
  mkdirSync(project);
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { baseUrl: '.', paths: { 'parent/*': ['./*'] } }, include: ['./outside.ts'],
  }));
  writeFileSync(join(root, 'outside.ts'), 'export const outside = 1;');
  writeFileSync(join(project, 'inside.ts'), 'export const inside = 2;');
});
afterEach(() => { service?.dispose(); service = undefined; rmSync(root, { recursive: true, force: true }); });

describe('project configuration scope', () => {
  it('does not load ancestor files or compiler options for an unconfigured project', () => {
    service = new TsLanguageService(project);
    const info = service.diagnose();
    expect(info.tsconfigPath).toBeNull();
    expect(info.rootFilesCount).toBe(0);
    expect(info.compilerOptions.paths).toBeUndefined();
  });

  it('can analyze JavaScript even when an unrelated ancestor config excludes it', () => {
    writeFileSync(join(project, 'example.js'), 'export function add(a, b) { return a + b; }\n');
    service = new TsLanguageService(project);
    expect(service.getSemanticTokens('example.js').length).toBeGreaterThan(0);
  });

  it('preserves an explicit extends without adopting the parent file set', () => {
    writeFileSync(join(project, 'tsconfig.json'), JSON.stringify({ extends: '../tsconfig.json', include: ['./inside.ts'] }));
    service = new TsLanguageService(project, true);
    let info = service.diagnose();
    expect(info.rootFilesCount).toBe(1);
    expect(info.rootFilesSample[0]).toMatch(/\/child\/inside\.ts$/);
    expect(info.compilerOptions.paths).toEqual({ 'parent/*': ['./*'] });
    service.refreshDiskProject();
    info = service.diagnose();
    expect(info.rootFilesCount).toBe(1);
  });

  it('supports a project-local jsconfig and prefers a local tsconfig when present', () => {
    writeFileSync(join(project, 'jsconfig.json'), JSON.stringify({ compilerOptions: { allowJs: true }, files: ['./inside.ts'] }));
    service = new TsLanguageService(project, true);
    expect(service.diagnose().tsconfigPath).toMatch(/jsconfig\.json$/);
    expect(service.diagnose().rootFilesCount).toBe(1);
    writeFileSync(join(project, 'tsconfig.json'), JSON.stringify({ files: [] }));
    service.refreshDiskProject();
    expect(service.diagnose().tsconfigPath).toMatch(/tsconfig\.json$/);
    expect(service.diagnose().rootFilesCount).toBe(0);
  });
});
