import { useEffect } from 'react';
import { ReconnectingSSEClient } from '@mcp/shared/sse/ReconnectingSSEClient.js';
import { apiBaseUrl } from '../../lib/api-client.js';
import { recordCoderRuntimeNotification } from '../chat/notifications/runtime-events.js';
import {
  notifyCoderStreamEvent,
  notifyCompanyStreamEvent,
  notifyPipelineStreamEvent,
} from './stream-events.js';
import type { NotificationSourceContext } from './types.js';

interface GlobalNotificationEnvelopeBase {
  id: number;
  ts: number;
  event: string;
  data: unknown;
  context: NotificationSourceContext;
}

type GlobalNotificationEnvelope =
  | (GlobalNotificationEnvelopeBase & { kind: 'coder'; sessionId: string })
  | (GlobalNotificationEnvelopeBase & { kind: 'company'; sessionId: string });

const CURSOR_KEY = 'mcp.notification-stream.cursor';
let lastEventId = -1;

const persistentBackoff = {
  nextDelay(attempt: number): number {
    return Math.min(1_000 * Math.pow(1.6, attempt), 30_000);
  },
};

/** Mounted once under AppRoot so notifications do not depend on a chat route. */
export function GlobalNotificationListener() {
  useEffect(() => {
    lastEventId = readCursor();
    const abort = new AbortController();
    const client = new ReconnectingSSEClient({
      url: `${apiBaseUrl()}/api/notifications/stream`,
      method: 'GET',
      signal: abort.signal,
      backoff: persistentBackoff,
      getLastEventId: () => lastEventId,
      isTerminal: () => false,
      onEvent: (event) => {
        if (typeof event.id === 'number') writeCursor(event.id);
        if (event.event !== 'notification') return;
        try {
          dispatchGlobalNotification(JSON.parse(event.data) as GlobalNotificationEnvelope);
        } catch {
          // A malformed best-effort notification must not stop the live feed.
        }
      },
    });
    void client.run().catch((error) => {
      if (!abort.signal.aborted) console.warn('[notifications] global stream stopped:', error);
    });
    return () => abort.abort();
  }, []);
  return null;
}

export function dispatchGlobalNotification(source: GlobalNotificationEnvelope): void {
  const data = asPayload(source.data);
  const context: NotificationSourceContext = {
    ...source.context,
    dedupeKey: `runtime:${source.ts}:${source.id}`,
  };
  if (source.kind === 'coder') {
    recordCoderRuntimeNotification(source);
    if (source.event.startsWith('pipeline_')) {
      notifyPipelineStreamEvent(source.sessionId, source.event, data, context);
    } else {
      notifyCoderStreamEvent(source.sessionId, source.event, data, context);
    }
    return;
  }
  notifyCompanyStreamEvent(source.sessionId, source.event, data, context);
}

function readCursor(): number {
  try {
    const value = Number(window.sessionStorage.getItem(CURSOR_KEY));
    return Number.isSafeInteger(value) && value >= 0 ? value : -1;
  } catch {
    return -1;
  }
}

function writeCursor(value: number): void {
  lastEventId = value;
  try {
    window.sessionStorage.setItem(CURSOR_KEY, String(value));
  } catch {
    /* in-memory cursor still protects this mounted listener */
  }
}

function asPayload(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
