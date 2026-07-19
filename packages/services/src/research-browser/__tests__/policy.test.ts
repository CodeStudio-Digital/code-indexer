import { describe, expect, it } from 'vitest';
import { requirePublicHttpsUrl } from '../service.js';

const publicResolver = async (): Promise<string[]> => ['93.184.216.34'];

describe('research browser URL policy', () => {
  it('allows a public HTTPS URL', async () => {
    await expect(requirePublicHttpsUrl('https://example.com/research?q=1', publicResolver))
      .resolves.toBe('https://example.com/research?q=1');
  });

  it.each([
    'http://example.com',
    'https://user:secret@example.com',
    'https://localhost/admin',
    'https://127.0.0.1/admin',
    'https://0.0.0.0/admin',
    'https://[::1]/admin',
    'https://service.internal/admin',
  ])('rejects unsafe target %s', async (url) => {
    await expect(requirePublicHttpsUrl(url, publicResolver)).rejects.toThrow(/public|private|local/i);
  });

  it('blocks DNS rebinding to private or link-local addresses', async () => {
    const privateResolver = async (): Promise<string[]> => ['93.184.216.34', '169.254.169.254'];
    await expect(requirePublicHttpsUrl('https://example.com', privateResolver))
      .rejects.toThrow(/non-public/i);
  });

  it('fails closed when DNS resolution returns no address', async () => {
    await expect(requirePublicHttpsUrl('https://example.com', async () => []))
      .rejects.toThrow(/unresolved/i);
  });
});
