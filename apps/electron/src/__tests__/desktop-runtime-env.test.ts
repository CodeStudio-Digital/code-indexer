import { describe, expect, it } from 'vitest';
import { projectDbFlags } from '@mcp/shared/utils/config.js';
import { applyDesktopRuntimeEnvDefaults } from '../desktop-runtime-env.js';

describe('applyDesktopRuntimeEnvDefaults', () => {
  it('keeps project DB routing enabled when the packaged app has no repository .env', () => {
    const env: NodeJS.ProcessEnv = {};

    applyDesktopRuntimeEnvDefaults(env);

    expect(projectDbFlags(env)).toMatchObject({
      enabled: true,
      splitIndex: true,
      route: true,
    });
  });

  it('preserves explicit operator kill switches', () => {
    const env: NodeJS.ProcessEnv = {
      MCP_PROJECT_DB: '0',
      MCP_PROJECT_DB_SPLIT: '0',
      MCP_PROJECT_DB_ROUTE: '0',
    };

    applyDesktopRuntimeEnvDefaults(env);

    expect(env).toMatchObject({
      MCP_PROJECT_DB: '0',
      MCP_PROJECT_DB_SPLIT: '0',
      MCP_PROJECT_DB_ROUTE: '0',
    });
    expect(projectDbFlags(env)).toMatchObject({
      enabled: false,
      splitIndex: false,
      route: false,
    });
  });
});
