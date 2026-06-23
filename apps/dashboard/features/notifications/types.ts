export type NotificationEvent = 'session_finished' | 'human_action_required';

export type NotificationTarget = 'project' | 'global' | 'company' | 'plugin';

export type NotificationSeverity = 'info' | 'warning' | 'error';

export interface NotificationRouteTarget {
  kind: NotificationTarget;
  route: string;
  scopeId?: number | string;
  sessionId?: number | string;
  label?: string;
}

export interface NotificationSourceContext {
  target: NotificationRouteTarget;
  pipelineTarget?: NotificationRouteTarget;
}

export interface AppNotificationEvent {
  kind: NotificationEvent;
  target: NotificationRouteTarget;
  id: string;
  title: string;
  body: string;
  severity?: NotificationSeverity;
  dedupeKey?: string;
}

export interface DesktopNotificationOptions {
  title: string;
  body: string;
  route?: string;
  tag?: string;
  kind?: NotificationEvent | string;
}
