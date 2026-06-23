/**
 * Dry-run dos templates do DS Studio — trava o shape do workspace sem
 * tocar disco/CLI: root workspaces + script dev, pkg/package.json
 * publicável (exports/files/peerDeps, sem storybook), vite.config com
 * porta pinada + strictPort + aliases @/@ds + stamp, e o glob do pkg no
 * Tailwind da galeria (o replace cirúrgico sobre TAILWIND_CONFIG_CJS
 * no-opa silenciosamente se o upstream mudar a linha — este teste acusa).
 */
import { describe, it, expect } from 'vitest';
import {
  buildReactWorkspaceFiles,
  renderDsStudioViteConfig,
} from '../ds-studio/react-inject.js';
import { DS_TAILWIND_CONFIG_CJS, APP_INDEX_CSS } from '../ds-studio/templates-react-gallery.js';
import { buildVueWorkspaceFiles } from '../ds-studio/templates-vue.js';
import { angularCliSteps } from '../ds-studio/templates-angular.js';
import { getSourceStampPlugin } from '../../sandbox/builder/source-stamp/registry.js';

const TPL = { slug: 'acme-ds', packageName: '@acme/ds' };

function fileMap(files: Array<{ path: string; contents: string }>): Map<string, string> {
  return new Map(files.map((f) => [f.path, f.contents]));
}

describe('ds-studio react workspace templates', () => {
  const files = fileMap(buildReactWorkspaceFiles(TPL));

  it('root package.json declares the workspaces and the dashboard dev script', () => {
    const root = JSON.parse(files.get('package.json')!) as {
      workspaces: string[];
      scripts: Record<string, string>;
      private: boolean;
    };
    expect(root.private).toBe(true);
    expect(root.workspaces).toEqual(['app', 'pkg']);
    // useProjectDevServer roda `npm run dev` na raiz — precisa servir a galeria.
    expect(root.scripts.dev).toBe('npm run dev --workspace app');
  });

  it('pkg/package.json is publishable under the studio audit profile', () => {
    const pkg = JSON.parse(files.get('pkg/package.json')!) as {
      name: string;
      files: string[];
      exports: Record<string, string>;
      peerDependencies: Record<string, string>;
    };
    expect(pkg.name).toBe('@acme/ds');
    expect(pkg.files).toContain('src');
    expect(pkg.files).toContain('docs.md');
    expect(pkg.exports['.']).toBe('./src/index.ts');
    expect(pkg.exports['./tokens.css']).toBe('./src/tokens.css');
    // Wildcard mantém o exports-completeness do audit satisfeito p/ deep imports.
    expect(pkg.exports['./*']).toBe('./src/*');
    expect(Object.keys(pkg.peerDependencies)).toEqual(['react', 'react-dom']);
    expect(JSON.stringify(pkg)).not.toContain('storybook');
  });

  it('ships tokens.css + docs.md + empty gallery registry', () => {
    expect(files.get('pkg/src/tokens.css')).toContain('--primary:');
    expect(files.get('pkg/docs.md')).toContain('@acme/ds');
    expect(files.get('app/src/gallery/registry.tsx')).toContain('Record<string, ReactNode>');
    // index.css é escrito pela instrumentação (inject), não pelo skeleton.
    expect(APP_INDEX_CSS).toContain(`@import '@ds/tokens.css';`);
  });

  it('gallery tailwind config also scans ../pkg/src (surgical replace held)', () => {
    expect(DS_TAILWIND_CONFIG_CJS).toContain(`'../pkg/src/**/*.{ts,tsx,js,jsx}'`);
  });
});

describe('ds-studio react vite config', () => {
  it('pins the port, allows the workspace root and keeps the stamp first', () => {
    const stamp = getSourceStampPlugin('react-ts')!.contribution();
    const cfg = renderDsStudioViteConfig(stamp.vite, 5181);
    expect(cfg).toContain('port: 5181');
    expect(cfg).toContain('strictPort: true');
    expect(cfg).toContain(`fs: { allow: ['..'] }`);
    expect(cfg).toContain(`"@ds": __mcpFileURL(new URL('../pkg/src', import.meta.url))`);
    // Stamp roda antes do plugin-react (ambos enforce:'pre') — ordem importa.
    expect(cfg.indexOf('mcpStampVite()')).toBeLessThan(cfg.indexOf('react()'));
  });
});

describe('ds-studio vue workspace templates', () => {
  const files = fileMap(buildVueWorkspaceFiles(TPL, 5182));

  it('mirrors the workspace shape with a pinned-port vite config', () => {
    const root = JSON.parse(files.get('package.json')!) as { workspaces: string[] };
    expect(root.workspaces).toEqual(['app', 'pkg']);
    expect(files.get('app/vite.config.ts')).toContain('port: 5182');
    expect(files.get('app/vite.config.ts')).toContain('@ds');
    const pkg = JSON.parse(files.get('pkg/package.json')!) as {
      peerDependencies: Record<string, string>;
    };
    expect(Object.keys(pkg.peerDependencies)).toEqual(['vue']);
  });
});

describe('ds-studio angular CLI plan', () => {
  it('creates an empty workspace then app + pkg projects', () => {
    const steps = angularCliSteps('acme-ds');
    expect(steps.map((s) => s.phase)).toEqual(['ng-new', 'ng-app', 'ng-lib']);
    expect(steps[0].args).toContain('--create-application=false');
    expect(steps[1].args).toContain('application');
    expect(steps[2].args).toContain('library');
  });
});
