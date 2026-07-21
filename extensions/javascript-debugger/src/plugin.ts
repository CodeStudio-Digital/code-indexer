import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  contributeDebugger,
  defineDebugAdapter,
  definePlugin,
  type DebugConfigurationInput,
} from '@mcp/plugin-sdk/define.js';

const PORT_TOKEN = '__MCP_DEBUG_PORT__';
const DEFAULT_WRANGLER_INSPECTOR_PORT = 9229;

function packageRunnerArgs(input: DebugConfigurationInput): string[] | null {
  const runner = input.runner;
  if (!runner) return null;
  const args = [...(runner.args ?? [])];
  if (runner.script) return ['run', runner.script, ...args];
  return args;
}

function packageScriptCommand(input: DebugConfigurationInput, cwd: string): string | null {
  if (!input.runner?.script) return null;
  try {
    const manifest = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')) as {
      scripts?: Record<string, unknown>;
    };
    const command = manifest.scripts?.[input.runner.script];
    return typeof command === 'string' ? command : null;
  } catch {
    return null;
  }
}

export function wranglerInspectorPort(command: string | null | undefined): number | null {
  if (!command || !/(?:^|[;&|]\s*|\s)(?:npx\s+)?wrangler(?:\.cmd)?\s+dev(?:\s|$)/i.test(command)) return null;
  const explicitPort = command.match(/--inspector-port(?:\s+|=)(\d{1,5})(?:\s|$)/i)?.[1];
  if (!explicitPort) return DEFAULT_WRANGLER_INSPECTOR_PORT;
  const port = Number(explicitPort);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : DEFAULT_WRANGLER_INSPECTOR_PORT;
}

export const debugAdapter = defineDebugAdapter({
  id: 'javascript',

  resolveAdapter(context) {
    return {
      command: context.nodePath,
      args: [
        join(context.pluginRoot, 'adapter', 'js-debug', 'src', 'dapDebugServer.js'),
        PORT_TOKEN,
        '127.0.0.1',
      ],
      cwd: context.pluginRoot,
      env: {
        DA_TEST_DISABLE_TELEMETRY: '1',
        // Inside the desktop main process `process.execPath` is electron.exe.
        // Electron only behaves as the Node runtime expected by js-debug when
        // this flag is present; plain node.exe safely ignores it.
        ELECTRON_RUN_AS_NODE: '1',
        // Do not let the desktop development loader (`--import tsx`) escape
        // into the separately installed adapter directory.
        NODE_OPTIONS: '',
        TSX_TSCONFIG_PATH: '',
      },
      transport: {
        kind: 'tcp',
        host: '127.0.0.1',
        portToken: PORT_TOKEN,
        connectTimeoutMs: 15_000,
      },
    };
  },

  resolveConfiguration(input) {
    const cwd = input.cwd ?? input.runner?.cwd ?? input.projectRoot;
    const base: Record<string, unknown> = {
      type: 'pwa-node',
      request: input.request,
      name: input.name ?? (input.request === 'attach' ? 'Attach JavaScript' : 'Debug JavaScript'),
      cwd,
      sourceMaps: true,
      skipFiles: ['<node_internals>/**'],
      smartStep: true,
      pauseForSourceMap: false,
      outputCapture: 'std',
      trace: false,
    };

    if (input.request === 'launch') {
      base.console = 'internalConsole';
      base.internalConsoleOptions = 'openOnSessionStart';
      // Package managers and modern dev runners immediately spawn the real
      // Node target. Follow those children so breakpoints reach application
      // code instead of remaining attached only to npm/pnpm/yarn/bun.
      base.autoAttachChildProcesses = true;
      if (input.env || input.runner?.env) base.env = { ...(input.runner?.env ?? {}), ...(input.env ?? {}) };

      if (input.runner) {
        base.runtimeExecutable = input.runner.executable ?? input.runner.manager;
        const runtimeArgs = packageRunnerArgs(input);
        if (runtimeArgs?.length) base.runtimeArgs = runtimeArgs;

        // Wrangler hosts application code in workerd, not in the npm process.
        // js-debug's simple-port launch starts the package script and then
        // connects to the Workerd Inspector exposed by `wrangler dev`.
        const inspectorPort = wranglerInspectorPort(packageScriptCommand(input, cwd));
        if (inspectorPort !== null) {
          base.attachSimplePort = inspectorPort;
          base.autoAttachChildProcesses = false;
          base.resolveSourceMapLocations = null;
        }
      } else {
        if (!input.file) throw new Error('JavaScript launch requires a file or runner');
        base.program = input.file;
        if (input.args?.length) base.args = input.args;
      }
    }

    return { ...base, ...(input.configuration ?? {}) };
  },
});

export default definePlugin({
  debuggers: [
    contributeDebugger({
      id: 'javascript',
      label: 'JavaScript / TypeScript',
      description: 'Debug Node.js, package scripts, TypeScript source maps and Electron processes.',
      languageIds: ['javascript', 'javascriptreact', 'typescript', 'typescriptreact'],
      filePatterns: ['*.js', '*.mjs', '*.cjs', '*.jsx', '*.ts', '*.mts', '*.cts', '*.tsx'],
      runnerManagers: ['node', 'npm', 'pnpm', 'yarn', 'bun'],
      supports: {
        launch: true,
        attach: true,
        conditionalBreakpoints: true,
        hitConditionalBreakpoints: true,
        logpoints: true,
        exceptionBreakpoints: true,
      },
      activation: {
        whenFiles: ['package.json', 'tsconfig.json', '*.js', '*.mjs', '*.cjs', '*.ts'],
        whenPackageDep: ['typescript', 'electron', 'vite', 'next'],
      },
    }),
  ],
});
