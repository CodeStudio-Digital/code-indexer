/**
 * `plugin.json` — the Claude Code/Codex-compatible plugin manifest.
 *
 * Lenient on install (existing CC plugins without an `interface` block still
 * ingest); the CLI `validate` command enforces the stricter publish rules.
 */
import { z } from 'zod';
import { KEBAB_RE, SEMVER_RE, httpsUrl, relPath } from './common.js';

export const pluginInterfaceSchema = z.object({
  displayName: z.string().min(1),
  shortDescription: z.string().optional(),
  longDescription: z.string().optional(),
  developerName: z.string().optional(),
  category: z.string().optional(),
  capabilities: z.array(z.string()).optional(),
  websiteURL: httpsUrl.optional(),
  privacyPolicyURL: httpsUrl.optional(),
  termsOfServiceURL: httpsUrl.optional(),
  defaultPrompt: z.array(z.string().max(128)).max(3).optional(),
  /**
   * Persona/guidance lines appended to the scoped assistant's system prompt
   * (the host's `plugins.assistantStream`). Lets a plugin steer its assistant
   * toward domain best-practices without a host change. Kept short and
   * bounded so it can't crowd out the safety guardrail.
   */
  assistantGuidance: z.array(z.string().max(240)).max(12).optional(),
  brandColor: z.string().optional(),
  composerIcon: relPath.optional(),
  logo: relPath.optional(),
  screenshots: z.array(relPath).optional(),
});

export const pluginManifestSchema = z.object({
  name: z.string().regex(KEBAB_RE, 'name must be kebab-case'),
  version: z.string().regex(SEMVER_RE, 'version must be strict semver'),
  description: z.string().min(1),
  author: z.object({
    name: z.string().min(1),
    email: z.string().email().optional(),
    url: z.string().url().optional(),
  }),
  homepage: z.string().url().optional(),
  repository: z.string().url().optional(),
  license: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  skills: relPath.optional(),
  hooks: relPath.optional(),
  mcpServers: relPath.optional(),
  apps: relPath.optional(),
  interface: pluginInterfaceSchema.optional(),
});

export function parsePluginManifest(json: unknown) {
  return pluginManifestSchema.parse(json);
}
