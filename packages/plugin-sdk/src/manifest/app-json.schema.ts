/**
 * `.app.json` — the proprietary IDE-contribution manifest layered on top of
 * the Claude Code core. Declarative on purpose: the host reads contributions
 * (tool windows, commands, themes, agent-tool metadata) WITHOUT executing
 * plugin code. The matching handlers live in the bundled `worker` entry and
 * are keyed by `name`/`id`.
 */
import { z } from 'zod';
import { CONTRIB_ID_RE, relPath } from './common.js';

const contribId = z.string().regex(CONTRIB_ID_RE, 'id must be kebab/snake-case');

export const pluginToolDeclSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  parameters: z.record(z.unknown()).default({}),
  riskLevel: z.enum(['read', 'write', 'execute', 'admin']).optional(),
  mutates: z.boolean().optional(),
});

export const toolWindowDeclSchema = z.object({
  id: contribId,
  title: z.string().min(1),
  icon: z.string().optional(),
  side: z.enum(['left', 'right', 'bottom']),
  entry: relPath,
});

export const commandDeclSchema = z.object({
  id: contribId,
  label: z.string().min(1),
  category: z.string().optional(),
  shortcut: z.string().optional(),
});

export const themeDeclSchema = z.object({
  id: contribId,
  label: z.string().min(1),
  appearance: z.enum(['dark', 'light']),
  tokens: z.record(z.string()),
});

export const appManifestSchema = z.object({
  worker: relPath.optional(),
  tools: z.array(pluginToolDeclSchema).optional(),
  toolWindows: z.array(toolWindowDeclSchema).optional(),
  commands: z.array(commandDeclSchema).optional(),
  themes: z.array(themeDeclSchema).optional(),
});

export function parseAppManifest(json: unknown) {
  return appManifestSchema.parse(json);
}
