import { useCallback, useEffect, useRef } from 'react';
import type { EarlierMessagePageResult, MessagePage, SessionData } from '../../chat/types.js';
import { mergeEarlierMessagePage } from '../../chat/messages/session-message-data.js';
export function useEditorMessagePagination(selectedId: string | null, selectedSessionData: SessionData | null,
  updateSessionData: (fn: (previous: SessionData) => SessionData) => void,
) {
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const selectedSessionDataRef = useRef(selectedSessionData);
  selectedSessionDataRef.current = selectedSessionData;
  const messagePageAbortControllersRef = useRef<Set<AbortController>>(new Set());
  useEffect(() => () => {
    for (const controller of messagePageAbortControllersRef.current) controller.abort();
    messagePageAbortControllersRef.current.clear();
  }, [selectedId]);

  const loadEarlierMessages = useCallback(async (
    beforeSeq: number | undefined,
    limit = 40,
    includeArchived = false,
  ): Promise<EarlierMessagePageResult> => {
    const requestedSessionId = selectedId;
    if (!requestedSessionId) return { ok: false, reason: 'stale' };
    const controller = new AbortController();
    messagePageAbortControllersRef.current.add(controller);
    try {
      const qs = new URLSearchParams({ limit: String(limit), detail: 'preview' });
      if (beforeSeq != null) qs.set('before_seq', String(beforeSeq));
      if (includeArchived) qs.set('include_archived', '1');
      const res = await fetch(`/api/coder/sessions/${requestedSessionId}/messages?${qs}`, {
        signal: controller.signal,
      });
      if (!res.ok) return { ok: false, reason: 'error', error: `HTTP ${res.status}` };
      const page = (await res.json()) as MessagePage;
      if (selectedIdRef.current !== requestedSessionId) return { ok: false, reason: 'stale' };
      const current = selectedSessionDataRef.current;
      const preview = current
        ? mergeEarlierMessagePage(current, page, requestedSessionId)
        : null;
      if (!preview) return { ok: false, reason: 'stale' };
      if (preview.addedRows > 0) {
        updateSessionData((prev) => mergeEarlierMessagePage(prev, page, requestedSessionId).data);
      }
      return {
        ok: true,
        addedRows: preview.addedRows,
        nextBeforeSeq: page.next_before_seq,
        hasMore: page.has_more,
      };
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return { ok: false, reason: 'aborted' };
      }
      return {
        ok: false,
        reason: 'error',
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      messagePageAbortControllersRef.current.delete(controller);
    }
  }, [selectedId, updateSessionData]);


  return loadEarlierMessages;
}
