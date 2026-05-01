import { describe, it, expect } from 'vitest';
import { buildVerdaccioSpawnCommand } from '../core/verdaccio/verdaccio-service.js';

describe('buildVerdaccioSpawnCommand', () => {
  it('interpolates the internal port into --listen', () => {
    expect(buildVerdaccioSpawnCommand(4873)).toMatch(/--listen http:\/\/0\.0\.0\.0:4873\b/);
    expect(buildVerdaccioSpawnCommand(7654)).toMatch(/--listen http:\/\/0\.0\.0\.0:7654\b/);
  });

  it('always passes --listen 0.0.0.0 (sibling containers reach via host alias gateway)', () => {
    const cmd = buildVerdaccioSpawnCommand(4873);
    expect(cmd).toContain('0.0.0.0');
    expect(cmd).not.toContain('127.0.0.1');
    expect(cmd).not.toContain('localhost');
  });

  it('points --config at the image-default config path', () => {
    expect(buildVerdaccioSpawnCommand(4873)).toContain('--config /verdaccio/conf/config.yaml');
  });

  it('detaches via nohup + & so the exec returns immediately', () => {
    const cmd = buildVerdaccioSpawnCommand(4873);
    expect(cmd.startsWith('nohup ')).toBe(true);
    expect(cmd.trimEnd().endsWith('&')).toBe(true);
  });

  it('redirects stdout/stderr to /tmp/verdaccio.log for diagnostics', () => {
    expect(buildVerdaccioSpawnCommand(4873)).toContain('/tmp/verdaccio.log 2>&1');
  });
});
