/**
 * Image tools: list, pull, build, remove, tag, inspect. Listing reuses the
 * exact `imagesArgs`/`parseImages` the company image catalog (Phase 3) calls,
 * so the IDE and the company picker see identical rows.
 */
import { contributeTool } from '@mcp/plugin-sdk/define.js';
import type { PluginToolContext } from '@mcp/plugin-sdk/define.js';
import {
  imagesArgs,
  pullArgs,
  buildArgs,
  rmiArgs,
  tagArgs,
  inspectArgs,
  parseImages,
  type ImageSummary,
} from '@mcp/podman-core';
import {
  podman,
  podmanJson,
  podmanRun,
  ok,
  fail,
  list,
  reqString,
  optString,
  optBool,
  toRecord,
} from './lib.js';

const renderImage = (i: ImageSummary) =>
  `- ${i.reference}${i.size ? ` · ${(i.size / 1_048_576).toFixed(0)} MB` : ''} · ${i.id.slice(0, 12)}`;

export const imageTools = [
  contributeTool({
    name: 'podman_images',
    description: 'List local Podman images',
    riskLevel: 'read',
    mutates: false,
    parameters: { type: 'object', properties: {} },
    handler: async (_a, ctx: PluginToolContext) => {
      const images = await podmanJson(ctx, imagesArgs(), parseImages);
      return list(images, renderImage, 'No images.');
    },
  }),

  contributeTool({
    name: 'podman_pull',
    description: 'Pull an image from a registry',
    riskLevel: 'execute',
    mutates: true,
    parameters: {
      type: 'object',
      properties: { reference: { type: 'string' } },
      required: ['reference'],
    },
    handler: async (a, ctx: PluginToolContext) =>
      podmanRun(ctx, pullArgs(reqString(a, 'reference')), () => `Pulled ${reqString(a, 'reference')}.`),
  }),

  contributeTool({
    name: 'podman_build',
    description: 'Build an image from a Dockerfile/Containerfile',
    riskLevel: 'execute',
    mutates: true,
    parameters: {
      type: 'object',
      properties: {
        tag: { type: 'string' },
        file: { type: 'string', description: 'path to Dockerfile/Containerfile' },
        context: { type: 'string', description: 'build context dir (default .)' },
        noCache: { type: 'boolean' },
        buildArgs: { type: 'object' },
      },
      required: ['tag'],
    },
    handler: async (a, ctx: PluginToolContext) => {
      const r = await podman(
        ctx,
        buildArgs({
          tag: reqString(a, 'tag'),
          file: optString(a, 'file'),
          context: optString(a, 'context'),
          noCache: optBool(a, 'noCache'),
          buildArgs: toRecord(a.buildArgs),
        }),
      );
      if (r.code !== 0) return fail(r.stdout.trim() || `podman build failed (exit ${r.code})`);
      return ok(`Built ${reqString(a, 'tag')}.\n${r.stdout.trim()}`.trim());
    },
  }),

  contributeTool({
    name: 'podman_rmi',
    description: 'Remove an image (force optional)',
    riskLevel: 'admin',
    mutates: true,
    parameters: {
      type: 'object',
      properties: { reference: { type: 'string' }, force: { type: 'boolean' } },
      required: ['reference'],
    },
    handler: async (a, ctx: PluginToolContext) =>
      podmanRun(ctx, rmiArgs(reqString(a, 'reference'), { force: optBool(a, 'force') }), () => 'Removed.'),
  }),

  contributeTool({
    name: 'podman_tag',
    description: 'Tag an image with a new reference',
    riskLevel: 'write',
    mutates: true,
    parameters: {
      type: 'object',
      properties: { source: { type: 'string' }, target: { type: 'string' } },
      required: ['source', 'target'],
    },
    handler: async (a, ctx: PluginToolContext) =>
      podmanRun(
        ctx,
        tagArgs(reqString(a, 'source'), reqString(a, 'target')),
        () => `Tagged ${reqString(a, 'source')} → ${reqString(a, 'target')}.`,
      ),
  }),

  contributeTool({
    name: 'podman_image_inspect',
    description: 'Inspect an image and return its raw JSON',
    riskLevel: 'read',
    mutates: false,
    parameters: {
      type: 'object',
      properties: { reference: { type: 'string' } },
      required: ['reference'],
    },
    handler: async (a, ctx: PluginToolContext) => {
      const r = await podman(ctx, inspectArgs(reqString(a, 'reference')));
      if (r.code !== 0) return fail(r.stdout.trim() || `podman inspect failed (exit ${r.code})`);
      return ok(r.stdout.trim());
    },
  }),
];
