import { randomUUID } from 'node:crypto';
import type { ScheduledTrigger, ScheduledOccurrence } from '@mcp/agent-runtime-contracts';
import { CollaborationFollowups } from '@mcp/session-storage/collaboration/followups.js';
import { keyOf } from '@mcp/session-storage/collaboration/files.js';
import { rootChatId, type ChatCollaborationStore } from '@mcp/session-storage/collaboration/store.js';
import { nextCron, wallTime } from './chat-calendar.js';

export type ScheduleInput = Pick<ScheduledTrigger, 'kind' | 'at' | 'cron' | 'timezone' | 'action' | 'prompt' | 'misfire' | 'overlap' | 'maxRuns'> & { expiresAt?: number };

/** Local scheduler, called by the existing host wake service. No model call or
 * sleeping promise exists per timer. Sleep/restart is handled by due records. */
export class ChatScheduler {
  readonly records: CollaborationFollowups;
  readonly instanceId = randomUUID();
  constructor(readonly mailbox: ChatCollaborationStore, readonly now = () => Date.now()) {
    this.records = new CollaborationFollowups(mailbox.files);
  }
  async create(sessionId: string, input: ScheduleInput, key: string, authorized: boolean): Promise<ScheduledTrigger> {
    const now = this.now();
    if (!key || !['once', 'recurring'].includes(input.kind) || !['notify', 'resume', 'run'].includes(input.action)
      || !['skip', 'fire_once', 'ask'].includes(input.misfire) || !['skip', 'coalesce'].includes(input.overlap)
      || !input.prompt?.trim() || input.prompt.length > 12000 || !Number.isInteger(input.maxRuns) || input.maxRuns < 1 || input.maxRuns > 100) throw new Error('invalid_schedule');
    wallTime(now, input.timezone); // Validate IANA timezone before persistence.
    const id = keyOf(`${sessionId}:${key}`);
    const existing = await this.records.get<ScheduledTrigger>('schedules', id);
    if (existing) {
      for (const field of ['kind', 'at', 'cron', 'timezone', 'action', 'prompt', 'misfire', 'overlap', 'maxRuns'] as const)
        if (existing[field] !== input[field]) throw new Error('idempotency_conflict');
      return existing;
    }
    const nextDueAt = input.kind === 'once' ? input.at! : nextCron(input.cron ?? '', input.timezone, now);
    if (!Number.isFinite(nextDueAt) || nextDueAt <= now) throw new Error('schedule_requires_future_time');
    const expiresAt = input.expiresAt ?? now + 30 * 86400_000;
    if (!Number.isFinite(expiresAt) || expiresAt < nextDueAt || expiresAt > now + 366 * 86400_000) throw new Error('invalid_schedule_expiry');
    const active = (await this.records.list<ScheduledTrigger>('schedules', sessionId)).filter(row => !['completed', 'cancelled'].includes(row.state));
    if (active.length >= 20) throw new Error('schedule_capacity');
    const row: ScheduledTrigger = { ...input, schemaVersion: 1, id, revision: 0, sessionId, nextDueAt,
      state: authorized ? 'active' : 'needs_input', authorized, epoch: await this.mailbox.epoch(sessionId),
      createdAt: now, expiresAt, runs: 0 };
    return this.records.change('schedules', row, r => r, 0);
  }
  async control(sessionId: string, id: string, action: 'pause' | 'resume' | 'cancel', expectedRevision: number): Promise<ScheduledTrigger> {
    const row = await this.records.get<ScheduledTrigger>('schedules', id);
    if (!row || row.sessionId !== sessionId) throw new Error('scope_denied');
    const epoch = await this.mailbox.epoch(sessionId);
    const next = await this.records.change('schedules', row, current => {
      if (current.state === 'cancelled' || (current.state === 'completed' && action !== 'cancel')) throw new Error('schedule_terminal');
      return { ...current, epoch, authorized: true,
        nextDueAt: action === 'resume' && current.state === 'needs_input' ? this.now() : current.nextDueAt,
        state: action === 'cancel' ? 'cancelled' : action === 'pause' ? 'paused' : 'active' };
    }, expectedRevision);
    if (action !== 'resume') {
      for (const occurrence of await this.records.list<ScheduledOccurrence>('occurrences', sessionId)) {
        if (occurrence.scheduleId !== id || !['claimed', 'accepted', 'due'].includes(occurrence.state)) continue;
        if (occurrence.messageId) {
          const message = await this.mailbox.get(occurrence.messageId);
          await this.mailbox.cancel(message.from, message.id);
        }
        await this.records.change('occurrences', occurrence, r => r.state === 'started' ? r : { ...r, state: 'cancelled' });
      }
    }
    return next;
  }
  async tick(): Promise<void> {
    for (const schedule of await this.records.list<ScheduledTrigger>('schedules')) {
      if (schedule.state !== 'active' || !schedule.authorized || schedule.nextDueAt > this.now()) continue;
      try { await this.dispatch(schedule); }
      catch (error) {
        if (!/revision_conflict|occurrence_owned/.test(String(error))) console.warn('[chat-scheduler] Deferred occurrence:', schedule.id, String(error));
      }
    }
  }
  private async advance(schedule: ScheduledTrigger): Promise<void> {
    const wall = wallTime(schedule.nextDueAt, schedule.timezone);
    await this.records.change('schedules', schedule, row => ({ ...row, runs: row.runs + 1, lastWallTime: wall,
      state: row.kind === 'once' || row.runs + 1 >= row.maxRuns ? 'completed' : 'active',
      nextDueAt: row.kind === 'once' ? row.nextDueAt : nextCron(row.cron!, row.timezone, Math.max(row.nextDueAt, this.now()), wall),
    }), schedule.revision);
  }
  private async dispatch(schedule: ScheduledTrigger): Promise<void> {
    const epoch = await this.mailbox.epoch(schedule.sessionId);
    const participant = await this.mailbox.participant(rootChatId(schedule.sessionId));
    if (schedule.epoch !== epoch || participant?.state === 'stopped' || schedule.expiresAt <= this.now()) {
      await this.records.change('schedules', schedule, row => ({ ...row, state: 'cancelled' }), schedule.revision); return;
    }
    if (!participant) return;
    const id = keyOf(`${schedule.id}:${schedule.revision}:${schedule.nextDueAt}`);
    const existing = await this.records.get<ScheduledOccurrence>('occurrences', id);
    if (existing && ['accepted', 'started', 'finished', 'missed', 'cancelled'].includes(existing.state)) { await this.advance(schedule); return; }
    if (existing?.state === 'outcome_unknown') return;
    const overlapping = (await this.records.list<ScheduledOccurrence>('occurrences', schedule.sessionId))
      .some(row => row.scheduleId === schedule.id && row.id !== id && ['claimed', 'accepted', 'started', 'outcome_unknown'].includes(row.state));
    if (overlapping && schedule.overlap === 'coalesce') return;
    const late = this.now() - schedule.nextDueAt > 60_000;
    if (late && schedule.misfire === 'ask') {
      await this.records.change('schedules', schedule, row => ({ ...row, state: 'needs_input' }), schedule.revision); return;
    }
    const missed = (late && schedule.misfire === 'skip') || overlapping;
    const initial: ScheduledOccurrence = { schemaVersion: 1, id, sessionId: schedule.sessionId, scheduleId: schedule.id,
      scheduleRevision: schedule.revision, dueAt: schedule.nextDueAt, epoch, claimEpoch: 0, leaseUntil: 0, owner: '', state: 'due' };
    const occurrence = await this.records.change('occurrences', initial, row => {
      if (row.state !== 'due' && row.leaseUntil > this.now()) throw new Error('occurrence_owned');
      if (!['due', 'claimed'].includes(row.state)) throw new Error('occurrence_owned');
      return { ...row, owner: this.instanceId, claimEpoch: row.claimEpoch + 1, leaseUntil: this.now() + 60_000,
        state: missed ? 'missed' : 'claimed' };
    });
    if (missed) { await this.advance(schedule); return; }
    if (schedule.action === 'notify') {
      await this.records.change('occurrences', occurrence, row => ({ ...row, state: 'finished', detail: schedule.prompt }));
      await this.advance(schedule); return;
    }
    // Recheck after claiming. A concurrent stop invalidates the captured epoch.
    const current = await this.records.get<ScheduledTrigger>('schedules', schedule.id);
    if (current?.revision !== schedule.revision || current.state !== 'active' || await this.mailbox.epoch(schedule.sessionId) !== epoch) return;
    const from = `${rootChatId(schedule.sessionId)}/schedule:${schedule.id}`;
    await this.mailbox.register({ id: from, sessionId: schedule.sessionId, parentId: rootChatId(schedule.sessionId),
      label: 'Scheduled task', profile: 'schedule', state: 'idle' });
    const message = await this.mailbox.send({ from, to: rootChatId(schedule.sessionId), kind: 'task',
      body: schedule.prompt, references: [`schedule-occurrence:${id}`], idempotencyKey: id });
    await this.records.change('occurrences', occurrence, row => {
      if (row.state !== 'claimed' || row.owner !== this.instanceId || row.claimEpoch !== occurrence.claimEpoch) throw new Error('occurrence_fenced');
      return { ...row, state: 'accepted', messageId: message.id };
    });
    await this.advance(schedule);
  }
  async started(messageId: string, runId: string): Promise<void> {
    for (const row of await this.records.list<ScheduledOccurrence>('occurrences')) if (row.messageId === messageId) {
      await this.records.change('occurrences', row, current => {
        if (current.runId && current.runId !== runId) throw new Error('occurrence_already_started');
        if (current.state !== 'accepted' && current.state !== 'started') throw new Error('occurrence_not_accepted');
        return { ...current, state: 'started', runId };
      });
    }
  }
  async canWake(messageId: string, references: string[]): Promise<boolean> {
    const reference = references.find(ref => ref.startsWith('schedule-occurrence:'));
    if (!reference) return true;
    const occurrence = await this.records.get<ScheduledOccurrence>('occurrences', reference.slice('schedule-occurrence:'.length));
    if (!occurrence || occurrence.messageId !== messageId || !['accepted', 'started', 'outcome_unknown'].includes(occurrence.state)) return false;
    const schedule = await this.records.get<ScheduledTrigger>('schedules', occurrence.scheduleId);
    return !!schedule?.authorized && ['active', 'completed'].includes(schedule.state)
      && occurrence.epoch === await this.mailbox.epoch(occurrence.sessionId);
  }
  async finished(messageId: string, success: boolean): Promise<void> {
    for (const row of await this.records.list<ScheduledOccurrence>('occurrences')) if (row.messageId === messageId && row.state === 'started') {
      await this.records.change('occurrences', row, current => ({ ...current, state: success ? 'finished' : 'failed' }));
    }
  }
  /** Reconcile the existing command receipt after lost ACK/host restart. Never
   * uses lease expiry as permission to execute another copy of the task. */
  async reconcile(messageId: string, status: 'succeeded' | 'failed' | 'cancelled' | 'unknown'): Promise<void> {
    for (const row of await this.records.list<ScheduledOccurrence>('occurrences')) if (row.messageId === messageId) {
      await this.records.change('occurrences', row, current => {
        if (['finished', 'failed', 'cancelled'].includes(current.state)) return current;
        return { ...current, state: status === 'succeeded' ? 'finished' : status === 'unknown' ? 'outcome_unknown' : status,
          detail: status === 'unknown' ? 'Host admission exists; reconcile the original run before another execution.' : current.detail };
      });
    }
  }
}
