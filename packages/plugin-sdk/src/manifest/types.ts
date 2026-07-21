/** Inferred TS types for the manifest schemas. Import-type only — no runtime. */
import type { z } from 'zod';
import type {
  pluginManifestSchema,
  pluginInterfaceSchema,
} from './plugin-json.schema.js';
import type {
  appManifestSchema,
  pluginToolDeclSchema,
  pluginToolOutputPolicySchema,
  toolWindowDeclSchema,
  commandDeclSchema,
  themeDeclSchema,
  editorActionDeclSchema,
  editorDocumentSelectorSchema,
  editorGutterDeclSchema,
  editorGutterLineMatcherSchema,
  statusBarItemDeclSchema,
  runConfigurationDeclSchema,
  debuggerCapabilitiesDeclSchema,
  debuggerDeclSchema,
  projectModuleDeclSchema,
  providerRuntimeDeclSchema,
  debuggerRuntimeDeclSchema,
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
export type PluginToolOutputPolicy = z.infer<typeof pluginToolOutputPolicySchema>;
export type ToolWindowDecl = z.infer<typeof toolWindowDeclSchema>;
export type CommandDecl = z.infer<typeof commandDeclSchema>;
export type ThemeDecl = z.infer<typeof themeDeclSchema>;
export type EditorActionDecl = z.infer<typeof editorActionDeclSchema>;
export type EditorDocumentSelectorDecl = z.infer<typeof editorDocumentSelectorSchema>;
export type EditorGutterDecl = z.infer<typeof editorGutterDeclSchema>;
export type EditorGutterLineMatcherDecl = z.infer<typeof editorGutterLineMatcherSchema>;
export type StatusBarItemDecl = z.infer<typeof statusBarItemDeclSchema>;
export type RunConfigurationDecl = z.infer<typeof runConfigurationDeclSchema>;
export type DebuggerCapabilitiesDecl = z.infer<typeof debuggerCapabilitiesDeclSchema>;
export type DebuggerDecl = z.infer<typeof debuggerDeclSchema>;
export type ProjectModuleDecl = z.infer<typeof projectModuleDeclSchema>;
export type ProviderRuntimeDecl = z.infer<typeof providerRuntimeDeclSchema>;
export type DebuggerRuntimeDecl = z.infer<typeof debuggerRuntimeDeclSchema>;
export type MarketplaceManifest = z.infer<typeof marketplaceManifestSchema>;
export type MarketplacePluginEntry = z.infer<typeof marketplacePluginEntrySchema>;
export type PluginSource = z.infer<typeof pluginSourceSchema>;
