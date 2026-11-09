import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectEnvReads, collectSettingReferences } from './ast-collector.js';

describe('settings source inventory', () => {
  it('expands inline const allowlists and preserves mixed-case OS environment names', () => {
    const root = mkdtempSync(join(tmpdir(), 'env-literal-loop-'));
    try {
      mkdirSync(join(root, 'src'));
      writeFileSync(join(root, 'src', 'runtime.ts'), `
        for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']) {
          if (process.env[key]) env[key] = process.env[key];
        }
        const direct = process.env.SystemRoot;
      `);
      const result = collectEnvReads(root, ['src']);
      expect(result.dynamicConsumers).toEqual([]);
      expect([...result.hits.keys()].sort()).toEqual(['SystemRoot', 'TEMP', 'TMP', 'WINDIR']);
      expect(result.hits.get('SystemRoot')?.consumers).toHaveLength(3);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each([
    "for (let key of ['CODER_ONE']) { key = input; use(process.env[key]); }",
    'for (const key of runtimeKeys) use(process.env[key]);',
    "for (const key of ['CODER_ONE']) { { const key = input; use(process.env[key]); } }",
    "for (const key of ['CODER_ONE']) { function read(key) { use(process.env[key]); } }",
    "for (const $key of ['CODER_ONE']) { { const $key = input; use(process.env[$key]); } }",
  ])('keeps unproven loop accesses dynamic: %s', (source) => {
    const root = mkdtempSync(join(tmpdir(), 'env-dynamic-loop-'));
    try {
      mkdirSync(join(root, 'src'));
      writeFileSync(join(root, 'src', 'runtime.ts'), source);
      const result = collectEnvReads(root, ['src']);
      expect(result.dynamicConsumers).toHaveLength(1);
      expect([...result.hits.keys()]).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('distinguishes direct reads, indirect references and obsolete declarations without test/comment matches', () => {
    const root = mkdtempSync(join(tmpdir(), 'settings-inventory-'));
    try {
      mkdirSync(join(root, 'src', 'app-settings'), { recursive: true });
      mkdirSync(join(root, 'src', 'migrations'));
      writeFileSync(join(root, 'src', 'runtime.ts'), `
        const direct = process.env.MCP_DIRECT;
        const alias = env.MCP_ALIAS;
        const helper = envInt('MCP_HELPER', 3);
        const ui = itemByKey.get('MCP_UI');
        // MCP_DEAD only mentioned in a comment.
      `);
      writeFileSync(join(root, 'src', 'only.test.ts'), 'const x = process.env.MCP_TEST_ONLY;');
      writeFileSync(join(root, 'src', 'app-settings', 'group.ts'), "const item = {key:'MCP_DEAD'};");
      writeFileSync(join(root, 'src', 'migrations', 'old.ts'), "const old = 'MCP_DEAD';");
      const keys = ['MCP_DIRECT', 'MCP_ALIAS', 'MCP_HELPER', 'MCP_UI', 'MCP_DEAD', 'MCP_TEST_ONLY'];
      const direct = collectEnvReads(root, ['src']);
      expect([...direct.hits.keys()]).toEqual(['MCP_DIRECT']);
      const refs = collectSettingReferences(root, ['src'], keys);
      for (const key of keys.slice(0, 4)) expect(refs.get(key)?.length).toBeGreaterThan(0);
      expect(refs.get('MCP_DEAD')).toEqual([]);
      expect(refs.get('MCP_TEST_ONLY')).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
