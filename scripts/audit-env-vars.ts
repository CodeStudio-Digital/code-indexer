#!/usr/bin/env tsx
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { APP_SETTINGS } from '../packages/store/src/app-settings-catalog.js';
import { AppSettingsStore } from '../packages/store/src/app-settings-store.js';
import { loadConfig } from '../packages/shared/src/utils/config.js';
import { collectEnvReads } from './runtime-env-inventory/ast-collector.js';
import { classifyRuntimeEnv } from './runtime-env-inventory/disposition.js';
import { validateCodeRunRolloutManifest } from './runtime-env-inventory/rollout-manifest.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK_MODE = process.argv.includes('--check');
const ROOTS = ['apps', 'packages', 'src'] as const;
const REVIEW_BASELINE = 276;
const EXCLUDE_PREFIX = ['CLAUDE_CODE_', 'NODE_', 'npm_', 'VITE_', 'AWS_', 'GITHUB_ACTIONS'];
const EXCLUDE_EXACT = new Set([
  'NODE_ENV', 'CI', 'PATH', 'HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP', 'PWD', 'SHELL',
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'BRAVE_API_KEY',
  'PORT', 'DEBUG', 'FORCE_COLOR', 'TERM', 'COLORTERM', 'APPDATA', 'LOCALAPPDATA',
]);
const SENSITIVE = /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/;

function excluded(key: string): boolean {
  return EXCLUDE_EXACT.has(key) || EXCLUDE_PREFIX.some((prefix) => key.startsWith(prefix));
}

function redactedValue(key: string, value: string | null | undefined): string | null {
  if (value === undefined || value === null || value === '') return null;
  return SENSITIVE.test(key) ? '<redacted:set>' : value;
}

function localSettings(): Map<string, { stored: string | null; effective: string | null; source: string }> {
  const result = new Map<string, { stored: string | null; effective: string | null; source: string }>();
  try {
    const store = new AppSettingsStore(loadConfig().dbPath);
    try {
      for (const item of store.resolveAll()) {
        result.set(item.def.key, {
          stored: redactedValue(item.def.key, item.storedValue),
          effective: redactedValue(item.def.key, item.effectiveValue),
          source: item.source,
        });
      }
    } finally {
      store.close();
    }
  } catch {
    // A source-only CI checkout has no local DB; env/default evidence still works.
  }
  return result;
}

const { scannedFiles, hits, dynamicConsumers } = collectEnvReads(repoRoot, ROOTS);
const dynamicCodeRunConsumers = dynamicConsumers.filter((consumer) =>
  consumer.file.startsWith('packages/code-agent/src/')
  || consumer.file.startsWith('packages/services/src/services/task-preflight/')
  || consumer.file === 'apps/http-api/server/preflight-capability-catalog.ts'
);
const catalog = new Map(APP_SETTINGS.map((setting) => [setting.key, setting]));
const settings = localSettings();
const runtimeUnclassified: string[] = [];
const report = [...hits.values()].map((hit) => {
  const inferredType = Object.entries(hit.votes)
    .sort((left, right) => right[1] - left[1])[0]?.[0] ?? 'string';
  const setting = catalog.get(hit.key);
  const local = settings.get(hit.key);
  const looksDebug = /_(?:DEBUG|VERBOSE|TRACE)$|_LOG/.test(hit.key);
  const tier = setting ? 'cataloged' : excluded(hit.key) ? 'excluded' : looksDebug ? 'tier3-debug' : 'review';
  const disposition = classifyRuntimeEnv(hit.key);
  if ((hit.key.startsWith('CODER_') || hit.key.startsWith('MCP_PIPELINES_')) && !disposition) {
    runtimeUnclassified.push(hit.key);
  }
  return {
    key: hit.key,
    prefix: hit.key.split('_')[0],
    inferredType,
    enums: [...hit.enums].sort(),
    usageCount: hit.consumers.length,
    consumers: hit.consumers,
    inCatalog: !!setting,
    catalogDefault: redactedValue(hit.key, setting?.default),
    rawDbValue: local?.stored ?? null,
    inheritedEnvValue: redactedValue(hit.key, process.env[hit.key]),
    effectiveValue: local?.effective ?? redactedValue(hit.key, process.env[hit.key] ?? setting?.default),
    effectiveSource: local?.source ?? (process.env[hit.key] ? 'env' : setting?.default !== undefined ? 'default' : 'consumer_fallback'),
    tier,
    runtimeDisposition: disposition,
  };
}).sort((left, right) => left.key.localeCompare(right.key));

const review = report.filter((item) => item.tier === 'review').length;
const cataloged = report.filter((item) => item.inCatalog).length;
const excludedCount = report.filter((item) => item.tier === 'excluded').length;
const runtime = report.filter((item) => item.runtimeDisposition);
const rolloutValidation = validateCodeRunRolloutManifest(
  runtime
    .filter((item) => item.runtimeDisposition?.disposition === 'ROLLOUT_TEMP')
    .map((item) => item.key),
);
const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { version: string };
const artifact = {
  schemaVersion: 2,
  generatedAt: new Date().toISOString(),
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim(),
  build: packageJson.version,
  host: hostname(),
  scannedFiles,
  runtimeClassificationCoverage: {
    classified: runtime.length,
    unclassified: runtimeUnclassified,
    dynamicCodeRunConsumers,
  },
  rolloutManifest: rolloutValidation,
  report,
};
const outDir = join(repoRoot, 'scripts', '.audit');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'env-vars.json'), `${JSON.stringify(artifact, null, 2)}\n`);

console.log(`[audit-env-vars] AST scanned ${scannedFiles} files, ${report.length} distinct env reads`);
console.log(`  cataloged: ${cataloged}; excluded: ${excludedCount}; review: ${review}`);
console.log(`  code-run disposition: ${runtime.length} classified, ${runtimeUnclassified.length} unclassified`);
console.log(`  code-run dynamic env access: ${dynamicCodeRunConsumers.length}`);
console.log(`  rollout manifest: ${rolloutValidation.ok ? 'valid' : 'INVALID'}`);
console.log('  full redacted snapshot -> scripts/.audit/env-vars.json');

if (CHECK_MODE && (
  review > REVIEW_BASELINE
  || runtimeUnclassified.length > 0
  || dynamicCodeRunConsumers.length > 0
  || !rolloutValidation.ok
)) {
  if (review > REVIEW_BASELINE) console.error(`env review drift: ${review} > ${REVIEW_BASELINE}`);
  if (runtimeUnclassified.length > 0) console.error(`unclassified code-run env: ${runtimeUnclassified.join(', ')}`);
  if (dynamicCodeRunConsumers.length > 0) {
    console.error(`dynamic code-run env access: ${dynamicCodeRunConsumers.map((item) => `${item.file}:${item.line}`).join(', ')}`);
  }
  if (!rolloutValidation.ok) console.error(`rollout manifest invalid: ${JSON.stringify(rolloutValidation)}`);
  process.exit(1);
}
