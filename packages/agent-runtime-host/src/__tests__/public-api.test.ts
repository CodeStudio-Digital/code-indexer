import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as publicApi from '../index.js';

describe('agent runtime host public API', () => {
  it('does not expose trusted handoff primitives', () => {
    expect(publicApi).not.toHaveProperty('handoffEstablishedAttemptChannel');
    expect(publicApi).not.toHaveProperty('OutboundHeaderAuthority');
    expect(publicApi).not.toHaveProperty('AttemptFrameReceiver');
    expect(publicApi).not.toHaveProperty('HostLaunchAuthority');
    expect(publicApi).not.toHaveProperty('HostBootstrapAttemptChannel');
    expect(publicApi).not.toHaveProperty('EstablishedAttemptChannel');
    expect(publicApi).not.toHaveProperty('DelimitedByteChannel');
    expect(publicApi).not.toHaveProperty('HostAttemptLifecycleDriver');
    expect(publicApi).not.toHaveProperty('HostLifecycleLaunchAuthority');
    expect(publicApi).not.toHaveProperty('HostLifecycleLaunchBinding');
    expect(publicApi).not.toHaveProperty('PreparedAttemptReceipt');
    expect(publicApi).not.toHaveProperty('ActiveAttemptReceipt');
    expect(publicApi).not.toHaveProperty('ActiveAttemptAuthorityHandle');
    expect(publicApi).not.toHaveProperty('encodeManagementFrame');
    expect(publicApi).not.toHaveProperty('HostSupervisorManagementBootstrap');
    expect(publicApi).not.toHaveProperty('HostSupervisorLaunchCapability');
    expect(publicApi).not.toHaveProperty('HostSupervisorFactDriver');
    expect(publicApi).not.toHaveProperty('RustHostAttemptCoordinator');
    expect(publicApi).not.toHaveProperty(
      'ShadowAuthenticatedAttemptControlAdapter',
    );
    expect(publicApi).not.toHaveProperty(
      'ownProtectedAttemptControlEndpoint',
    );
    expect(publicApi).not.toHaveProperty(
      'ownAuthenticatedAttemptControlConnection',
    );
    expect(publicApi).not.toHaveProperty(
      'createHostSupervisorFactDriverForTesting',
    );
    expect(publicApi).not.toHaveProperty('semanticSha256');
  });

  it('does not permit wildcard subpath imports', async () => {
    const packagePath = fileURLToPath(
      new URL('../../package.json', import.meta.url),
    );
    const tsconfigPath = fileURLToPath(
      new URL('../../../../tsconfig.base.json', import.meta.url),
    );
    const manifest = JSON.parse(await readFile(packagePath, 'utf8')) as {
      exports?: Record<string, unknown>;
    };
    const tsconfig = JSON.parse(await readFile(tsconfigPath, 'utf8')) as {
      compilerOptions?: { paths?: Record<string, unknown> };
    };

    expect(manifest.exports).toEqual({ '.': './src/index.ts' });
    expect(tsconfig.compilerOptions?.paths).not.toHaveProperty(
      '@mcp/agent-runtime-host/*',
    );
  });
});
