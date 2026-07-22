import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import {
  contributeDebugger,
  defineDebugAdapter,
  definePlugin,
  type DebugConfigurationInput,
} from '@mcp/plugin-sdk/define.js';

const PORT_TOKEN = '__MCP_DEBUG_PORT__';
const DEFAULT_WRANGLER_INSPECTOR_PORT = 9229;
const WRANGLER_CONFIG_FILES = ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'] as const;

function forwardedPackageArguments(manager: string, args: string[]): string[] {
  if (args.length === 0) return [];
  return ['npm', 'pnpm'].includes(manager.toLowerCase()) ? ['--', ...args] : args;
}

function packageRunnerArgs(input: DebugConfigurationInput, debugArgs: string[] = []): string[] | null {
  const runner = input.runner;
  if (!runner) return null;
  const args = [...(runner.args ?? []), ...debugArgs];
  if (runner.script) return ['run', runner.script, ...forwardedPackageArguments(runner.manager, args)];
  return args;
}

function packageScriptCommand(input: DebugConfigurationInput, cwd: string): string | null {
  if (input.runner?.script) {
    try {
      const manifest = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')) as {
        scripts?: Record<string, unknown>;
      };
      const command = manifest.scripts?.[input.runner.script];
      if (typeof command === 'string') return command;
    } catch {
      // A plugin-contributed raw command can still be inspected below.
    }
  }
  return input.runner?.command ?? null;
}

function explicitWranglerInspectorPort(command: string): number | null {
  const explicitPort = command.match(/--inspector-port(?:\s+|=)(\d{1,5})(?:\s|$)/i)?.[1];
  if (!explicitPort) return null;
  const port = Number(explicitPort);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
}

function wranglerCommandHasScript(command: string): boolean {
  return /(?:^|[;&|]\s*|\s)(?:npx\s+)?wrangler(?:\.cmd)?\s+dev\s+(?!-)(?:"[^"]+"|'[^']+'|[^\s;&|]+)/i.test(command);
}

function configuredWranglerEntry(cwd: string): string | null {
  for (const fileName of WRANGLER_CONFIG_FILES) {
    const configPath = join(cwd, fileName);
    if (!existsSync(configPath)) continue;
    try {
      const source = readFileSync(configPath, 'utf8');
      let main: string | null = null;
      if (fileName.endsWith('.toml')) {
        const value = /^\s*main\s*=\s*("(?:\\.|[^"\\])*"|'[^']*')/m.exec(source)?.[1];
        if (value) main = value.startsWith('"') ? JSON.parse(value) as string : value.slice(1, -1);
      } else {
        const value = /"main"\s*:\s*("(?:\\.|[^"\\])*")/.exec(source)?.[1];
        if (value) main = JSON.parse(value) as string;
      }
      if (main) return resolve(dirname(configPath), main);
    } catch {
      // Wrangler will report malformed configuration with its richer diagnostics.
    }
  }
  return null;
}

export function wranglerDebugWrapperSource(entrySpecifier: string): string {
  return [
    `import worker from ${JSON.stringify(entrySpecifier)};`,
    `export * from ${JSON.stringify(entrySpecifier)};`,
    'let primed = false;',
    'function primeDebugger() { if (!primed) { primed = true; debugger; } }',
    'const handlerNames = ["fetch", "scheduled", "queue", "email", "tail", "trace", "alarm", "test"];',
    'const wrapped = typeof worker === "function" ? class extends worker {} : { ...worker };',
    'const owner = typeof worker === "function" ? worker.prototype : worker;',
    'const destination = typeof worker === "function" ? wrapped.prototype : wrapped;',
    'for (const name of handlerNames) {',
    '  const handler = owner?.[name];',
    '  if (typeof handler !== "function") continue;',
    '  Object.defineProperty(destination, name, { configurable: true, value: function (...args) {',
    '    primeDebugger();',
    '    return handler.apply(typeof worker === "function" ? this : worker, args);',
    '  } });',
    '}',
    'export default wrapped;',
    '',
  ].join('\n');
}

