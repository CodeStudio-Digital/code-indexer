import { expect, test } from '@playwright/test';

interface ApiRequestMeasurement {
  phase: string;
  method: string;
  url: string;
  status: number | null;
  bytes: number | null;
}

interface RenderMeasurement {
  commits: number;
  mutationRecords: number;
}

test('captures the read-only legacy workbench network/render baseline', async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  const blockedModifyingRequests: string[] = [];
  const requests: ApiRequestMeasurement[] = [];
  const responseReads: Promise<void>[] = [];
  const requestMeasurements = new Map<object, ApiRequestMeasurement>();
  let currentPhase = 'navigation';

  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.route('/api/**', async (route) => {
    const method = route.request().method();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      blockedModifyingRequests.push(`${method} ${new URL(route.request().url()).pathname}`);
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });

  page.on('request', (request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith('/api/')) return;
    const measurement: ApiRequestMeasurement = {
      phase: currentPhase,
      method: request.method(),
      url: `${url.pathname}${url.search}`,
      status: null,
      bytes: null,
    };
    requestMeasurements.set(request, measurement);
    requests.push(measurement);
  });
  page.on('response', (response) => {
    const measurement = requestMeasurements.get(response.request());
    if (!measurement) return;
    measurement.status = response.status();
    const contentType = response.headers()['content-type'] ?? '';
    if (contentType.includes('text/event-stream')) return;
    responseReads.push(response.body()
      .then((body) => { measurement.bytes = body.byteLength; })
      .catch(() => { measurement.bytes = null; }));
  });

  await page.addInitScript(() => {
    const metrics = { commits: [] as number[], mutationRecords: 0 };
    Object.defineProperty(window, '__CSW_BASELINE__', { value: metrics, configurable: true });
    Object.defineProperty(window, '__REACT_DEVTOOLS_GLOBAL_HOOK__', {
      configurable: true,
      value: {
        supportsFiber: true,
        renderers: new Map<number, object>(),
        inject(renderer: object) {
          const id = this.renderers.size + 1;
          this.renderers.set(id, renderer);
          return id;
        },
        onCommitFiberRoot() {
          metrics.commits.push(performance.now());
        },
        onCommitFiberUnmount() {},
        onPostCommitFiberRoot() {},
        checkDCE() {},
      },
    });
    addEventListener('DOMContentLoaded', () => {
      new MutationObserver((records) => { metrics.mutationRecords += records.length; })
        .observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
    }, { once: true });
    localStorage.setItem('mcp-ide:onboarded', 'true');
    localStorage.setItem('i18nextLng', 'en');
    localStorage.removeItem('chatRightPanelId');
  });

  const readRenderMeasurement = () => page.evaluate<RenderMeasurement>(() => {
    const metrics = (window as Window & {
      __CSW_BASELINE__: { commits: number[]; mutationRecords: number };
    }).__CSW_BASELINE__;
    return { commits: metrics.commits.length, mutationRecords: metrics.mutationRecords };
  });

  const phases: Array<{
    name: string;
    durationMs: number;
    requests: number;
    responseBytes: number;
    commits: number;
    mutationRecords: number;
  }> = [];
  let phaseStartedAt = performance.now();
  let requestOffset = 0;
  let renderOffset: RenderMeasurement = { commits: 0, mutationRecords: 0 };
  const finishPhase = async (name: string) => {
    await page.waitForTimeout(500);
    await Promise.all(responseReads.splice(0));
    const render = await readRenderMeasurement();
    const phaseRequests = requests.slice(requestOffset);
    phases.push({
      name,
      durationMs: Number((performance.now() - phaseStartedAt).toFixed(1)),
      requests: phaseRequests.length,
      responseBytes: phaseRequests.reduce((sum, request) => sum + (request.bytes ?? 0), 0),
      commits: render.commits - renderOffset.commits,
      mutationRecords: render.mutationRecords - renderOffset.mutationRecords,
    });
    requestOffset = requests.length;
    renderOffset = render;
    phaseStartedAt = performance.now();
  };

  await page.goto('/#/global');
  const globalRows = page.getByRole('complementary').locator('[data-session-id]');
  await expect(globalRows.first()).toBeVisible();
  await finishPhase('global-list');

  currentPhase = 'open-session';
  const sessionId = await globalRows.first().getAttribute('data-session-id');
  expect(sessionId).toBeTruthy();
  await globalRows.first().click();
  const rail = page.locator('nav[aria-label="Session tools"]');
  await expect(rail).toBeVisible();
  await finishPhase('open-session');

  const labels = await rail.getByRole('button').evaluateAll((buttons) =>
    buttons.map((button) => button.getAttribute('aria-label')).filter((label): label is string => Boolean(label)),
  );
  for (const label of labels) {
    if (label === 'Snapshots') continue;
    currentPhase = `panel:${label}`;
    const button = rail.getByRole('button', { name: label, exact: true });
    await expect(button).toBeVisible();
    await button.click();
    await finishPhase(currentPhase);
  }

  const pushDiagnosticBurst = (firstSeq: number) => page.evaluate(async ({ id, start }) => {
    const workerLog = await import('/hooks/agent-stream/worker-log-store.ts');
    for (let offset = 0; offset < 500; offset += 1) {
      const seq = start + offset;
      workerLog.pushWorkerLog(id, {
        ts: Date.now(),
        event: 'worker_log',
        level: 'info',
        category: 'worker',
        message: `Synthetic S0 diagnostic event ${seq}`,
        data: { seq, fixture: 'csw-s0-render-baseline' },
      }, seq);
    }
  }, { id: sessionId!, start: firstSeq });

  currentPhase = 'burst:worker-log-closed';
  await pushDiagnosticBurst(10_000);
  await finishPhase(currentPhase);

  currentPhase = 'open-panel:Worker log';
  await rail.getByRole('button', { name: 'Worker log', exact: true }).click();
  await finishPhase(currentPhase);

  currentPhase = 'burst:worker-log-open';
  await pushDiagnosticBurst(10_500);
  await finishPhase(currentPhase);

  const artifact = {
    capturedAt: new Date().toISOString(),
    viewport: page.viewportSize(),
    phases,
    requests,
    pageErrors,
    blockedModifyingRequests,
  };
  await testInfo.attach('session-workbench-baseline.json', {
    body: Buffer.from(JSON.stringify(artifact, null, 2)),
    contentType: 'application/json',
  });
  console.log(`CSW_BASELINE ${JSON.stringify(artifact)}`);

  expect(blockedModifyingRequests.filter((request) =>
    request !== 'POST /api/admin/perf/renderer-freezes',
  )).toEqual([]);
  expect(pageErrors).toEqual([]);
});
