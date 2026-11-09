/**
 * Cloudflare templates via the official `create-cloudflare` (C3). C3
 * scaffolds AND installs in one shot, so there's no separate install step.
 *
 *  - cf-worker     → plain TypeScript Worker (`--type=hello-world`)
 *  - opennext-cf   → Next.js on Workers, wired with @opennextjs/cloudflare
 *                    (`--framework=next`, the modern OpenNext path)
 *  - vite-react-cf → React + Vite on Workers (`--framework=react --variant=react-ts`)
 *
 * Flags verified against developers.cloudflare.com/pages/get-started/c3:
 * `-y` accepts defaults, `--no-deploy` skips the deploy prompt, `--no-git`
 * avoids needing a configured git identity on the host. The slug is the
 * positional directory passed after `--`.
 */
import { CLI_TIMEOUT_MS, type HostStep, type HostTemplate, type TemplateId } from './types.js';

function c3(slug: string, label: string, extra: string[]): HostStep[] {
  return [
    {
      phase: 'run-cli',
      program: 'npm',
      args: [
        'create',
        'cloudflare@latest',
        '--',
        slug,
        '-y',
        '--lang=ts',
        '--platform=workers',
        '--no-deploy',
        '--no-git',
        ...extra,
      ],
      cwd: 'parent',
      timeoutMs: CLI_TIMEOUT_MS,
      label,
    },
  ];
}

function c3Template(id: TemplateId, label: string, extra: string[]): HostTemplate {
  return {
    id,
    needsNetwork: true,
    createsTargetDir: false, // C3 creates the dir
    build: ({ slug }) => c3(slug, label, extra),
  };
}

export const cfWorkerTemplate = c3Template('cf-worker', 'create-cloudflare (worker)', ['--type=hello-world']);
export const openNextCfTemplate = c3Template('opennext-cf', 'create-cloudflare (Next/OpenNext)', ['--framework=next']);
// C3's React variant prompt does not use --lang or --accept-defaults.
// Select it explicitly: the wizard runs with stdin closed and cannot answer it.
export const viteReactCfTemplate = c3Template('vite-react-cf', 'create-cloudflare (React + Vite)', [
  '--framework=react', '--variant=react-ts',
]);
