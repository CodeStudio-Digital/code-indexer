import type { SettingDef } from './types.js';

/** Desktop notifications. */
export const NOTIFICATION_SETTINGS: readonly SettingDef[] = [
  {
    key: 'MCP_DESKTOP_NOTIFICATIONS_ENABLED',
    label: 'Desktop notifications',
    description: 'Show native OS notifications when the target session or route is not visible.',
    type: 'bool',
    category: 'notifications',
    default: '1',
  },
  {
    key: 'MCP_DESKTOP_NOTIFY_ACTION_REQUIRED',
    label: 'Notify action required',
    description: 'Notify when a session is blocked waiting for human input.',
    type: 'bool',
    category: 'notifications',
    default: '1',
  },
  {
    key: 'MCP_DESKTOP_NOTIFY_SESSION_FINISHED',
    label: 'Notify session finished',
    description: 'Notify when a coder or company session finishes, pauses, fails, or aborts.',
    type: 'bool',
    category: 'notifications',
    default: '1',
  },
];
