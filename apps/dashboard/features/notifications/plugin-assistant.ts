import { emitAppNotification } from './dispatcher.js';
import i18n from '../../i18n/index.js';
import type { NotificationRouteTarget } from './types.js';

export interface PluginConfirmNotification {
  pluginId: string;
  requestId: string;
  target: Omit<NotificationRouteTarget, 'kind'>;
  title?: string;
  message?: string;
}

export function emitPluginConfirmRequestNotification(event: PluginConfirmNotification): void {
  void emitAppNotification({
    kind: 'human_action_required',
    target: {
      ...event.target,
      kind: 'plugin',
    },
    id: `confirm_request:${event.pluginId}:${event.requestId}`,
    title: event.title ?? String(i18n.t('notifications.pluginConfirmTitle')),
    body: event.message ?? String(i18n.t('notifications.pluginConfirmBody')),
    severity: 'warning',
  });
}
