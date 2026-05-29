import { mkdir } from 'node:fs/promises';
import AdmZip from 'adm-zip';
import { MarketClient } from '@mcp/plugin-market-client';
import { verifyBundle } from '../signature.js';
import type { MaterializeResult } from './index.js';

/**
 * Download a signed bundle from the hosted market, verify its Ed25519
 * signature (when a public key is pinned), and unzip into staging. The
 * signature check is the trust boundary — we never extract unverified bytes
 * when MCP_MARKET_PUBKEY is set.
 */
export async function materializeMarket(
  name: string,
  version: string | undefined,
  stagingDir: string,
): Promise<MaterializeResult> {
  const baseUrl = process.env.MCP_MARKET_URL;
  if (!baseUrl) throw new Error('hosted market not configured (set MCP_MARKET_URL)');
  const client = new MarketClient(baseUrl);

  const resolvedVersion = version ?? (await client.getInfo(name))?.latestVersion;
  if (!resolvedVersion) throw new Error(`plugin "${name}" not found in market`);

  const { bytes, signature } = await client.downloadBundle(name, resolvedVersion);

  const pubKey = process.env.MCP_MARKET_PUBKEY;
  if (pubKey && (!signature || !verifyBundle(bytes, signature, pubKey))) {
    throw new Error(`bundle signature verification failed for "${name}@${resolvedVersion}"`);
  }

  await mkdir(stagingDir, { recursive: true });
  const zip = new AdmZip(Buffer.from(bytes));
  zip.extractAllTo(stagingDir, true);
  return { ref: resolvedVersion };
}
