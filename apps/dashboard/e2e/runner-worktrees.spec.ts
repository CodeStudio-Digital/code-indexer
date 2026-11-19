import { expect, test } from '@playwright/test';
import type { DetectedGroup, ElectronAPI, RunnerStartInput } from '@mcp/api-bus';

test.use({ screenshot: 'only-on-failure' });

test('the bottom Runners panel follows the selected worktree without stopping its tasks', async ({ page }) => {
  const projectId = 7;
  const mainPath = 'D:/fixture/project';
  const featurePath = 'D:/fixture/feature checkout';
  const worktrees = [
    { path: mainPath, branch: 'main', primary: true, head: 'abc', locked: false, prunable: false },
    { path: featurePath, branch: 'codex/feature', primary: false, head: 'def', locked: false, prunable: false },
  ];
  const scans: Array<string | null> = [];
  const launches: RunnerStartInput[] = [];
  const controls: string[] = [];
  let finishFirstFeatureScan!: () => void;
  const firstFeatureScan = new Promise<void>(resolve => { finishFirstFeatureScan = resolve; });

  await page.route('**/api/**', async route => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/api/coder/worktrees') return route.fulfill({ json: { projectId, isGit: true, worktrees } });
    if (pathname.endsWith('/db-client/connections')) return route.fulfill({ json: { connections: [] } });
    if (pathname.includes('/skills')) return route.fulfill({ json: { skills: [] } });
    if (pathname.endsWith('/tree')) return route.fulfill({ json: { files: [] } });
    if (pathname === '/api/coder/providers') return route.fulfill({ json: { providers: [], legacy: true } });
    return route.fulfill({ json: [] });
  });
  await page.exposeFunction('invokeFixture', async (method: string, input: RunnerStartInput) => {
    if (method === 'projects.get') return { ok: true, value: { id: projectId, name: 'CodeStudio', root_path: mainPath } };
    if (method === 'runner.detect') {
      const scope = input.worktreePath ?? null;
      const feature = scope === featurePath;
      const pause = feature && !scans.includes(scope);
      scans.push(scope);
      if (pause) await firstFeatureScan;
      const group: DetectedGroup = feature
        ? { manager: 'composer', source: 'backend/composer.json', cwd: 'backend', installNeeded: false,
            runners: [{ id: 'composer:backend:check', manager: 'composer', label: 'feature-only', command: 'composer run check' }] }
        : { manager: 'npm', source: 'package.json', installNeeded: false,
            runners: [{ id: 'npm:main-only', manager: 'npm', label: 'main-only', command: 'npm run main-only' }] };
      return { ok: true, value: { groups: [group] } };
    }
    if (method === 'runner.start') {
      launches.push(input);
      return { ok: true, value: { ...input, worktreePath: input.worktreePath ?? undefined, projectName: 'CodeStudio',
        taskId: `run-${launches.length}`, terminalId: `pty-${launches.length}`, status: 'running', exitCode: null, startedAt: Date.now() } };
    }
    if (method === 'runner.stop' || method === 'runner.dismiss' || method === 'terminal.kill') controls.push(method);
    return { ok: true, value: null };
  });
  await page.addInitScript(() => {
    const browser = window as unknown as {
      __MCP_API_BASE__: string;
      electronAPI: Pick<ElectronAPI, 'invoke' | 'openStream'>;
      invokeFixture: (method: string, input: unknown) => Promise<unknown>;
    };
    browser.__MCP_API_BASE__ = '';
    const done = async () => ({ done: true as const, value: undefined });
    browser.electronAPI = {
      invoke: (method, input) => browser.invokeFixture(method, input),
      openStream: () => ({ next: done, return: done }),
    };
    localStorage.setItem('i18n-lang', 'pt-BR');
  });

  await page.goto('/e2e/fixtures/session-worktrees.html');
  const bar = page.getByTestId('session-workspace-bar');
  const choose = async (name: string) => {
    await bar.getByRole('button', { name: /Alternar worktree/ }).click();
    await page.getByRole('dialog', { name: 'Worktrees do projeto' }).getByRole('button', { name, exact: true }).click();
  };
  const mainScript = page.getByRole('button', { name: /main-only npm run/ });
  const featureScript = page.getByRole('button', { name: /feature-only composer run/ });
  const stop = page.getByRole('button', { name: 'Encerrar', exact: true });
  await page.getByRole('button', { name: 'Terminal (Alt+F12)', exact: true }).click();
  await page.getByRole('button', { name: 'Runners', exact: true }).click();
  await expect(mainScript).toBeVisible();
  await mainScript.click();
  await expect(stop).toHaveCount(1);

  await choose('codex/feature');
  await expect.poll(() => scans.includes(featurePath)).toBe(true);
  await expect(mainScript).toHaveCount(0);
  await expect(stop).toHaveCount(0);
  await choose('Principal');
  await expect(mainScript).toBeVisible();
  finishFirstFeatureScan();
  await expect(featureScript).toHaveCount(0);
  await expect(stop).toHaveCount(1);

  await choose('codex/feature');
  await expect(featureScript).toBeVisible();
  await featureScript.click();
  await expect(stop).toHaveCount(1);
  expect(launches).toMatchObject([
    { projectId, worktreePath: null, command: 'npm run main-only' },
    { projectId, worktreePath: featurePath, cwd: 'backend', command: 'composer run check' },
  ]);

  await choose('Principal');
  await expect(mainScript).toBeVisible();
  await expect(featureScript).toHaveCount(0);
  await expect(stop).toHaveCount(1);
  expect(controls).toEqual([]);
});
