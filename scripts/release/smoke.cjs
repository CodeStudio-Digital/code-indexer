/**
 * Runtime smoke probes for a PACKAGED build, executed under Electron itself.
 *
 * Static checks cannot see these: the renderer only fails to paint once the
 * real CSP + file:// origin are in play, and the indexer's wasm only fails to
 * load from inside a worker thread reading out of app.asar. Each probe below
 * corresponds to a bug that shipped at least once.
 *
 * Usage:  electron smoke.cjs <path-to-win-unpacked-resources>
 * Output: one JSON object on stdout, prefixed with SMOKE_RESULT:
 */
const { app, BrowserWindow, session, protocol } = require('electron');
const { Worker } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Writes to fd 1 SYNCHRONOUSLY. `process.stdout.write` is asynchronous when
 * stdout is a pipe (which it is when the parent captures output), and
 * `app.exit()` terminates the process immediately — the report would be lost
 * and the parent would see an empty result.
 */
function emit(report) {
  fs.writeSync(1, `SMOKE_RESULT:${JSON.stringify(report)}\n`);
}

const resourcesDir = process.argv[2];
const asar = path.join(resourcesDir, 'app.asar');
const indexHtml = path.join(asar, 'dist/dashboard/index.html');

// Mirrors apps/electron/src/security-hardening.ts. The renderer must paint
// under the SAME policy it ships with, or the check proves nothing.
const CSP = [
  "default-src 'self' mcp://app",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data: blob: mcp://app",
  "connect-src 'self' mcp://app http://localhost:* http://127.0.0.1:*",
  "worker-src 'self' blob:",
].join('; ');

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'mcp',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, bypassCSP: true, stream: true },
  },
]);

// Each probe destroys its window when done. Electron's default is to quit once
// the last window closes, which would end the run between probes — silently,
// with exit code 0 and no report. Keep the process alive; we exit explicitly.
app.on('window-all-closed', () => {});

/** Boot the real renderer document and report what actually painted. */
async function probeRenderer(hash) {
  const win = new BrowserWindow({ show: false, width: 1280, height: 800, webPreferences: { offscreen: true } });
  const consoleErrors = [];
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) consoleErrors.push(String(message).slice(0, 200));
  });
  try {
    await win.loadFile(indexHtml, hash ? { hash } : undefined);
  } catch (error) {
    win.destroy();
    return { ok: false, error: String(error.message || error).split('\n')[0] };
  }
  await new Promise((resolve) => setTimeout(resolve, 6000)); // let the SPA mount and route

  const result = await win.webContents.executeJavaScript(`(async () => {
    const loadImage = (src) => new Promise((res) => {
      const img = new Image();
      img.onload = () => res(img.naturalWidth > 0);
      img.onerror = () => res(false);
      img.src = src;
    });
    const root = document.getElementById('root');
    return {
      mounted: !!root && root.childElementCount > 0,
      children: root ? root.childElementCount : 0,
      title: document.title,
      href: location.href,
      hash: location.hash,
      // A pathname router under file:// rewrites location to the drive root on
      // mount, which silently breaks every relative URL resolved afterwards.
      locationIntact: location.href.includes('index.html'),
      relativeAssetLoads: await loadImage('./brand/logo-mark.svg'),
      imageProtocolLoads: await loadImage('mcp://app/api/_release/image'),
    };
  })()`);
  win.destroy();
  return { ok: result.mounted && result.locationIntact && result.relativeAssetLoads && result.imageProtocolLoads, ...result, consoleErrors };
}

/**
 * The indexer runs in a worker thread and loads tree-sitter's wasm by path.
 * Both the path resolution and reading a .wasm out of app.asar have broken
 * before, stalling indexing with no error surfaced to the UI.
 */
