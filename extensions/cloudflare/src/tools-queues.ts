/**
 * Queues — list/create/delete queues. REST: /accounts/:id/queues.
 */
import { contributeTool } from '@mcp/plugin-sdk/define.js';
import type { PluginToolContext } from '@mcp/plugin-sdk/define.js';
import { cfAcct, ok, fail, list } from './lib.js';

interface Queue {
  queue_id?: string;
  queue_name?: string;
  name?: string;
}

export const queueTools = [
  contributeTool({
    name: 'cf_queues_list',
    description: 'List Queues',
    riskLevel: 'read',
    mutates: false,
    parameters: { type: 'object', properties: {} },
    handler: async (_a, ctx: PluginToolContext) => {
      const qs = await cfAcct<Queue[]>(ctx, '/queues');
      return list(qs, (q) => `- ${q.queue_name ?? q.name} (${q.queue_id ?? '—'})`, 'No queues.');
    },
  }),
  contributeTool({
    name: 'cf_queue_create',
    description: 'Create a Queue',
    riskLevel: 'write',
    mutates: true,
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
    handler: async (a, ctx: PluginToolContext) => {
      const name = String((a as { name?: string }).name ?? '').trim();
      if (!name) return fail('name is required');
      await cfAcct(ctx, '/queues', { method: 'POST', body: JSON.stringify({ queue_name: name }) });
      return ok(`Created queue "${name}".`);
    },
  }),
  contributeTool({
    name: 'cf_queue_delete',
    description: 'Delete a Queue (by id)',
    riskLevel: 'admin',
    mutates: true,
    parameters: {
      type: 'object',
      properties: { queueId: { type: 'string' } },
      required: ['queueId'],
    },
    handler: async (a, ctx: PluginToolContext) => {
      const id = String((a as { queueId?: string }).queueId ?? '');
      if (!id) return fail('queueId is required');
      await cfAcct(ctx, `/queues/${id}`, { method: 'DELETE' });
      return ok(`Deleted queue ${id}.`);
    },
  }),
];
