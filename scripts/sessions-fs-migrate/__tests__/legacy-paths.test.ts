import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { legacySandboxArchiveDir } from '../legacy-paths.js';

describe('legacy sandbox archive source', () => {
  it('defaults below the selected migration data dir', () => {
    const dataDir = process.platform === 'win32' ? 'D:\\legacy-data' : '/legacy-data';
    expect(legacySandboxArchiveDir(dataDir, {})).toBe(
      join(resolve(dataDir), 'sandboxes'),
    );
  });

  it('honors the legacy source override without exposing it to runtime', () => {
    const override = process.platform === 'win32' ? 'E:\\old-archives' : '/old-archives';
    expect(legacySandboxArchiveDir('/ignored', {
      MCP_SANDBOX_ARCHIVE_DIR: override,
    })).toBe(resolve(override));
  });
});
