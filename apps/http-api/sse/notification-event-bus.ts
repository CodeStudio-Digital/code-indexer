/**
 * Process-wide source for dashboard notifications.
 *
 * Runtime buses are scoped to one coder/company session and may be replayed
 * only when that conversation is opened. This bus keeps the small subset of
 * events that can notify in one app-wide sequence so the dashboard can stay
 * subscribed regardless of the active route.
 */

export type NotificationRuntimeKind = 'coder' | 'company';

export interface NotificationRuntimeEvent {
  id: number;
  ts: number;
  kind: NotificationRuntimeKind;
  sessionId: number;
  event: string;
  data: unknown;
}

export interface PublishNotificationRuntimeEvent {
  ts?: number;
  kind: NotificationRuntimeKind;
  sessionId: number;
  event: string;
  data: unknown;
}

export type NotificationRuntimeListener = (event: NotificationRuntimeEvent) => void;

const RING_CAPACITY = 200;
const RING_TTL_MS = 15 * 60_000;

const CODER_EVENTS = new Set([
  'tool_approval_request',
  'plan',
  'question',
  'tasks_posted',
  'spec',
  'done',
  'error',
  'tool_loop_intervention',
  'quality_watchdog_alert',
  'agents_group_start',
  'agent_progress',
  'agents_group_end',
  'pipeline_paused',
  'pipeline_completed',
  'pipeline_aborted',
  'pipeline_failed',
]);

const COMPANY_EVENTS = new Set([
  'master_plan_posted',
  'master_question_posted',
  'session_idle',
  'done',
  'error',
  'pipeline_paused',
  'pipeline_completed',
  'pipeline_aborted',
  'pipeline_failed',
]);

class NotificationEventBus {
  private readonly listeners = new Set<NotificationRuntimeListener>();
  private ring: NotificationRuntimeEvent[] = [];
  private sequence = 0;

  publish(input: PublishNotificationRuntimeEvent): NotificationRuntimeEvent | null {
    if (
      !isNotificationRuntimeEvent(input.kind, input.event)
      || !hasNotifiablePayload(input.event, input.data)
    ) return null;
    const event: NotificationRuntimeEvent = {
      ...input,
      id: ++this.sequence,
      ts: input.ts ?? Date.now(),
    };
    this.ring.push(event);
    this.prune(event.ts);
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(event);
      } catch (error) {
        console.warn('[notification-event-bus] listener threw:', error);
      }
    }
    return event;
  }

  subscribe(listener: NotificationRuntimeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  recentAfter(id: number, now = Date.now()): NotificationRuntimeEvent[] {
    this.prune(now);
    return this.ring.filter((event) => event.id > id);
  }

  latestId(): number {
    return this.sequence;
  }

  clearForTests(): void {
    this.listeners.clear();
    this.ring = [];
    this.sequence = 0;
  }

  private prune(now: number): void {
    const cutoff = now - RING_TTL_MS;
    const firstFresh = this.ring.findIndex((event) => event.ts >= cutoff);
    if (firstFresh < 0) this.ring = [];
    else if (firstFresh > 0) this.ring = this.ring.slice(firstFresh);
    if (this.ring.length > RING_CAPACITY) this.ring = this.ring.slice(-RING_CAPACITY);
  }
}

const bus = new NotificationEventBus();

export function isNotificationRuntimeEvent(
  kind: NotificationRuntimeKind,
  event: string,
): boolean {
  return (kind === 'coder' ? CODER_EVENTS : COMPANY_EVENTS).has(event);
}

function hasNotifiablePayload(event: string, value: unknown): boolean {
  const data = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  if (event === 'agent_progress') {
    return data.event === 'error' || data.event === 'timed_out';
  }
  if (event === 'agents_group_start') return data.background === true;
  if (event === 'agents_group_end') return typeof data.jobId === 'string';
  if (event === 'quality_watchdog_alert') {
    return data.verdict === 'warn' || data.verdict === 'flagged' || data.verdict === 'error';
  }
  if (event === 'tool_loop_intervention') {
    return !(data.kind === 'dup-result-marker' && data.severity === 'informational');
  }
  if (event === 'pipeline_paused') return data.awaitingConfirmation === true;
  return true;
}

export function publishNotificationRuntimeEvent(
  event: PublishNotificationRuntimeEvent,
): NotificationRuntimeEvent | null {
  return bus.publish(event);
}

export function subscribeToNotificationRuntimeEvents(
  listener: NotificationRuntimeListener,
): () => void {
  return bus.subscribe(listener);
}

export function recentNotificationRuntimeEvents(afterId: number): NotificationRuntimeEvent[] {
  return bus.recentAfter(afterId);
}

export function latestNotificationRuntimeEventId(): number {
  return bus.latestId();
}

export function clearNotificationEventBusForTests(): void {
  bus.clearForTests();
}

export const NOTIFICATION_EVENT_RING_CAPACITY = RING_CAPACITY;
export const NOTIFICATION_EVENT_RING_TTL_MS = RING_TTL_MS;
