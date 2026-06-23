/**
 * Deterministic fallback rules — produce a `SynthesizedCommand` from a
 * `ManifestInfo` without calling the general AI. Used when:
 *   - The operator hasn't configured general AI (no 412 needed).
 *   - The user opts out of AI synthesis.
 *   - The AI call fails (timeout, invalid JSON, banned output).
 *
 * Rules are intentionally conservative — we bias toward "works most of
 * the time for common stacks" over "works for every esoteric setup".
 * Every rule emits a program from `ALLOWED_PROGRAMS` and a flag set
 * that passes `validateArgv`; a unit test guards this invariant.
 *
 * Port handling:
 *   - Node scripts: set `PORT` env var. Most Vite/CRA/Next configs
 *     honor it. Projects that hardcode the port will fail the readiness
 *     probe, which is the explicit decision documented in the plan.
 *   - Python: pass `--port` to uvicorn/gunicorn/django runserver.
 *   - Go / Rust: set `PORT` env var. The project must read it.
 *   - Ruby: Rails accepts `-p`; Sinatra via `PORT` env var.
 */

import type { ManifestInfo } from '../manifest-detector/types.js';
import type { SynthesizedCommand } from './types.js';

export function fallbackCommand(manifest: ManifestInfo, port: number): SynthesizedCommand {
  switch (manifest.kind) {
    case 'node':
      return nodeFallback(manifest, port);
    case 'python':
      return pythonFallback(manifest, port);
    case 'go':
      return goFallback(manifest, port);
    case 'rust':
      return rustFallback(manifest, port);
    case 'ruby':
      return rubyFallback(manifest, port);
  }
}

function nodeFallback(
  m: Extract<ManifestInfo, { kind: 'node' }>,
  port: number,
): SynthesizedCommand {
  // Intentionally always pick `npm` — it ships with Node, so ENOENT is
  // impossible on any machine that can run the dev-server anyway. yarn
  // and pnpm are detected in `packageManager` for display purposes, but
  // using them here creates ENOENT errors on machines that don't have
  // them installed. Users who need yarn/pnpm-specific lifecycle hooks
  // can toggle "Use AI to port command" — the AI is free to pick yarn
  // or pnpm if the manifest clearly needs it.
  const script = m.devScriptName ?? 'dev';
  const args = ['run', script];
  return {
    program: 'npm',
    args,
    env: { PORT: String(port), HOST: '127.0.0.1' },
    readyProbe: { kind: 'http', path: '/' },
    rationale:
      m.devScriptName
        ? `Runs 'npm run ${m.devScriptName}' with PORT=${port}` +
          (m.packageManager !== 'npm'
            ? ` (manifest suggests ${m.packageManager}; toggle AI for that).`
            : '.')
        : `No dev/start/serve script; trying 'npm run dev' with PORT=${port}.`,
  };
}

function pythonFallback(
  m: Extract<ManifestInfo, { kind: 'python' }>,
  port: number,
): SynthesizedCommand {
  const entry = m.entry ?? 'main:app';
  if (m.framework === 'django') {
    return {
      program: 'python',
      args: ['manage.py', 'runserver', `127.0.0.1:${port}`],
      env: {},
      readyProbe: { kind: 'http', path: '/' },
      rationale: `Runs 'python manage.py runserver 127.0.0.1:${port}' for Django.`,
    };
  }
  if (m.framework === 'flask') {
    return {
      program: 'flask',
      args: ['run', '--host', '127.0.0.1', '--port', String(port)],
      env: {},
      readyProbe: { kind: 'http', path: '/' },
      rationale: `Runs 'flask run --host 127.0.0.1 --port ${port}'.`,
    };
  }
  // Default (fastapi / unknown) → uvicorn. Works for any ASGI app.
  return {
    program: 'uvicorn',
    args: [entry, '--host', '127.0.0.1', '--port', String(port)],
    env: {},
    readyProbe: { kind: 'http', path: '/' },
    rationale: `Runs 'uvicorn ${entry} --host 127.0.0.1 --port ${port}'.`,
  };
}

function goFallback(
  _m: Extract<ManifestInfo, { kind: 'go' }>,
  port: number,
): SynthesizedCommand {
  return {
    program: 'go',
    args: ['run', '.'],
    env: { PORT: String(port), HOST: '127.0.0.1' },
    readyProbe: { kind: 'http', path: '/' },
    rationale: `Runs 'go run .' with PORT=${port}; project must read PORT.`,
  };
}

function rustFallback(
  m: Extract<ManifestInfo, { kind: 'rust' }>,
  port: number,
): SynthesizedCommand {
  const args = ['run'];
  if (m.binaries.length === 1) {
    args.push('--bin', m.binaries[0]);
  }
  return {
    program: 'cargo',
    args,
    env: { PORT: String(port), HOST: '127.0.0.1' },
    readyProbe: { kind: 'http', path: '/' },
    rationale: `Runs 'cargo ${args.join(' ')}' with PORT=${port}.`,
  };
}

function rubyFallback(
  m: Extract<ManifestInfo, { kind: 'ruby' }>,
  port: number,
): SynthesizedCommand {
  if (m.framework === 'rails') {
    return {
      program: 'bundle',
      args: ['exec', 'rails', 'server', '-b', '127.0.0.1', '-p', String(port)],
      env: {},
      readyProbe: { kind: 'http', path: '/' },
      rationale: `Runs 'bundle exec rails server -b 127.0.0.1 -p ${port}'.`,
    };
  }
  if (m.framework === 'sinatra') {
    return {
      program: 'bundle',
      args: ['exec', 'ruby', 'app.rb'],
      env: { PORT: String(port), HOST: '127.0.0.1' },
      readyProbe: { kind: 'http', path: '/' },
      rationale: `Runs 'bundle exec ruby app.rb' with PORT=${port}.`,
    };
  }
  return {
    program: 'bundle',
    args: ['exec', 'ruby', 'app.rb'],
    env: { PORT: String(port), HOST: '127.0.0.1' },
    readyProbe: { kind: 'http', path: '/' },
    rationale: `Runs 'bundle exec ruby app.rb' with PORT=${port} (framework unknown).`,
  };
}
