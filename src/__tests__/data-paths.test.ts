import { describe, it, expect, afterEach } from 'vitest';
import { join, resolve } from 'node:path';
import { mcpDataDir } from '@mcp/shared/utils/config.js';
import {
  virtualProjectsBaseDir,
  virtualProjectDir,
  globalWorkspaceDir,
  designSystemUploadsDir,
  designSystemMcpDir,
  verdaccioStorageDir,
} from '@mcp/shared/utils/data-paths.js';

const SESSION_ID = '00000000-0000-4000-8000-000000000042';
const OTHER_SESSION_ID = '00000000-0000-4000-8000-000000000043';

describe('data-paths', () => {
  const saved = {
    MCP_DATA_DIR: process.env.MCP_DATA_DIR,
    MCP_SANDBOX_WORKDIR_HOST_DIR: process.env.MCP_SANDBOX_WORKDIR_HOST_DIR,
  };
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('composes each subdir under mcpDataDir by default', () => {
    delete process.env.MCP_DATA_DIR;
    delete process.env.MCP_SANDBOX_WORKDIR_HOST_DIR;
    const base = mcpDataDir();
    expect(virtualProjectsBaseDir()).toBe(join(base, 'virtual-projects'));
    expect(virtualProjectDir(SESSION_ID)).toBe(join(base, 'virtual-projects', SESSION_ID));
    expect(globalWorkspaceDir(SESSION_ID)).toBe(join(base, 'global-workspaces', SESSION_ID));
    expect(designSystemUploadsDir()).toBe(join(base, 'design-system-uploads'));
    expect(designSystemMcpDir()).toBe(join(base, 'design-system-mcp'));
    expect(verdaccioStorageDir()).toBe(join(base, 'packages'));
  });

  it('honors MCP_DATA_DIR for all subdirs', () => {
    process.env.MCP_DATA_DIR = process.platform === 'win32' ? 'D:\\d' : '/d';
    delete process.env.MCP_SANDBOX_WORKDIR_HOST_DIR;
    const base = mcpDataDir();
    expect(verdaccioStorageDir()).toBe(join(base, 'packages'));
    expect(virtualProjectDir(OTHER_SESSION_ID)).toBe(
      join(base, 'virtual-projects', OTHER_SESSION_ID),
    );
  });

  it('honors MCP_SANDBOX_WORKDIR_HOST_DIR override for virtual projects', () => {
    const override = process.platform === 'win32' ? 'E:\\sb' : '/sb';
    process.env.MCP_SANDBOX_WORKDIR_HOST_DIR = override;
    expect(virtualProjectsBaseDir()).toBe(resolve(override));
    expect(virtualProjectDir(SESSION_ID)).toBe(join(resolve(override), SESSION_ID));
  });

  it('normalizes UUID case and rejects legacy numeric session ids', () => {
    const uppercaseId = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
    expect(virtualProjectDir(uppercaseId)).toBe(
      join(virtualProjectsBaseDir(), uppercaseId.toLowerCase()),
    );
    expect(() => virtualProjectDir(42 as unknown as string)).toThrow(/canonical UUID/);
    expect(() => globalWorkspaceDir('42')).toThrow(/canonical UUID/);
  });
});
