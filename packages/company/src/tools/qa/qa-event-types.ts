/**
 * Stream event payloads for QA agents. Centralised here so frontend
 * handlers, tests, and tool implementations all import the same shape.
 *
 * Events are published on the `CoderRunBus` of the meta company session
 * via `MetaBusPublisher`. The frontend consumes them through the
 * existing `useAgentStream` SSE hook.
 *
 * Adding a new QA event:
 *  1. Add the discriminator to `QaEventName` and an entry to `QaEventMap`.
 *  2. Implement the publisher in `qa-publish-result.ts` (or a new tool).
 *  3. Add a case in the dashboard's `agent-stream/handlers.ts`.
 *
 * Pure type module — no runtime exports — keeps it cheap to import on
 * both sides of the wire.
 */

export type QaEventName =
  | 'qa_run_started'
  | 'qa_run_test_result'
  | 'qa_run_completed'
  | 'qa_bug_filed';

export interface QaFailingTest {
  name: string;
  error: string;
  trace_url?: string;
}

export interface QaRunStartedPayload {
  agent_run_id: string | null;
  agent_role: string;
  suite: string;
  test_count?: number;
  trigger?: 'agent' | 'human' | 'watcher';
}

export interface QaRunTestResultPayload {
  agent_run_id: string | null;
  agent_role: string;
  spec: string;
  test_name: string;
  status: 'passed' | 'failed' | 'skipped' | 'timed-out' | 'interrupted';
  duration_ms?: number;
  error?: string;
  trace_url?: string;
  screenshot_url?: string;
  video_url?: string;
}

export interface QaRunCompletedPayload {
  agent_run_id: string | null;
  agent_role: string;
  suite: string;
  passed: number;
  failed: number;
  skipped: number;
  duration_ms?: number;
  trace_urls?: string[];
  failing_tests?: QaFailingTest[];
}

export interface QaBugFiledPayload {
  agent_run_id: string | null;
  agent_role: string;
  card_id: string;
  title: string;
}

export interface QaEventMap {
  qa_run_started: QaRunStartedPayload;
  qa_run_test_result: QaRunTestResultPayload;
  qa_run_completed: QaRunCompletedPayload;
  qa_bug_filed: QaBugFiledPayload;
}