function probeIndexer() {
  const languages = `file:///${path.join(asar, 'dist/packages/indexer/src/indexer/tree-sitter/languages.js').split(path.sep).join('/')}`;
  const source = `
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      try {
        const m = await import(workerData.languages);
        await m.initTreeSitter();
        const parser = await m.createParser('tree-sitter-typescript.wasm');
        const tree = parser.parse('export const answer: number = 42;');
        parentPort.postMessage({ ok: tree.rootNode.type === 'program', rootType: tree.rootNode.type });
      } catch (e) {
        parentPort.postMessage({ ok: false, error: (e && e.message ? e.message : String(e)).split('\\n')[0] });
      }
    })();
  `;
  return new Promise((resolve) => {
    const worker = new Worker(source, { eval: true, workerData: { languages } });
    const done = (value) => { worker.terminate().catch(() => {}); resolve(value); };
    worker.on('message', done);
    worker.on('error', (e) => done({ ok: false, error: String(e.message).split('\n')[0] }));
    setTimeout(() => done({ ok: false, error: 'timed out' }), 30000);
  });
}

async function probeApiScripts() {
  try {
    const { runPreScript } = require(path.join(asar, 'dist/packages/services/src/api-client/script-runtime/index.js'));
    const variables = {};
    const result = await runPreScript({ source: 'pm.environment.set("probe", "42");', variables,
      request: { method: 'GET', url: '/', headers: {}, body: '' } });
    return { ok: !result.error && variables.probe === '42', error: result.error };
  } catch (cause) { return { ok: false, error: String(cause.message ?? cause) }; }
}

async function probeWebContent() {
  try {
    const { convertWebContent } = require(path.join(asar, 'dist/packages/code-agent/src/tools/web/content-worker.js'));
    const text = await convertWebContent('html', '<h1>Web probe</h1>');
    return { ok: text === '# Web probe' };
  } catch (cause) { return { ok: false, error: String(cause.message ?? cause) }; }
}

/** Native image decoding and the video executable must work outside the source tree. */
async function probeVision() {
  const os = require('node:os');
  const { execFileSync } = require('node:child_process');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codestudio-vision-probe-'));
  try {
    const { prepareVisionImage } = require(path.join(asar, 'dist/packages/services/src/services/docs/vision-image.js'));
    const preview = await prepareVisionImage(Buffer.from('<svg width="64" height="48"><rect width="64" height="48" fill="red"/></svg>'));
    const binary = require(path.join(asar, 'node_modules/ffmpeg-static')).replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
    execFileSync(binary, ['-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=64x48:d=1', '-y', path.join(directory, 'clip.mp4')], { timeout: 15000, windowsHide: true });
    const { viewVideo } = require(path.join(asar, 'dist/packages/code-agent/src/tools/view-video.js'));
    const frames = await viewVideo.handler({ path: 'clip.mp4', timestamps: [0] }, { cwd: directory });
    return { ok: preview.previewWidth === 64 && !frames.isError && frames.extraUserBlocks?.length === 1,
      imageWidth: preview.previewWidth, frameCount: frames.extraUserBlocks?.length ?? 0, error: frames.isError ? frames.content : undefined };
  } catch (cause) { return { ok: false, error: String(cause.message ?? cause) }; }
  finally {
    if (path.dirname(directory) === path.resolve(os.tmpdir()) && path.basename(directory).startsWith('codestudio-vision-probe-')) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
}

app.on('ready', async () => {
  // The renderer talks to the backend over mcp://; stub it so probes exercise
  // packaging, not backend availability.
  protocol.handle('mcp', async request => request.url.endsWith('/api/_release/image')
    ? new Response(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7WQAAAAASUVORK5CYII=', 'base64'), { headers: { 'content-type': 'image/png' } })
    : new Response('{}', { headers: { 'content-type': 'application/json' } }));
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [CSP] } });
  });

  const report = {};
  try {
    report.renderer = await probeRenderer(null);
    const deep = await probeRenderer('/popout/task-manager');
    report.deepLink = { ok: deep.hash === '#/popout/task-manager', hash: deep.hash };
    report.indexer = await probeIndexer();
    report.apiScripts = await probeApiScripts();
    report.webContent = await probeWebContent();
    report.vision = await probeVision();
  } catch (error) {
    report.harnessError = String(error.message || error).split('\n')[0];
  }
  emit(report);
  app.exit(0);
});

setTimeout(() => {
  emit({ harnessError: 'global timeout' });
  app.exit(1);
}, 120000).unref();
