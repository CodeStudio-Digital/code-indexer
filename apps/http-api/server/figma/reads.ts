import { FigmaApiError, object, type FigmaClient, type JsonObject } from './client.js';
import { childLayers } from './design-context.js';
import { FigmaProjectCache, type CacheScope, type Cached, type TreeCoverage } from './project-cache.js';

export const CACHE_MODES = ['prefer_cache', 'cache_only', 'refresh'] as const;
export type CacheMode = typeof CACHE_MODES[number];

type Source = 'local' | 'figma';
type Read<T> = Cached<T> & { source: Source };
type Tree = { data: JsonObject; depth: number };
type Export = { url: string | null; validUntil: number };

const MAX_INDEXED_LAYERS = 2000;
export const MAX_TREE_DEPTH = 5;
const MAX_EXPORT_AGE_MS = 24 * 60 * 60 * 1000;
const EXPORT_EXPIRY_MARGIN_MS = 60 * 1000;

function treeKey(id?: string): string { return id ? 'tree:node:' + id : 'tree:file'; }

function treeEntry(data: JsonObject, root?: string | null): JsonObject {
  return root ? object(object(data.nodes)[root]) : data;
}

function indexTree(document: JsonObject, depth: number, root: string | null): TreeCoverage {
  const nodes: Record<string, number> = Object.create(null);
  let indexed = 0;
  function visit(node: JsonObject, remaining: number) {
    const children = remaining > 0 ? childLayers(node) : [];
    if (typeof node.id === 'string') {
      // A leaf observed before the depth boundary is already complete.
      nodes[node.id] = remaining > 0 && !children.length ? MAX_TREE_DEPTH : remaining;
      indexed++;
    }
    for (const child of children) {
      if (indexed >= MAX_INDEXED_LAYERS) return;
      visit(child, remaining - 1);
    }
  }
  visit(document, depth);
  return { root, depth, nodes };
}

function findLayer(root: JsonObject, id: string, depth: number): JsonObject | undefined {
  if (root.id === id) return root;
  if (depth <= 0) return undefined;
  for (const child of childLayers(root)) {
    const match = findLayer(child, id, depth - 1);
    if (match) return match;
  }
}

function exportExpiry(url: string, capturedAt: number): number {
  const params = new URL(url).searchParams;
  const epoch = Number(params.get('Expires')) * 1000;
  const signed = params.get('X-Amz-Date')?.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  const lifetime = Number(params.get('X-Amz-Expires')) * 1000;
  const s3 = signed && lifetime > 0
    ? Date.parse(signed[1] + '-' + signed[2] + '-' + signed[3] + 'T' + signed[4] + ':' + signed[5] + ':' + signed[6] + 'Z') + lifetime
    : 0;
  return Math.min(capturedAt + MAX_EXPORT_AGE_MS,
    epoch > 0 ? epoch - EXPORT_EXPIRY_MARGIN_MS : Infinity,
    s3 > 0 ? s3 - EXPORT_EXPIRY_MARGIN_MS : Infinity);
}

function requireLive(mode: CacheMode): void {
  if (mode === 'cache_only') throw new Error('No matching Figma data in this project’s cache. Use prefer_cache to fetch it.');
}

/** One tool call's view of the shared project cache, with provenance for the data it returns. */
export class FigmaReads {
  private local = false;
  private live = false;
  private capturedAt = Infinity;
  private client?: Promise<FigmaClient>;

  constructor(
    private readonly cache: FigmaProjectCache,
    private readonly scope: CacheScope | null,
    private readonly file: string,
    private readonly mode: CacheMode,
    private readonly signal: AbortSignal,
    private readonly getClient: () => Promise<FigmaClient>,
  ) {}

  private api(): Promise<FigmaClient> { return this.client ??= this.getClient(); }

  get info() {
    return {
      source: this.local ? (this.live ? 'mixed' : 'local') : 'figma',
      capturedAt: new Date(this.capturedAt).toISOString(),
    };
  }

  private use<T>(read: Read<T>): T {
    if (read.source === 'local') this.local = true;
    else this.live = true;
    this.capturedAt = Math.min(this.capturedAt, read.savedAt);
    return read.value;
  }

  private async remember<T>(key: string, request: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const refresh = this.mode === 'refresh';
    if (!refresh) {
      const hit = await this.cache.read<T>(this.scope, key);
      if (hit) return this.use({ ...hit, source: 'local' });
    }
    requireLive(this.mode);
    return this.use(await this.cache.load<Read<T>>(this.scope, key + (refresh ? ':refresh' : ':fill'), this.signal, async signal => {
      const value = await request(signal);
      const entry = { value, savedAt: Date.now() };
      await this.cache.write(this.scope, key, entry);
      return { ...entry, source: 'figma' };
    }));
  }

