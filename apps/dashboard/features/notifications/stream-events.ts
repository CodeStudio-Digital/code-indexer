import { emitAppNotification } from './dispatcher.js';
import i18n from '../../i18n/index.js';
import type {
  AppNotificationEvent,
  NotificationRouteTarget,
  NotificationSourceContext,
} from './types.js';

type Payload = Record<string, unknown> | null | undefined;

export function notifyCoderStreamEvent(
  sessionId: number,
  eventName: string,
  data: Payload,
  context?: NotificationSourceContext,
): void {
  if (!context?.target) return;
  const target = context.target;
  const label = target.label ?? `Session #${sessionId}`;

  if (eventName === 'tool_approval_request') {
    const toolUseId = readString(data, 'toolUseId');
    const toolName = readString(data, 'toolName') ?? 'tool';
    emit({
      kind: 'human_action_required',
      target,
      id: `tool_approval_request:${toolUseId ?? 'unknown'}`,
      title: tt('notifications.actionRequiredTitle'),
      body: tt('notifications.toolApprovalBody', { label, toolName }),
      severity: 'warning',
    });
    return;
  }

  if (eventName === 'plan') {
    emit(actionEvent(target, label, `plan:${readString(data, 'id') ?? 'unknown'}`, 'notifications.reviewPlanAction'));
    return;
  }

  if (eventName === 'question') {
    emit(actionEvent(target, label, `question:${readString(data, 'id') ?? 'unknown'}`, 'notifications.answerQuestionAction'));
    return;
  }

  if (eventName === 'tasks_posted') {
    emit(actionEvent(target, label, `tasks_posted:${readString(data, 'tool_use_id') ?? 'unknown'}`, 'notifications.reviewTasksAction'));
    return;
  }

  if (eventName === 'spec') {
    emit(actionEvent(target, label, `spec:${readString(data, 'id') ?? 'unknown'}`, 'notifications.reviewSpecAction'));
    return;
  }

  if (eventName === 'done') {
    const error = readString(data, 'error');
    emit({
      kind: 'session_finished',
      target,
      id: `done:${readString(data, 'reason') ?? 'completed'}:${error ?? ''}`,
      title: error ? tt('notifications.sessionNeedsAttentionTitle') : tt('notifications.sessionFinishedTitle'),
      body: error
        ? tt('notifications.sessionErrorBody', { label })
        : tt('notifications.sessionFinishedBody', { label }),
      severity: error ? 'error' : 'info',
    });
    return;
  }

  if (eventName === 'error') {
    emit({
      kind: 'session_finished',
      target,
      id: `error:${readString(data, 'message') ?? readString(data, 'error') ?? 'unknown'}`,
      title: tt('notifications.sessionNeedsAttentionTitle'),
      body: tt('notifications.sessionErrorBody', { label }),
      severity: 'error',
    });
  }
}

export function notifyPipelineStreamEvent(
  sessionId: number,
  eventName: string,
  data: Payload,
  context?: NotificationSourceContext,
): void {
  if (!context?.target) return;
  const target = context.pipelineTarget ?? context.target;
  const label = target.label ?? context.target.label ?? `Session #${sessionId}`;
  const executionId = readNumber(data, 'executionId') ?? readString(data, 'executionId') ?? 'unknown';

  if (eventName === 'pipeline_paused' && readBoolean(data, 'awaitingConfirmation')) {
    emit({
      kind: 'human_action_required',
      target,
      id: `pipeline_paused:${executionId}`,
      title: tt('notifications.pipelinePausedTitle'),
      body: tt('notifications.pipelineConfirmationBody', { label }),
      severity: 'warning',
    });
    return;
  }

  if (eventName === 'pipeline_completed') {
    emit({
      kind: 'session_finished',
      target,
      id: `pipeline_completed:${executionId}`,
      title: tt('notifications.pipelineCompletedTitle'),
      body: tt('notifications.pipelineCompletedBody', { label }),
      severity: 'info',
    });
    return;
  }

  if (eventName === 'pipeline_aborted') {
    emit({
      kind: 'session_finished',
      target,
      id: `pipeline_aborted:${executionId}`,
      title: tt('notifications.pipelineAbortedTitle'),
      body: tt('notifications.pipelineAbortedBody', { label }),
      severity: 'warning',
    });
    return;
  }

  if (eventName === 'pipeline_failed') {
    emit({
      kind: 'session_finished',
      target,
      id: `pipeline_failed:${executionId}`,
      title: tt('notifications.pipelineFailedTitle'),
      body: tt('notifications.pipelineFailedBody', { label }),
      severity: 'error',
    });
  }
}

export function notifyCompanyStreamEvent(
  companySessionId: number,
  eventName: string,
  data: Payload,
  context?: NotificationSourceContext,
): void {
  if (!context?.target) return;
  if (eventName.startsWith('pipeline_')) {
    notifyPipelineStreamEvent(companySessionId, eventName, data, context);
    return;
  }

  const target = context.target;
  const label = target.label ?? `Company session #${companySessionId}`;

  if (eventName === 'master_plan_posted') {
    emit(actionEvent(target, label, `master_plan_posted:${masterPromptId(data)}`, 'notifications.reviewMasterPlanAction'));
    return;
  }

  if (eventName === 'master_question_posted') {
    emit(actionEvent(target, label, `master_question_posted:${masterPromptId(data)}`, 'notifications.answerMasterQuestionAction'));
    return;
  }

  if (eventName === 'session_idle') {
    emit({
      kind: 'session_finished',
      target,
      id: `session_idle:${readString(data, 'reason') ?? readString(data, 'endedAt') ?? 'idle'}`,
      title: tt('notifications.companySessionPausedTitle'),
      body: tt('notifications.companyIdleBody', { label }),
      severity: 'info',
    });
    return;
  }

  if (eventName === 'done') {
    emit({
      kind: 'session_finished',
      target,
      id: `done:${readString(data, 'reason') ?? 'completed'}`,
      title: tt('notifications.companySessionFinishedTitle'),
      body: tt('notifications.companyFinishedBody', { label }),
      severity: 'info',
    });
    return;
  }

  if (eventName === 'error') {
    emit({
      kind: 'session_finished',
      target,
      id: `error:${readString(data, 'error') ?? readString(data, 'message') ?? 'unknown'}`,
      title: tt('notifications.companySessionNeedsAttentionTitle'),
      body: tt('notifications.companyErrorBody', { label }),
      severity: 'error',
    });
  }
}

function actionEvent(
  target: NotificationRouteTarget,
  label: string,
  id: string,
  messageKey: string,
): AppNotificationEvent {
  return {
    kind: 'human_action_required',
    target,
    id,
    title: tt('notifications.actionRequiredTitle'),
    body: tt('notifications.actionBody', { label, message: tt(messageKey) }),
    severity: 'warning',
  };
}

function emit(event: AppNotificationEvent): void {
  void emitAppNotification(event);
}

function masterPromptId(data: Payload): string {
  const prompt = readRecord(data, 'prompt');
  const id = readNumber(prompt, 'id') ?? readString(prompt, 'id') ?? readNumber(data, 'promptId') ?? readString(data, 'promptId');
  return id == null ? 'unknown' : String(id);
}

function readRecord(data: Payload, key: string): Record<string, unknown> | undefined {
  const value = data?.[key];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readString(data: Payload, key: string): string | undefined {
  const value = data?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readNumber(data: Payload, key: string): number | undefined {
  const value = data?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readBoolean(data: Payload, key: string): boolean {
  return data?.[key] === true;
}

function tt(key: string, options?: Record<string, unknown>): string {
  return String(i18n.t(key, options));
}
