import { describe, expect, it } from 'vitest';
import { appFetchUxReference } from '../app-ux-reference.js';

describe('app_fetch_ux_reference', () => {
  it.each([
    'file:///etc/passwd',
    'http://localhost:7317/private',
    'http://127.0.0.1/private',
    'http://10.0.0.8/private',
    'http://[::1]/private',
    'http://169.254.169.254/latest/meta-data',
  ])('blocks non-public reference %s', async (url) => {
    const result = await appFetchUxReference.handler({ url }, {} as never);
    expect(result.isError).toBe(true);
    expect(String(result.content)).toMatch(/blocked|public http/i);
  });
});