  async tree(id: string | undefined, depth: number) {
    const key = treeKey(id);
    const exact = await this.cache.read<Tree>(this.scope, key);
    if (this.mode !== 'refresh') {
      if (exact && exact.value.depth >= depth) {
        const { data } = this.use({ ...exact, source: 'local' });
        const entry = treeEntry(data, id);
        return { data, entry, document: object(entry.document) };
      }
      if (id) {
        for (const candidate of await this.cache.trees(this.scope)) {
          if (!(candidate.value.nodes[id] >= depth)) continue;
          const cached = await this.cache.read<Tree>(this.scope, candidate.key);
          if (!cached || cached.savedAt !== candidate.savedAt) continue;
          const { data } = cached.value;
          const entry = treeEntry(data, candidate.value.root);
          const document = findLayer(object(entry.document), id, cached.value.depth);
          if (document) {
            this.use({ ...cached, source: 'local' });
            return { data, entry, document };
          }
        }
      }
    }
    requireLive(this.mode);
    // A shallow refresh of a previously cached frame also updates its known descendants.
    const requestDepth = Math.max(1, depth, exact?.value.depth ?? 0);
    const { data } = this.use(await this.cache.load<Read<Tree>>(this.scope, key + ':' + requestDepth, this.signal, async signal => {
      const api = await this.api();
      const data = id ? await api.nodes(this.file, [id], requestDepth, signal)
        : await api.file(this.file, requestDepth, signal);
      const entry = treeEntry(data, id);
      const document = object(entry.document);
      if (!Object.hasOwn(entry, 'document') || (id && document.id !== id)) {
        throw new Error('The selected layer or file does not exist in Figma.');
      }
      const snapshot = { savedAt: Date.now(), value: { data, depth: requestDepth } };
      await this.cache.write(this.scope, key, snapshot, indexTree(document, requestDepth, id ?? null));
      return { ...snapshot, source: 'figma' };
    }));
    const entry = treeEntry(data, id);
    return { data, entry, document: object(entry.document) };
  }

  variables() {
    return this.remember('variables', async signal => (await this.api()).variables(this.file, signal));
  }

  private async readExports(ids: string[], format: string, scale: number, mode: CacheMode, signal: AbortSignal) {
    const key = (id: string) => 'export:' + format + ':' + scale + ':' + id;
    const stored = await Promise.all(ids.map(async id => {
      const hit = mode === 'refresh' ? null : await this.cache.read<Export>(this.scope, key(id));
      return hit?.value.url && hit.value.validUntil > Date.now() ? hit : null;
    }));
    const missing = ids.filter((_, index) => !stored[index]).sort();
    let fetched: Array<{ nodeId: string; read: Read<Export> }> = [];
    if (missing.length) {
      requireLive(mode);
      fetched = await this.cache.load(this.scope, 'exports:' + format + ':' + scale + ':' + missing.join(','), signal, async signal => {
        const assets = await (await this.api()).exports(this.file, missing, format, scale, signal);
        const savedAt = Date.now();
        return Promise.all(assets.map(async ({ nodeId, url }) => {
          const value = { url, validUntil: url ? exportExpiry(url, savedAt) : 0 };
          if (url && value.validUntil > savedAt) await this.cache.write(this.scope, key(nodeId), { value, savedAt });
          return { nodeId, read: { value, savedAt, source: 'figma' as const } };
        }));
      });
    }
    const byId = new Map(fetched.map(({ nodeId, read }) => [nodeId, read]));
    return ids.map((id, index): Read<Export> => {
      const hit = stored[index];
      return hit ? { ...hit, source: 'local' } : byId.get(id)!;
    });
  }

  async assets(ids: string[], format: string, scale: number) {
    const reads = await this.readExports(ids, format, scale, this.mode, this.signal);
    return reads.map((read, index) => ({ nodeId: ids[index], url: this.use(read).url }));
  }

  screenshot(id: string, scale: number) {
    return this.remember('png:' + scale + ':' + id, async signal => {
      const [image] = await this.readExports([id], 'png', scale, this.mode, signal);
      const url = image.value.url;
      if (!url) throw new Error('Figma could not render this layer. Choose a visible frame or artwork.');
      const api = await this.api();
      try {
        return await api.screenshot(url, signal);
      } catch (error) {
        if (image.source !== 'local' || !(error instanceof FigmaApiError) || ![403, 404].includes(error.status)) throw error;
        const [updated] = await this.readExports([id], 'png', scale, 'refresh', signal);
        if (!updated.value.url) throw error;
        return api.screenshot(updated.value.url, signal);
      }
    });
  }
}
