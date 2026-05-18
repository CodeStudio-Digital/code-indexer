import { describe, it, expect } from 'vitest';
import {
  inferPortFromNodeScript,
  inferNodeDevPort,
  isBuilderStack,
  isExternalProjectRuntime,
  isProvisionableStack,
  validateLimits,
} from '@apps/http-api/server/routes/company/sandbox-helpers.js';
import type { NodeManifest } from '@mcp/services/sandbox/manifest-detector/types.js';

function manifest(scriptName: string, scriptValue: string): NodeManifest {
  return {
    kind: 'node',
    rootPath: '/fake',
    packageJsonPath: '/fake/package.json',
    devScriptName: scriptName,
    scripts: { [scriptName]: scriptValue },
    packageManager: 'npm',
  } as unknown as NodeManifest;
}

describe('sandbox-helpers', () => {
  describe('isBuilderStack / isProvisionableStack', () => {
    it('accepts user-pickable stacks for builder', () => {
      expect(isBuilderStack('react-ts')).toBe(true);
      expect(isBuilderStack('vue-ts')).toBe(true);
    });

    it('rejects non-string / unknown values', () => {
      expect(isBuilderStack(undefined)).toBe(false);
      expect(isBuilderStack(null)).toBe(false);
      expect(isBuilderStack('not-a-stack')).toBe(false);
      expect(isBuilderStack(42)).toBe(false);
    });

    it('isProvisionableStack admits the same set as isBuilderStack at minimum', () => {
      // PROVISIONABLE_STACKS is a superset (includes internal `node-only`),
      // so every builder stack is provisionable.
      expect(isProvisionableStack('react-ts')).toBe(true);
      expect(isProvisionableStack('vue-ts')).toBe(true);
    });
  });

  describe('isExternalProjectRuntime', () => {
    it('accepts the two known runtimes', () => {
      expect(isExternalProjectRuntime('dockerfile')).toBe(true);
      expect(isExternalProjectRuntime('node')).toBe(true);
    });
    it('rejects anything else', () => {
      expect(isExternalProjectRuntime('docker')).toBe(false);
      expect(isExternalProjectRuntime('')).toBe(false);
      expect(isExternalProjectRuntime(null)).toBe(false);
      expect(isExternalProjectRuntime(undefined)).toBe(false);
    });
  });

  describe('inferPortFromNodeScript', () => {
    it('reads `--port=PORT`', () => {
      expect(inferPortFromNodeScript('vite --port=3001')).toBe(3001);
    });
    it('reads `--port PORT`', () => {
      expect(inferPortFromNodeScript('vite --port 4567')).toBe(4567);
    });
    it('reads short `-p PORT`', () => {
      expect(inferPortFromNodeScript('next -p 4000')).toBe(4000);
    });
    it('returns null when no port flag is present', () => {
      expect(inferPortFromNodeScript('npm run dev')).toBeNull();
    });
    it('returns null for out-of-range ports', () => {
      expect(inferPortFromNodeScript('vite --port 99999')).toBeNull();
      expect(inferPortFromNodeScript('vite --port 0')).toBeNull();
    });
  });

  describe('inferNodeDevPort', () => {
    it('prefers explicit port flag from the script', () => {
      expect(inferNodeDevPort('react-ts', manifest('dev', 'vite --port 7000'))).toBe(7000);
    });
    it('uses 4200 for angular stack regardless of script', () => {
      expect(inferNodeDevPort('angular', manifest('start', 'ng serve'))).toBe(4200);
    });
    it('detects `ng serve` in any stack and uses 4200', () => {
      expect(inferNodeDevPort('react-ts', manifest('start', 'ng serve --hmr'))).toBe(4200);
    });
    it('detects `next dev` and uses 3000', () => {
      expect(inferNodeDevPort('react-ts', manifest('dev', 'next dev'))).toBe(3000);
    });
    it('falls back to 5173 for generic Vite/Node dev scripts', () => {
      expect(inferNodeDevPort('react-ts', manifest('dev', 'vite'))).toBe(5173);
      expect(inferNodeDevPort('vue-ts', manifest('dev', 'vite'))).toBe(5173);
    });
  });

  describe('validateLimits', () => {
    it('accepts undefined limits', () => {
      expect(validateLimits(undefined)).toBeNull();
    });
    it('accepts empty object', () => {
      expect(validateLimits({})).toBeNull();
    });
    it('accepts canonical memory specs', () => {
      for (const m of ['512m', '1g', '2048', '1.5g', '256Mi']) {
        expect(validateLimits({ memory: m })).toBeNull();
      }
    });
    it('rejects nonsense memory', () => {
      const err = validateLimits({ memory: 'pancakes' });
      expect(err).toMatch(/Invalid builder\.limits\.memory/);
    });
    it('accepts numeric cpus', () => {
      for (const c of ['0.5', '1', '2', '4.0']) {
        expect(validateLimits({ cpus: c })).toBeNull();
      }
    });
    it('rejects non-numeric cpus', () => {
      expect(validateLimits({ cpus: 'half' })).toMatch(/Invalid builder\.limits\.cpus/);
      expect(validateLimits({ cpus: '' })).toMatch(/Invalid builder\.limits\.cpus/);
    });
    it('requires integer pids >= 16', () => {
      expect(validateLimits({ pids: 16 })).toBeNull();
      expect(validateLimits({ pids: 100 })).toBeNull();
      expect(validateLimits({ pids: 15 })).toMatch(/Invalid builder\.limits\.pids/);
      expect(validateLimits({ pids: 12.5 })).toMatch(/Invalid builder\.limits\.pids/);
    });
  });
});
