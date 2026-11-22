import { useEffect, useRef, useState } from 'react';
import type { TodoItem } from '../../hooks/agent-stream/types.js';

export interface TaskRow {
  id: string;
  title: string;
  status: string;
  files: string[];
}

interface StateSummary {
  tasks: {
    summary: string;
    approved: boolean;
    execution_mode: string | null;
    current_task_id: string | null;
    tasks: TaskRow[];
  } | null;
  todos?: TodoItem[];
}

interface PendingSummary {
  controller: AbortController;
  result: Promise<StateSummary>;
  readers: number;
}

const pending = new Map<string, PendingSummary>();

export function subscribeToSessionSummary(sessionId: string, revision: number) {
  const key = `${sessionId}#${revision}`;
  let request = pending.get(key);
  if (!request) {
    const controller = new AbortController();
    const result = fetch(`/api/coder/sessions/${sessionId}/state-summary`, { signal: controller.signal })
      .then((response): Promise<StateSummary> => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      }).finally(() => {
        if (pending.get(key)?.controller === controller) pending.delete(key);
      });
    request = { controller, result, readers: 0 };
    pending.set(key, request);
  }
  const shared = request;
  shared.readers++;
  return {
    result: shared.result,
    release() {
      if (--shared.readers === 0 && pending.get(key) === shared) {
        pending.delete(key);
        shared.controller.abort();
      }
    },
  };
}

export function useSessionStateSummary(
  sessionId: string,
  refreshKey = 0,
  onActiveTaskChange?: (taskId: string | null) => void,
) {
  const [result, setResult] = useState<{ sessionId: string; data: StateSummary } | null>(null);
  const onChange = useRef(onActiveTaskChange);
  useEffect(() => { onChange.current = onActiveTaskChange; }, [onActiveTaskChange]);
  useEffect(() => {
    let active = true;
    const request = subscribeToSessionSummary(sessionId, refreshKey);
    void request.result.then(data => {
      if (!active) return;
      setResult({ sessionId, data });
      onChange.current?.(data.tasks?.current_task_id ?? null);
    }).catch(() => { if (active) setResult(null); });
    return () => {
      active = false;
      request.release();
    };
  }, [sessionId, refreshKey]);
  return result?.sessionId === sessionId ? result.data : null;
}
