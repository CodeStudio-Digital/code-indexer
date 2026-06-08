import { describe, it, expect, afterEach } from 'vitest';
import { join, resolve } from 'node:path';
import { mcpDataDir } from '@mcp/shared/utils/config.js';
import {
  virtualProjectsBaseDir,
  virtualProjectDir,
  designSystemUploadsDir,
  designSystemMcpDir,
  sandboxArchiveDir,
  verdaccioStorageDir,
  qaReportsDir,
} from '@mcp/shared/utils/data-paths.js';

describe('data-paths', () => {
  const saved = {
    MCP_DATA_DIR: process.env.MCP_DATA_DIR,
    MCP_SANDBOX_WORKDIR_HOST_DIR: process.env.MCP_SANDBOX_WORKDIR_HOST_DIR,
    MCP_SANDBOX_ARCHIVE_DIR: process.env.MCP_SANDBOX_ARCHIVE_DIR,
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
    delete process.env.MCP_SANDBOX_ARCHIVE_DIR;
    const base = mcpDataDir();
    expect(virtualProjectsBaseDir()).toBe(join(base, 'virtual-projects'));
    expect(virtualProjectDir('abc')).toBe(join(base, 'virtual-projects', 'abc'));
    expect(virtualProjectDir(42)).toBe(join(base, 'virtual-projects', '42'));
    expect(designSystemUploadsDir()).toBe(join(base, 'design-system-uploads'));
    expect(designSystemMcpDir()).toBe(join(base, 'design-system-mcp'));
    expect(sandboxArchiveDir()).toBe(join(base, 'sandboxes'));
    expect(verdaccioStorageDir()).toBe(join(base, 'packages'));
    expect(qaReportsDir()).toBe(join(base, 'qa-reports'));
  });

  it('honors MCP_DATA_DIR for all subdirs', () => {
    process.env.MCP_DATA_DIR = process.platform === 'win32' ? 'D:\\d' : '/d';
    delete process.env.MCP_SANDBOX_WORKDIR_HOST_DIR;
    delete process.env.MCP_SANDBOX_ARCHIVE_DIR;
    const base = mcpDataDir();
    expect(verdaccioStorageDir()).toBe(join(base, 'packages'));
    expect(virtualProjectDir('x')).toBe(join(base, 'virtual-projects', 'x'));
  });

  it('honors MCP_SANDBOX_WORKDIR_HOST_DIR override for virtual projects', () => {
    const override = process.platform === 'win32' ? 'E:\\sb' : '/sb';
    process.env.MCP_SANDBOX_WORKDIR_HOST_DIR = override;
    expect(virtualProjectsBaseDir()).toBe(resolve(override));
    expect(virtualProjectDir('s1')).toBe(join(resolve(override), 's1'));
  });

  it('honors MCP_SANDBOX_ARCHIVE_DIR override for archives', () => {
    const override = process.platform === 'win32' ? 'E:\\arch' : '/arch';
    process.env.MCP_SANDBOX_ARCHIVE_DIR = override;
    expect(sandboxArchiveDir()).toBe(resolve(override));
  });
});
