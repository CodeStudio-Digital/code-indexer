import AdmZip from 'adm-zip';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parsePluginManifest } from '../manifest/schema.js';

/**
 * Zip the plugin dir (excluding node_modules) and POST it to the hosted
 * market's `/publish`. Requires MCP_MARKET_URL (+ MCP_MARKET_TOKEN for auth).
 * Run `build` first so dist/plugin.js + .app.json are included in the bundle.
 */
export async function publishPlugin(dir: string): Promise<{ name: string; version: string }> {
  const baseUrl = process.env.MCP_MARKET_URL;
  if (!baseUrl) throw new Error('set MCP_MARKET_URL to publish to a hosted market');

  const root = resolve(dir);
  const manifest = parsePluginManifest(JSON.parse(readFileSync(join(root, 'plugin.json'), 'utf8')));

  const zip = new AdmZip();
  zip.addLocalFolder(root, '', (p) => !p.split(/[/\\]/).includes('node_modules'));
  const body = zip.toBuffer();

  const token = process.env.MCP_MARKET_TOKEN;
  const url =
    `${baseUrl.replace(/\/+$/, '')}/publish` +
    `?name=${encodeURIComponent(manifest.name)}&version=${encodeURIComponent(manifest.version)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/zip',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body,
  });
  if (!res.ok) {
    throw new Error(`publish failed: ${res.status} ${await res.text().catch(() => '')}`);
  }
  return { name: manifest.name, version: manifest.version };
}
