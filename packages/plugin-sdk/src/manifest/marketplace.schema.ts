/**
 * `marketplace.json` — catalog of plugin entries + their install source.
 * The `source` shape doubles as the host installer's source descriptor.
 */
import { z } from 'zod';

export const pluginSourceSchema = z.object({
  source: z.enum(['local', 'github', 'url', 'market']),
  path: z.string().optional(),
  repo: z.string().optional(),
  ref: z.string().optional(),
  url: z.string().url().optional(),
  /** Plugin name for `market` sources. */
  name: z.string().optional(),
});

export const marketplacePluginEntrySchema = z.object({
  name: z.string().min(1),
  source: pluginSourceSchema,
  policy: z.object({
    installation: z
      .enum(['NOT_AVAILABLE', 'AVAILABLE', 'INSTALLED_BY_DEFAULT'])
      .default('AVAILABLE'),
    authentication: z.enum(['ON_INSTALL', 'ON_USE']).default('ON_INSTALL'),
    products: z.array(z.string()).optional(),
  }),
  category: z.string(),
});

export const marketplaceManifestSchema = z.object({
  name: z.string().min(1),
  interface: z.object({ displayName: z.string().optional() }).optional(),
  plugins: z.array(marketplacePluginEntrySchema),
});

export function parseMarketplaceManifest(json: unknown) {
  return marketplaceManifestSchema.parse(json);
}
