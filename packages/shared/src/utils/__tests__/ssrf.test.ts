import { describe, it, expect } from 'vitest';
import { isPrivateHost } from '../ssrf.js';
import { sendHttp } from '../http-engine.js';

describe('isPrivateHost', () => {
  it('flags loopback / private / link-local / metadata hosts', () => {
    for (const h of ['localhost', 'app.localhost', '127.0.0.1', '0.0.0.0', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '::1', '::', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1']) {
      expect(isPrivateHost(h), h).toBe(true);
    }
  });
  it('flags obfuscated numeric/hex IP literals', () => {
    for (const h of ['2130706433', '0x7f000001', '0177.0.0.1']) expect(isPrivateHost(h), h).toBe(true);
  });
  it('allows public hosts', () => {
    for (const h of ['example.com', 'api.github.com', '8.8.8.8', '1.1.1.1', '192.0.3.1', '192.2.0.1']) expect(isPrivateHost(h), h).toBe(false);
  });
  it('blocks canonical mapped IPv6 and non-public special ranges', () => {
    for (const h of ['[::ffff:7f00:1]', '0:0:0:0:0:0:0:1', 'localhost.', '100.64.0.1', '192.0.2.1', '198.51.100.1', '203.0.113.1', '198.18.1.1', '224.0.0.1']) expect(isPrivateHost(h), h).toBe(true);
  });
});

describe('sendHttp guards', () => {
  it('rejects a private host when blockPrivateHosts is set (no connection attempted)', async () => {
    await expect(sendHttp({ url: new URL('http://169.254.169.254/latest/meta-data/'), blockPrivateHosts: true }))
      .rejects.toThrow(/private|loopback/i);
  });
  it('rejects a non-http(s) scheme', async () => {
    await expect(sendHttp({ url: new URL('file:///etc/passwd') })).rejects.toThrow(/scheme/i);
  });
});