function wranglerDebugWrapper(cwd: string, inspectorPort: number, command: string) {
  if (wranglerCommandHasScript(command)) return null;
  const entry = configuredWranglerEntry(cwd);
  if (!entry) return null;
  const path = join(cwd, `.mcp-wrangler-debug-${inspectorPort}.mjs`);
  let entrySpecifier = relative(dirname(path), entry).replace(/\\/g, '/');
  if (!entrySpecifier.startsWith('.')) entrySpecifier = `./${entrySpecifier}`;
  return { path, content: wranglerDebugWrapperSource(entrySpecifier) };
}

export function wranglerInspectorPort(
  command: string | null | undefined,
  allocatedPort = DEFAULT_WRANGLER_INSPECTOR_PORT,
): number | null {
  if (!command || !/(?:^|[;&|]\s*|\s)(?:npx\s+)?wrangler(?:\.cmd)?\s+dev(?:\s|$)/i.test(command)) return null;
  return explicitWranglerInspectorPort(command) ?? allocatedPort;
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
        // Wrangler hosts application code in Workerd, not in the package
        // manager's Node process. Keep those lifecycles separate: the MCP host
        // owns `wrangler dev`, and js-debug performs a regular Inspector attach.
        const scriptCommand = packageScriptCommand(input, cwd);
        const explicitInspectorPort = scriptCommand ? explicitWranglerInspectorPort(scriptCommand) : null;
        const inspectorPort = wranglerInspectorPort(scriptCommand, input.targetPort ?? DEFAULT_WRANGLER_INSPECTOR_PORT);
        const wrapper = inspectorPort === null || !scriptCommand
          ? null
          : wranglerDebugWrapper(cwd, inspectorPort, scriptCommand);
        const debugArgs = inspectorPort === null
          ? []
          : [
              ...(explicitInspectorPort === null ? [`--inspector-port=${inspectorPort}`] : []),
              ...(wrapper ? [wrapper.path] : []),
            ];
        const runtimeArgs = packageRunnerArgs(input, debugArgs);

        if (inspectorPort !== null) {
          // Match the plain Node attach shape used by Wrangler tooling. The
          // generic launch/source-map knobs above are intentionally omitted:
          // Workerd publishes its own script/source-map metadata over CDP.
          const configuration: Record<string, unknown> = {
            // VS Code normalizes `node` to `pwa-node` before invoking this
            // standalone adapter; MCP talks to the adapter directly.
            type: 'pwa-node',
            request: 'attach',
            name: base.name,
            port: inspectorPort,
            cwd: '/',
            sourceMaps: true,
            // Workerd publishes the original TypeScript source map when the
            // first request loads the Worker script. Keep that script paused
            // long enough for js-debug to bind the original-source breakpoint.
            pauseForSourceMap: true,
            ...(wrapper ? { mcpPrimeOnFirstDebuggerStatement: true } : {}),
            attachExistingChildren: false,
            autoAttachChildProcesses: false,
            resolveSourceMapLocations: null,
            ...(input.configuration ?? {}),
          };
          // Process ownership and connection details are a single contract;
          // do not let a loose override desynchronise the launched port.
          configuration.request = 'attach';
          configuration.port = inspectorPort;
          configuration.cwd = '/';
          return {
            dapRequest: 'attach',
            configuration,
            target: {
              command: input.runner.executable ?? input.runner.manager,
              args: runtimeArgs ?? [],
              cwd,
              env: { ...(input.runner.env ?? {}), ...(input.env ?? {}) },
              ...(wrapper ? { preparedFiles: [wrapper] } : {}),
              readyPattern: 'Ready on http://',
              readyTimeoutMs: 30_000,
            },
          };
        }

        base.runtimeExecutable = input.runner.executable ?? input.runner.manager;
        if (runtimeArgs?.length) base.runtimeArgs = runtimeArgs;
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
