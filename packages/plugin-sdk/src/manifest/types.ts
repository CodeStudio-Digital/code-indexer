/** Inferred TS types for the manifest schemas. Import-type only — no runtime. */
import type { z } from 'zod';
import type {
  pluginManifestSchema,
  pluginInterfaceSchema,
} from './plugin-json.schema.js';
import type {
  appManifestSchema,
  pluginToolDeclSchema,
  toolWindowDeclSchema,
  commandDeclSchema,
  themeDeclSchema,
} from './app-json.schema.js';
import type {
  marketplaceManifestSchema,
  marketplacePluginEntrySchema,
  pluginSourceSchema,
} from './marketplace.schema.js';

export type PluginManifest = z.infer<typeof pluginManifestSchema>;
export type PluginInterface = z.infer<typeof pluginInterfaceSchema>;
export type AppManifest = z.infer<typeof appManifestSchema>;
export type PluginToolDecl = z.infer<typeof pluginToolDeclSchema>;
export type ToolWindowDecl = z.infer<typeof toolWindowDeclSchema>;
export type CommandDecl = z.infer<typeof commandDeclSchema>;
export type ThemeDecl = z.infer<typeof themeDeclSchema>;
export type MarketplaceManifest = z.infer<typeof marketplaceManifestSchema>;
export type MarketplacePluginEntry = z.infer<typeof marketplacePluginEntrySchema>;
export type PluginSource = z.infer<typeof pluginSourceSchema>;
