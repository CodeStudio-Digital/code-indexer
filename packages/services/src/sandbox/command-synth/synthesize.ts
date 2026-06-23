/**
 * AI-backed command synthesizer.
 *
 * Given a `ManifestInfo` and a target port, asks the operator-selected
 * general AI to produce a `SynthesizedCommand`. The AI is prompted for
 * strict JSON; the response is parsed via `extractFirstJson`, validated
 * by `validateArgv` (allowlist + banned flags), and returned. Any failure
 * in that pipeline drops through to the deterministic fallback.
 *
 * The AI is NEVER trusted. Its output is just a suggestion — the
 * allowlist/validator is the only thing that decides what runs.
 */

import { runGeneralAi, GeneralAiNotConfiguredError } from '../../ai-general/generalClient.js';
import { extractFirstJson } from '../../ai-general/extract-json.js';
import type { ManifestInfo } from '../manifest-detector/types.js';
import type { SynthesizedCommand, ReadinessProbe } from './types.js';
import { validateArgv } from './allowlist.js';
import { fallbackCommand } from './fallback-rules.js';

export interface SynthesizeOptions {
  /**
   * When false, skip the AI entirely and use the deterministic fallback.
   * Also forced when AI is not configured (avoids noisy 412s).
   */
  useAi?: boolean;
  signal?: AbortSignal;
}

export interface SynthesisResult {
  command: SynthesizedCommand;
  /** Which path was taken — useful for UI and test introspection. */
  source: 'ai' | 'fallback' | 'fallback-after-ai-failure';
  /** Set when `source='fallback-after-ai-failure'`. */
  aiFailureReason?: string;
}

/**
 * Synthesize a launch command for the given manifest + port. Always
 * returns a validated command (the fallback is itself validated).
 */
export async function synthesizeStartCommand(
  manifest: ManifestInfo,
  port: number,
  opts: SynthesizeOptions = {},
): Promise<SynthesisResult> {
  if (!opts.useAi) {
    return { command: fallbackCommand(manifest, port), source: 'fallback' };
  }

  let raw: string;
  try {
    raw = await runGeneralAi(buildPrompt(manifest, port), { signal: opts.signal });
  } catch (err) {
    if (err instanceof GeneralAiNotConfiguredError) {
      return { command: fallbackCommand(manifest, port), source: 'fallback' };
    }
    return {
      command: fallbackCommand(manifest, port),
      source: 'fallback-after-ai-failure',
      aiFailureReason: err instanceof Error ? err.message : String(err),
    };
  }

  const parsed = extractFirstJson(raw);
  const coerced = coerceAiResponse(parsed, port);
  if (!coerced.ok) {
    return {
      command: fallbackCommand(manifest, port),
      source: 'fallback-after-ai-failure',
      aiFailureReason: coerced.reason,
    };
  }
  const validation = validateArgv(coerced.command.program, coerced.command.args);
  if (!validation.ok) {
    return {
      command: fallbackCommand(manifest, port),
      source: 'fallback-after-ai-failure',
      aiFailureReason: `AI output rejected by allowlist: ${validation.reason}`,
    };
  }
  return { command: coerced.command, source: 'ai' };
}

function buildPrompt(manifest: ManifestInfo, port: number): string {
  const manifestSummary = summarizeManifest(manifest);
  return [
    'You port a project start command to a specific port. Respond with ONLY',
    'a single JSON object (no prose, no markdown fences). Shape:',
    '{',
    '  "program": string (one of: npm, npx, pnpm, yarn, node, python, python3,',
    '    uvicorn, flask, gunicorn, go, cargo, ruby, bundle, rails),',
    '  "args": string[] (argv, no shell metacharacters; no flags that accept',
    '    arbitrary code like -c, -e, --eval, --exec),',
    '  "env": { [key: string]: string },',
    '  "readyProbe": { "kind": "http", "path": string },',
    '  "rationale": string (one short sentence)',
    '}',
    '',
    `The server MUST listen on 127.0.0.1:${port}. You MUST NOT modify the`,
    "project's source or manifest. Inject the port via argv or env.",
    '',
    '--- MANIFEST SUMMARY ---',
    manifestSummary,
  ].join('\n');
}

function summarizeManifest(m: ManifestInfo): string {
  switch (m.kind) {
    case 'node':
      return [
        'kind: node',
        `packageManager: ${m.packageManager}`,
        `packageName: ${m.packageName ?? '(none)'}`,
        `devScriptName: ${m.devScriptName ?? '(none)'}`,
        'scripts:',
        ...Object.entries(m.scripts).map(([k, v]) => `  ${k}: ${v}`),
      ].join('\n');
    case 'python':
      return [
        'kind: python',
        `framework: ${m.framework}`,
        `entry: ${m.entry ?? '(none)'}`,
      ].join('\n');
    case 'go':
      return ['kind: go', `moduleName: ${m.moduleName}`, `hasMainGo: ${m.hasMainGo}`].join('\n');
    case 'rust':
      return [
        'kind: rust',
        `packageName: ${m.packageName}`,
        `binaries: ${m.binaries.length ? m.binaries.join(', ') : '(none — default target)'}`,
      ].join('\n');
    case 'ruby':
      return ['kind: ruby', `framework: ${m.framework}`].join('\n');
  }
}

type CoerceResult =
  | { ok: true; command: SynthesizedCommand }
  | { ok: false; reason: string };

/**
 * Coerce `unknown` (AI response) into a `SynthesizedCommand`. Returns
 * `{ ok: false }` on shape mismatch. We re-validate argv separately
 * so the error message points at the right failure mode.
 */
function coerceAiResponse(value: unknown, port: number): CoerceResult {
  if (!value || typeof value !== 'object') {
    return { ok: false, reason: 'AI response was not a JSON object' };
  }
  const v = value as Record<string, unknown>;
  if (typeof v.program !== 'string') {
    return { ok: false, reason: 'AI response missing string "program"' };
  }
  if (!Array.isArray(v.args) || !v.args.every((a) => typeof a === 'string')) {
    return { ok: false, reason: 'AI response "args" must be a string[]' };
  }
  const env = coerceStringRecord(v.env);
  if (env === null) {
    return { ok: false, reason: 'AI response "env" must be a Record<string, string>' };
  }
  const probe = coerceProbe(v.readyProbe);
  if (probe === null) {
    return { ok: false, reason: 'AI response "readyProbe" must be { kind:"http", path:string }' };
  }
  const rationale = typeof v.rationale === 'string' ? v.rationale : `ai port=${port}`;
  return {
    ok: true,
    command: {
      program: v.program,
      args: v.args as string[],
      env,
      readyProbe: probe,
      rationale,
    },
  };
}

function coerceStringRecord(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v !== 'string') return null;
    out[k] = v;
  }
  return out;
}

function coerceProbe(value: unknown): ReadinessProbe | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (v.kind !== 'http') return null;
  if (typeof v.path !== 'string' || !v.path.startsWith('/')) return null;
  return { kind: 'http', path: v.path };
}
