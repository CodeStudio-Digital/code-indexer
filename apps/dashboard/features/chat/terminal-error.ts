import i18n from '../../i18n/index.js';

export function formatCoderTerminalError(data: { message?: unknown; error?: unknown; reason?: unknown }): string {
  const fallback = String(data.message ?? data.error ?? data.reason ?? 'unknown');
  switch (data.reason) {
    case 'session-interrupted':
    case 'session-failed':
    case 'session-missing':
    case 'worker-draining':
    case 'turn-ended-before-input':
    case 'worker-unavailable-before-input':
    case 'session-recovery-timeout':
    case 'worker-evicted':
    case 'session-writer-busy':
    case 'request-setup-failed':
    case 'continue-setup-failed':
      return i18n.t(`chat:failure.${data.reason}`, { defaultValue: fallback }) || fallback;
    default:
      return fallback;
  }
}
