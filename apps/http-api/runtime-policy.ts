import type {
  ResolvedRuntimePolicyV1,
  RuntimePolicyLayerV1,
} from '@mcp/agent-runtime-contracts';
import {
  LEGACY_RUNTIME_POLICY_ENV_KEYS,
  legacyRuntimePolicyLayerFromEnv,
  resolveRuntimePolicyV1,
} from '@mcp/agent-runtime-host';
import { AppSettingsStore, inheritedSettingsEnv } from '@mcp/store/app-settings-store.js';

export function resolveAppRuntimePolicy(
  dbPath: string,
  options: {
    env?: Readonly<Record<string, string | undefined>>;
    resolvedAt?: string;
    updates?: Readonly<Record<string, string | null>>;
  } = {},
): ResolvedRuntimePolicyV1 {
  const env = { ...(options.env ?? inheritedSettingsEnv()) };
  const operatorEnv: Record<string, string> = {};
  const operatorRevisions: string[] = [];
  const store = new AppSettingsStore(dbPath);
  try {
    for (const key of LEGACY_RUNTIME_POLICY_ENV_KEYS) {
      if (options.updates && Object.prototype.hasOwnProperty.call(options.updates, key)) {
        const value = options.updates[key];
        if (value !== null) {
          delete env[key];
          operatorEnv[key] = value;
          operatorRevisions.push(`${key}@pending`);
        }
        continue;
      }
      const setting = store.resolve(key);
      if (setting?.source !== 'db') continue;
      if (setting.effectiveValue == null) continue;
      delete env[key];
      operatorEnv[key] = setting.effectiveValue;
      operatorRevisions.push(`${key}@${setting.updatedAt ?? 'unknown'}`);
    }
  } finally {
    store.close();
  }

  const deployment = legacyRuntimePolicyLayerFromEnv(env, {
    revision: 'process-env-at-attempt-start',
    strict: true,
  }).layer;
  const operatorValues = legacyRuntimePolicyLayerFromEnv(operatorEnv, {
    revision: operatorRevisions.sort().join(',') || 'operator-db',
    strict: true,
  }).layer?.values;
  const operator: RuntimePolicyLayerV1 | undefined = operatorValues
    ? { revision: operatorRevisions.sort().join(','), values: operatorValues }
    : undefined;
  return resolveRuntimePolicyV1({
    deployment,
    operator,
    resolvedAt: options.resolvedAt,
  });
}

const APP_RUNTIME_POLICY_MIGRATED_ENV_KEYS = LEGACY_RUNTIME_POLICY_ENV_KEYS;
