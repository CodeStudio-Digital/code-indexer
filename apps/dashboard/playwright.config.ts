import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  outputDir: '../../.smoke/playwright-results',
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFilePath}/{arg}-{projectName}{ext}',
  timeout: 30_000,
  expect: {
    toHaveScreenshot: {
      animations: 'disabled',
      maxDiffPixelRatio: 0.01,
    },
  },
  use: {
    baseURL: process.env.CODESTUDIO_E2E_URL ?? 'http://localhost:7317',
    colorScheme: 'dark',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: '1280x720-dark', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 720 } } },
    { name: '1440x900-dark', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: '1920x1080-dark', use: { ...devices['Desktop Chrome'], viewport: { width: 1920, height: 1080 } } },
  ],
});
