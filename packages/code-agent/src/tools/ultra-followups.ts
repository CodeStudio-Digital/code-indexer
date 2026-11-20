import type { CoderTool } from '../core/tool.js';
import { err } from '../core/tool.js';
import { okStructured } from '../core/model-output.js';
import { CollaborationFollowups } from '@mcp/session-storage/collaboration/followups.js';
import { ChatScheduler, type ScheduleInput } from '../runtime/chat-scheduler.js';

/** Proposals and schedule drafts are inert until a human accepts them in the UI. */
export const ultraFollowupTools: CoderTool[] = [
  {
    name: 'propose_task', source: 'native', mutates: false, effectBoundary: 'control', executionClass: 'control', parallelSafe: false,
    description: 'Offer a useful optional next task after the requested deliverable is ready. Persists a proposal card; never starts work. Avoid generic suggestions, duplicates and required work that belongs to the current request.',
    parameters: { type: 'object', properties: { title: { type: 'string' }, prompt: { type: 'string' }, rationale: { type: 'string' }, context: { type: 'string', enum: ['fresh', 'workspace', 'fork'] } }, required: ['title', 'prompt', 'rationale', 'context'], additionalProperties: false },
    handler: async (args, ctx) => {
      if (!ctx.collaboration || !ctx.sessionId || !ctx.currentToolUseId) return err('Follow-ups require a tracked ordinary session');
      try {
        return okStructured(await new CollaborationFollowups(ctx.collaboration.store.files).propose({ sessionId: ctx.sessionId,
          title: String(args.title), prompt: String(args.prompt), rationale: String(args.rationale),
          context: args.context as 'fresh' | 'workspace' | 'fork', sourceRevision: ctx.runner?.runId ?? '' }, ctx.currentToolUseId));
      } catch (error) { return err(String(error)); }
    },
  },
  {
    name: 'prepare_chat_schedule', source: 'native', mutates: false, effectBoundary: 'control', executionClass: 'control', parallelSafe: false,
    description: 'Prepare a local reminder or recurring chat task for human activation in the collaboration panel. Does not activate it. Timers run only while this host is available; explicit misfire and overlap policies handle sleep/restart. No model calls while waiting.',
    parameters: { type: 'object', properties: {
      kind: { type: 'string', enum: ['once', 'recurring'] }, at: { type: 'number', description: 'Future Unix milliseconds for once.' },
      cron: { type: 'string', description: 'Five fields: minute hour day month weekday (0=Sunday).' }, timezone: { type: 'string' },
      action: { type: 'string', enum: ['notify', 'resume', 'run'] }, prompt: { type: 'string' },
      misfire: { type: 'string', enum: ['skip', 'fire_once', 'ask'] }, overlap: { type: 'string', enum: ['skip', 'coalesce'] },
      maxRuns: { type: 'integer', minimum: 1, maximum: 100 },
    }, required: ['kind', 'timezone', 'action', 'prompt', 'misfire', 'overlap', 'maxRuns'], additionalProperties: false },
    handler: async (args, ctx) => {
      if (!ctx.collaboration || !ctx.sessionId || !ctx.currentToolUseId) return err('Schedules require a tracked ordinary session');
      try { return okStructured(await new ChatScheduler(ctx.collaboration.store).create(ctx.sessionId, args as unknown as ScheduleInput, ctx.currentToolUseId, false)); }
      catch (error) { return err(String(error)); }
    },
  },
];
