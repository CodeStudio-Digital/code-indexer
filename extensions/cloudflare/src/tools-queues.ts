/**
 * Queues management, including protected pull inspection. Pulling messages
 * leases them; callers must ack or retry/release using the returned lease_id.
 */
import { contributeTool } from '@mcp/plugin-sdk/define.js';
import type { PluginToolContext } from '@mcp/plugin-sdk/define.js';
import { asRecord, cfAcct, cfAcctPaged, fail, list, ok, optNumber, parseJson, reqString } from './lib.js';

interface Queue {
  queue_id?: string;
  queue_name?: string;
  name?: string;
  created_on?: string;
  modified_on?: string;
}

function queueName(q: Queue): string {
  return q.queue_name ?? q.name ?? q.queue_id ?? '(unnamed)';
}

function queueId(args: Record<string, unknown>): string {
  return reqString(args, 'queueId');
}

export const queueTools = [
  contributeTool({
    name: 'cf_queues_list',
    description: 'List Queues',
    riskLevel: 'read',
    mutates: false,
    parameters: { type: 'object', properties: {} },
    handler: async (_a, ctx: PluginToolContext) => {
      const qs = await cfAcctPaged<Queue>(ctx, '/queues');
      return list(qs, (q) => `- ${queueName(q)} (${q.queue_id ?? '-'})`, 'No queues.');
    },
  }),
  contributeTool({
    name: 'cf_queue_get',
    description: 'Get Queue details',
    riskLevel: 'read',
    mutates: false,
    parameters: { type: 'object', properties: { queueId: { type: 'string' } }, required: ['queueId'] },
    handler: async (a, ctx) => {
      const q = await cfAcct<Queue>(ctx, `/queues/${queueId(a)}`);
      return ok(`Queue ${queueName(q)}.`, { details: q });
    },
  }),
  contributeTool({
    name: 'cf_queue_metrics',
    description: 'Get Queue metrics',
    riskLevel: 'read',
    mutates: false,
    parameters: { type: 'object', properties: { queueId: { type: 'string' } }, required: ['queueId'] },
    handler: async (a, ctx) => {
      const r = await cfAcct(ctx, `/queues/${queueId(a)}/metrics`);
      return ok('Queue metrics.', { details: r });
    },
  }),
  contributeTool({
    name: 'cf_queue_create',
    description: 'Create a Queue',
    riskLevel: 'write',
    mutates: true,
    parameters: { type: 'object', properties: { name: { type: 'string' }, settings: { type: 'object' } }, required: ['name'] },
    handler: async (a, ctx) => {
      const body = { ...asRecord(parseJson(a.settings, {})), queue_name: reqString(a, 'name') };
      const q = await cfAcct<Queue>(ctx, '/queues', { method: 'POST', body: JSON.stringify(body) });
      return ok(`Created queue "${queueName(q)}".`, { details: q });
    },
  }),
  contributeTool({
    name: 'cf_queue_update',
    description: 'Patch Queue settings using Cloudflare queue fields',
    riskLevel: 'write',
    mutates: true,
    parameters: { type: 'object', properties: { queueId: { type: 'string' }, body: { type: 'object' } }, required: ['queueId', 'body'] },
    handler: async (a, ctx) => {
      const q = await cfAcct<Queue>(ctx, `/queues/${queueId(a)}`, {
        method: 'PATCH',
        body: JSON.stringify(parseJson(a.body, {})),
      });
      return ok(`Updated queue ${queueName(q)}.`, { details: q });
    },
  }),
  contributeTool({
    name: 'cf_queue_delete',
    description: 'Delete a Queue by id',
    riskLevel: 'admin',
    mutates: true,
    parameters: { type: 'object', properties: { queueId: { type: 'string' } }, required: ['queueId'] },
    handler: async (a, ctx) => {
      const id = queueId(a);
      await cfAcct(ctx, `/queues/${id}`, { method: 'DELETE' });
      return ok(`Deleted queue ${id}.`);
    },
  }),
  contributeTool({
    name: 'cf_queue_push',
    description: 'Push one message to a Queue',
    riskLevel: 'write',
    mutates: true,
    parameters: {
      type: 'object',
      properties: { queueId: { type: 'string' }, body: {}, contentType: { type: 'string' }, delay_seconds: { type: 'number' } },
      required: ['queueId', 'body'],
    },
    handler: async (a, ctx) => {
      const payload: Record<string, unknown> = { body: a.body };
      if (a.contentType) payload.contentType = String(a.contentType);
      if (a.delay_seconds != null) payload.delay_seconds = Number(a.delay_seconds);
      const r = await cfAcct(ctx, `/queues/${queueId(a)}/messages`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      return ok('Message pushed.', { details: r });
    },
  }),
  contributeTool({
    name: 'cf_queue_push_batch',
    description: 'Push a batch of messages to a Queue',
    riskLevel: 'write',
    mutates: true,
    parameters: { type: 'object', properties: { queueId: { type: 'string' }, messages: { type: 'array' } }, required: ['queueId', 'messages'] },
    handler: async (a, ctx) => {
      const messages = parseJson(a.messages, []);
      if (!Array.isArray(messages)) return fail('messages must be an array');
      const r = await cfAcct(ctx, `/queues/${queueId(a)}/messages/batch`, {
        method: 'POST',
        body: JSON.stringify({ messages }),
      });
      return ok(`Pushed ${messages.length} message(s).`, { details: r });
    },
  }),
  contributeTool({
    name: 'cf_queue_pull',
    description: 'Protected pull: lease messages for inspection; use lease_id to ack or retry/release',
    riskLevel: 'admin',
    mutates: true,
    parameters: {
      type: 'object',
      properties: { queueId: { type: 'string' }, batch_size: { type: 'number' }, visibility_timeout_ms: { type: 'number' } },
      required: ['queueId'],
    },
    handler: async (a, ctx) => {
      const body: Record<string, unknown> = {
        batch_size: Math.min(Math.max(optNumber(a, 'batch_size') ?? 5, 1), 100),
        visibility_timeout_ms: Math.max(optNumber(a, 'visibility_timeout_ms') ?? 30000, 1000),
      };
      const r = await cfAcct<{ messages?: Array<Record<string, unknown>> }>(ctx, `/queues/${queueId(a)}/messages/pull`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      const rows = r.messages ?? [];
      return {
        content: rows.length ? `Pulled ${rows.length} in-flight message(s). Ack or retry them by lease_id.` : 'No messages available.',
        data: { rows, details: { protectedPull: true, ...body } },
      };
    },
  }),
  contributeTool({
    name: 'cf_queue_ack',
    description: 'Acknowledge Queue messages by lease_id',
    riskLevel: 'admin',
    mutates: true,
    parameters: { type: 'object', properties: { queueId: { type: 'string' }, leaseIds: { type: 'array' } }, required: ['queueId', 'leaseIds'] },
    handler: async (a, ctx) => {
      const leaseIds = parseJson(a.leaseIds, []);
      if (!Array.isArray(leaseIds)) return fail('leaseIds must be an array');
      const r = await cfAcct(ctx, `/queues/${queueId(a)}/messages/ack`, {
        method: 'POST',
        body: JSON.stringify({ acks: leaseIds.map((lease_id) => ({ lease_id })) }),
      });
      return ok(`Acknowledged ${leaseIds.length} message(s).`, { details: r });
    },
  }),
  contributeTool({
    name: 'cf_queue_retry',
    description: 'Retry/release Queue messages by lease_id, optionally with delay_seconds',
    riskLevel: 'admin',
    mutates: true,
    parameters: {
      type: 'object',
      properties: { queueId: { type: 'string' }, leaseIds: { type: 'array' }, delay_seconds: { type: 'number' } },
      required: ['queueId', 'leaseIds'],
    },
    handler: async (a, ctx) => {
      const leaseIds = parseJson(a.leaseIds, []);
      if (!Array.isArray(leaseIds)) return fail('leaseIds must be an array');
      const delay = optNumber(a, 'delay_seconds') ?? 0;
      const r = await cfAcct(ctx, `/queues/${queueId(a)}/messages/ack`, {
        method: 'POST',
        body: JSON.stringify({ retries: leaseIds.map((lease_id) => ({ lease_id, delay_seconds: delay })) }),
      });
      return ok(`Retried/released ${leaseIds.length} message(s).`, { details: r });
    },
  }),
  contributeTool({
    name: 'cf_queue_purge',
    description: 'Purge all messages from a Queue',
    riskLevel: 'admin',
    mutates: true,
    parameters: { type: 'object', properties: { queueId: { type: 'string' } }, required: ['queueId'] },
    handler: async (a, ctx) => {
      const r = await cfAcct(ctx, `/queues/${queueId(a)}/purge`, { method: 'POST', body: JSON.stringify({}) });
      return ok('Queue purge started.', { details: r });
    },
  }),
  contributeTool({
    name: 'cf_queue_consumers',
    description: 'List Queue consumers',
    riskLevel: 'read',
    mutates: false,
    parameters: { type: 'object', properties: { queueId: { type: 'string' } }, required: ['queueId'] },
    handler: async (a, ctx) => {
      const rows = await cfAcctPaged<Record<string, unknown>>(ctx, `/queues/${queueId(a)}/consumers`);
      return list(rows, (c) => `- ${String(c.consumer_id ?? c.id ?? c.script_name ?? 'consumer')}`, 'No consumers.');
    },
  }),
  contributeTool({
    name: 'cf_queue_consumer_get',
    description: 'Get Queue consumer details',
    riskLevel: 'read',
    mutates: false,
    parameters: {
      type: 'object',
      properties: { queueId: { type: 'string' }, consumerId: { type: 'string' } },
      required: ['queueId', 'consumerId'],
    },
    handler: async (a, ctx) => {
      const r = await cfAcct(ctx, `/queues/${queueId(a)}/consumers/${reqString(a, 'consumerId')}`);
      return ok('Queue consumer details.', { details: r });
    },
  }),
  contributeTool({
    name: 'cf_queue_consumer_create',
    description: 'Create a Queue consumer using the Cloudflare consumer body',
    riskLevel: 'write',
    mutates: true,
    parameters: { type: 'object', properties: { queueId: { type: 'string' }, body: { type: 'object' } }, required: ['queueId', 'body'] },
    handler: async (a, ctx) => {
      const r = await cfAcct(ctx, `/queues/${queueId(a)}/consumers`, {
        method: 'POST',
        body: JSON.stringify(parseJson(a.body, {})),
      });
      return ok('Queue consumer created.', { details: r });
    },
  }),
  contributeTool({
    name: 'cf_queue_consumer_update',
    description: 'Update a Queue consumer using the Cloudflare consumer body',
    riskLevel: 'write',
    mutates: true,
    parameters: {
      type: 'object',
      properties: { queueId: { type: 'string' }, consumerId: { type: 'string' }, body: { type: 'object' } },
      required: ['queueId', 'consumerId', 'body'],
    },
    handler: async (a, ctx) => {
      const r = await cfAcct(ctx, `/queues/${queueId(a)}/consumers/${reqString(a, 'consumerId')}`, {
        method: 'PUT',
        body: JSON.stringify(parseJson(a.body, {})),
      });
      return ok('Queue consumer updated.', { details: r });
    },
  }),
  contributeTool({
    name: 'cf_queue_consumer_delete',
    description: 'Delete a Queue consumer',
    riskLevel: 'admin',
    mutates: true,
    parameters: {
      type: 'object',
      properties: { queueId: { type: 'string' }, consumerId: { type: 'string' } },
      required: ['queueId', 'consumerId'],
    },
    handler: async (a, ctx) => {
      await cfAcct(ctx, `/queues/${queueId(a)}/consumers/${reqString(a, 'consumerId')}`, { method: 'DELETE' });
      return ok('Queue consumer deleted.');
    },
  }),
];
