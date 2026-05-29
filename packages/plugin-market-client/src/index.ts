/**
 * @mcp/plugin-market-client — thin HTTP client for the hosted plugin Market
 * (worker-market: Cloudflare Worker + D1 + R2). Used by the plugin host to
 * search, look up, and download signed plugin bundles. Uses global fetch.
 */

export interface MarketPluginInfo {
  name: string;
  displayName?: string;
  description?: string;
  latestVersion: string;
  downloads: number;
  category?: string;
  author?: string;
  brandColor?: string;
}

export interface DownloadedBundle {
  /** Raw zip bytes of the published plugin bundle. */
  bytes: Uint8Array;
  /** Base64 Ed25519 signature over sha256(bytes), from the `X-Signature` header. */
  signature: string;
  version: string;
}

export class MarketClient {
  constructor(private readonly baseUrl: string) {}

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/+$/, '')}${path}`;
  }

  async search(query: string): Promise<MarketPluginInfo[]> {
    const res = await fetch(this.url(`/plugins?q=${encodeURIComponent(query)}`));
    if (!res.ok) throw new Error(`market search failed: ${res.status}`);
    return (await res.json()) as MarketPluginInfo[];
  }

  async getInfo(name: string): Promise<MarketPluginInfo | null> {
    const res = await fetch(this.url(`/plugins/${encodeURIComponent(name)}`));
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`market info failed: ${res.status}`);
    return (await res.json()) as MarketPluginInfo;
  }

  async downloadBundle(name: string, version: string): Promise<DownloadedBundle> {
    const res = await fetch(
      this.url(`/bundle/${encodeURIComponent(name)}/${encodeURIComponent(version)}`),
    );
    if (!res.ok) throw new Error(`market bundle download failed: ${res.status}`);
    const signature = res.headers.get('X-Signature') ?? '';
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { bytes, signature, version };
  }
}
