/**
 * Command-line heuristics for processes no registry can claim.
 *
 * The registries know about things the app spawned through its own managers,
 * but plenty of relevant processes are invisible to them: a terminal's
 * grandchildren (`npm run dev` → vite → esbuild), WinPTY's helper agents, the
 * `git` a watcher forked, and every LSP server — those are started inside the
 * lsp-worker isolate, and asking it for a label would mean an RPC on a route
 * that must stay synchronous.
 *
 * Pure and table-driven, so the cost of adding a binary is one row.
 */
import type { TaskKind } from './task-rows.js';

export interface ClassifiedTask {
  kind: TaskKind;
  label: string;
}

interface Rule {
  kind: TaskKind;
  test: RegExp;
  /** Derives the label; falls back to `fallback` when it returns nothing. */
  label?: (command: string, exe: string) => string | undefined;
  fallback: string;
}

const basename = (path: string): string => path.split(/[\\/]/).pop() ?? path;

/** Ordered — the first match wins, so specific rules precede generic ones. */
const RULES: Rule[] = [
  // Our own census collector, so it is never mistaken for a user's shell.
  {
    kind: 'helper',
    test: /powershell(\.exe)?["']?\s+.*-EncodedCommand/i,
    fallback: 'Process collector',
  },
  { kind: 'helper', test: /\b(winpty-agent|conhost)\.exe/i, fallback: 'Terminal helper' },
  {
    kind: 'git',
    test: /(^|[\\/"'\s])git(\.exe)?["']?\s/i,
    label: (command) => {
      const sub = /(?:^|[\\/"'\s])git(?:\.exe)?["']?\s+((?:--\S+\s+)*)([a-z][\w-]*)/i.exec(command);
      return sub?.[2] ? `git ${sub[2]}` : undefined;
    },
    fallback: 'git',
  },
  {
    kind: 'lsp',
    test: /(intelephense|pylsp|pyright|gopls|rust-analyzer|clangd|omnisharp|jdtls|[\w-]*language[-_]?server|\blsp\b|--stdio)/i,
    label: (command, exe) => {
      const known = /(intelephense|pylsp|pyright|gopls|rust-analyzer|clangd|omnisharp|jdtls|[\w-]*language[-_]?server)/i
        .exec(command);
      return `LSP: ${known?.[1] ?? basename(exe)}`;
    },
    fallback: 'LSP server',
  },
  {
    kind: 'devserver',
    test: /(\bvite\b|next\s+dev|nuxt\s+dev|webpack(-dev-server|\s+serve)|ng\s+serve|astro\s+dev|remix\s+dev)/i,
    label: (command) => {
      const tool = /(vite|next|nuxt|webpack|ng|astro|remix)/i.exec(command)?.[1];
      return tool ? `${tool[0]!.toUpperCase()}${tool.slice(1)} dev server` : undefined;
    },
    fallback: 'Dev server',
  },
  {
    kind: 'helper',
    test: /(esbuild|rollup|swc|turbopack|tsc(\.js)?\s+.*--watch|nodemon)/i,
    label: (command) => {
      const tool = /(esbuild|rollup|swc|turbopack|nodemon|tsc)/i.exec(command)?.[1];
      return tool ? `Build helper: ${tool}` : undefined;
    },
    fallback: 'Build helper',
  },
  { kind: 'sandbox', test: /\b(podman|podman-remote|docker)(\.exe)?\b/i, fallback: 'Container CLI' },
  {
    kind: 'runner',
    test: /\b(npm|pnpm|yarn|bun)(\.cmd|\.exe)?\s+(run|exec|dlx)\b/i,
    label: (command) => {
      const script = /\b(?:npm|pnpm|yarn|bun)(?:\.cmd|\.exe)?\s+(?:run|exec|dlx)\s+(\S+)/i
        .exec(command)?.[1];
      return script ? `Script: ${script}` : undefined;
    },
    fallback: 'Package script',
  },
];

/**
 * Classify a process from its executable and command line.
 * Returns null when nothing matches — the caller then falls back to the
 * executable name, which is still better than a wrong guess.
 */
export function classifyProcess(exe: string, command?: string): ClassifiedTask | null {
  const haystack = command && command.length > 0 ? command : exe;
  if (!haystack) return null;
  for (const rule of RULES) {
    if (!rule.test.test(haystack)) continue;
    return { kind: rule.kind, label: rule.label?.(haystack, exe) || rule.fallback };
  }
  return null;
}
