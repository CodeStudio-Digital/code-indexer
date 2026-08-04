import { expect, test } from '@playwright/test';

const projectId = process.env.CODESTUDIO_E2E_PROJECT_ID;

test.describe('AI-first project workbench', () => {
  test.skip(!projectId, 'Set CODESTUDIO_E2E_PROJECT_ID to a local fixture project.');

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('mcp-ide:onboarded', 'true');
      localStorage.setItem('theme', 'dark');
      localStorage.setItem('mcp-ide:workspace-layout-v3', JSON.stringify({
        activeLeft: 'files',
        activeRight: 'chat',
        activeBottom: null,
        primarySurface: 'editor',
        previewVisible: true,
      }));
    });
    await page.goto(`/#/projects/${projectId}`);
    await expect(page.getByRole('tab', { name: 'Code', exact: true })).toBeVisible();
  });

  test('keeps left, primary and right surfaces composed', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'Files', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: 'AI Chat', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: 'Sessions', exact: true })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Session', exact: true })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'SSH', exact: true })).toBeVisible();
    await expect(page.getByText('Workspace ready', { exact: true })).toBeVisible();
    await expect(page.locator('.workbench-shell')).toHaveScreenshot('project-workbench.png');
  });

  test('composes all four quadrants without replacing the editor', async ({ page }) => {
    await page.getByRole('button', { name: 'Terminal (Alt+F12)', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toBeVisible();
    await expect(page.getByText('Workspace ready', { exact: true })).toBeVisible();
    await expect(page.locator('.workbench-shell')).toHaveScreenshot('project-workbench-bottom.png');
  });

  test('switches to the API-owned docks without leaving stale project tools open', async ({ page }) => {
    await page.getByRole('tab', { name: 'API', exact: true }).click();
    await expect(page.getByRole('tab', { name: 'API', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('button', { name: 'API', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: 'API response', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: 'Files', exact: true })).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByRole('button', { name: 'AI Chat', exact: true })).toHaveCount(0);
  });

  test('replaces the Git host when another left tool window is selected', async ({ page }) => {
    const git = page.getByRole('button', { name: 'Git', exact: true });
    const closeGit = page.getByRole('button', { name: 'Close Git', exact: true });

    await git.click();
    await expect(closeGit).toBeVisible();
    await page.getByRole('button', { name: 'Sessions', exact: true }).click();
    await expect(closeGit).toHaveCount(0);
    await expect(page.getByRole('complementary')).toBeVisible();

    await git.click();
    await expect(closeGit).toBeVisible();
    await page.getByRole('button', { name: 'Databases', exact: true }).click();
    await expect(closeGit).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: /Database tools|Ferramentas do banco de dados/ })).toBeVisible();

    await git.click();
    await expect(closeGit).toBeVisible();
    await page.getByRole('button', { name: 'API', exact: true }).click();
    await expect(closeGit).toHaveCount(0);
    await expect(page.getByText('API Client', { exact: true })).toBeVisible();
  });

  test('opens right docks only while they have renderable content', async ({ page }) => {
    const surfaces = page.locator('.workbench-surface');

    await expect(surfaces).toHaveCount(3); // Files + Code + AI Chat.
    await page.getByRole('button', { name: 'AI Chat', exact: true }).click();
    await expect(surfaces).toHaveCount(2);

    await page.getByRole('button', { name: 'Snapshots', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Close Snapshots', exact: true })).toBeVisible();
    await expect(surfaces).toHaveCount(3);
    await page.getByRole('button', { name: 'Snapshots', exact: true }).click();
    await expect(surfaces).toHaveCount(2);

    await page.getByRole('button', { name: 'Memory', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Close Memory', exact: true })).toBeVisible();
    await expect(surfaces).toHaveCount(3);
    await page.getByRole('button', { name: 'Memory', exact: true }).click();
    await expect(surfaces).toHaveCount(2);

    await page.getByRole('button', { name: 'API', exact: true }).click();
    await expect(page.getByRole('button', { name: 'API response', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(surfaces).toHaveCount(3);

    await page.getByRole('button', { name: 'Databases', exact: true }).click();
    await expect(page.getByRole('tab', { name: 'Code', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('button', { name: 'API response', exact: true })).toHaveCount(0);
    await expect(surfaces).toHaveCount(2);
    const databaseNavigation = page.getByRole('tablist', { name: /Database tools|Ferramentas do banco de dados/ });
    await expect(databaseNavigation).toBeVisible();
    await expect(databaseNavigation.getByRole('tab')).toHaveCount(4);
    await expect(databaseNavigation.getByRole('tab', { name: /Connections|Conexões/ })).toHaveAttribute('aria-selected', 'true');
  });

  test('composes Sessions through the IDE docks without nesting another shell', async ({ page }) => {
    await page.getByRole('button', { name: 'Sessions', exact: true }).click();
    await expect(page.getByRole('tab', { name: 'Session', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('button', { name: 'AI Chat', exact: true })).toHaveCount(0);
    const sessionDock = page.getByRole('complementary');
    await expect(sessionDock).toBeVisible();
    await expect(page.locator('nav[aria-label="Session tools"]')).toHaveCount(0);

    const sessionRows = sessionDock.locator('[data-session-id]');
    expect(await sessionRows.count()).toBeGreaterThan(0);
    await sessionRows.first().click();

    await expect(page.getByRole('tab', { name: 'Session', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('nav[aria-label="Session tools"]')).toBeVisible();
    await expect(page.locator('nav[aria-label="Context tool windows"]')).toHaveCount(0);
    await expect(page.locator('.workbench-shell')).toHaveScreenshot('project-sessions.png');

    // A docked session list must not switch to the off-canvas mobile drawer
    // when the app window crosses below Tailwind's `lg` viewport breakpoint.
    await page.setViewportSize({ width: 1000, height: 800 });
    await expect(sessionDock).toBeVisible();
    await expect(sessionDock).toHaveCSS('position', 'static');
    await expect(sessionRows.first()).toBeVisible();
    await expect(page.locator('nav[aria-label="Session tools"]')).toBeVisible();

    await page.getByRole('tab', { name: 'Code', exact: true }).click();
    await expect(page.getByRole('tab', { name: 'Session', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'AI Chat', exact: true })).toHaveCount(0);
  });

  test('keeps SSH alive as a primary surface instead of a bottom tab', async ({ page }) => {
    await page.getByRole('tab', { name: 'SSH', exact: true }).click();
    await expect(page.getByRole('tab', { name: 'SSH', exact: true })).toHaveAttribute('aria-selected', 'true');
    const sshSurface = page.locator('[data-project-primary-surface="ssh"]');
    await expect(sshSurface).toBeVisible();
    await sshSurface.evaluate((element) => element.setAttribute('data-retained-probe', 'ssh'));

    await page.getByRole('tab', { name: 'Code', exact: true }).click();
    await expect(page.locator('[data-retained-probe="ssh"]')).toHaveCount(1);
    await expect(sshSurface).toBeHidden();

    await page.getByRole('tab', { name: 'SSH', exact: true }).click();
    await expect(sshSurface).toBeVisible();
    await expect(page.locator('[data-retained-probe="ssh"]')).toHaveCount(1);

    await page.getByRole('button', { name: 'Terminal (Alt+F12)', exact: true }).click();
    await expect(page.getByRole('button', { name: 'SSH', exact: true })).toHaveCount(0);
  });

  test('uses the neutral workbench hierarchy in Database', async ({ page }) => {
    await page.getByRole('button', { name: 'Databases', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Databases', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('tab', { name: 'Code', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.workbench-shell')).toHaveScreenshot('project-databases.png');
  });

  test('composes Global Sessions with the shared workbench containers', async ({ page }) => {
    await page.goto('/#/global');
    await expect(page.getByRole('complementary')).toBeVisible();
    await expect(page.locator('.workbench-surface')).toHaveCount(2);
    await expect(page.locator('nav[aria-label="Session tools"]')).toHaveCount(0);
    await expect(page.locator('.workbench-shell')).toHaveScreenshot('global-sessions.png');

    const globalRows = page.getByRole('complementary').locator('[data-session-id]');
    expect(await globalRows.count()).toBeGreaterThan(0);
    await globalRows.first().click();
    await expect(page.locator('.workbench-surface')).toHaveCount(3);
    await expect(page.locator('nav[aria-label="Session tools"]')).toBeVisible();
  });
});
