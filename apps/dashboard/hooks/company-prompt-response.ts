import type { MasterPrompt } from '@mcp/company-contracts';
import i18n from 'i18next';
import { confirm } from '../components/ui/prompt-dialog.js';

export type MasterReply = { answer: string } | { approved: boolean; feedback?: string };

interface ReplyContext {
  sessionId: string;
  promptId: string;
  url: (suffix: string) => string;
  isCurrent: () => boolean;
  onResolved: (prompt: MasterPrompt, fromReceipt: boolean) => void;
  onResumed: () => void;
}

interface DeliveryResult {
  prompt?: MasterPrompt;
  resumed?: boolean;
  error?: string;
  code?: string;
}

export async function submitMasterReply(context: ReplyContext, reply: MasterReply): Promise<void> {
  const { sessionId, promptId, url, isCurrent } = context;
  const question = 'answer' in reply;
  let resolved = false;
  function accept(prompt: MasterPrompt | undefined, fromReceipt = false): boolean {
    if (!isCurrent() || prompt?.id !== promptId || prompt.company_session_id !== sessionId ||
        prompt.kind !== (question ? 'question' : 'plan') ||
        (prompt.status !== 'answered' && prompt.status !== 'cancelled')) return false;
    if (!resolved) context.onResolved(prompt, fromReceipt);
    resolved = true;
    return true;
  }
  async function readReceipt(): Promise<void> {
    if (!isCurrent() || resolved) return;
    try {
      const res = await fetch(url('/master-prompts/' + encodeURIComponent(promptId)), {
        cache: 'no-store', signal: AbortSignal.timeout(3_000),
      });
      if (res.ok) accept((await res.json()).prompt, true);
    } catch { /* A missing receipt is never proof of delivery. */ }
  }

  let retryConfirmed = false;
  while (isCurrent() && !resolved) {
    // If the POST stalls after the worker accepted it, the card can still
    // show the persisted answer. Reads never redeliver input to the worker.
    const timer = setTimeout(() => { void readReceipt(); }, 1_500);
    let result: DeliveryResult | null = null;
    let status = 0;
    try {
      const response = await fetch(url(question ? '/answer' : '/plan-response'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt_id: promptId, ...reply, retry_outcome_unknown: retryConfirmed || undefined }),
        signal: AbortSignal.timeout(12_000),
      });
      status = response.status;
      result = await response.json();
      if (response.ok && isCurrent()) {
        if (result?.resumed) context.onResumed();
        if (accept(result?.prompt)) return;
      }
    } catch { /* Check durable state even when the acknowledgement was lost. */ }
    finally { clearTimeout(timer); }
    await readReceipt();
    if (resolved || !isCurrent()) return;
    if (result?.code === 'OUTCOME_UNKNOWN' && !retryConfirmed) {
      retryConfirmed = await confirm({
        title: i18n.t('agents:company.replyUncertainTitle'),
        description: i18n.t('agents:company.replyUncertainDescription'),
        confirmLabel: i18n.t('agents:company.retrySameReply'),
        cancelLabel: i18n.t('agents:company.keepPending'),
        tone: 'destructive',
      });
      if (retryConfirmed) {
        await readReceipt();
        continue;
      }
    }
    if (status === 404) throw new Error(i18n.t('agents:company.replyMissing'));
    if (result?.code === 'MASTER_INPUT_NOT_ACCEPTED') throw new Error(i18n.t('agents:company.replyNotAccepted'));
    if (result?.code === 'PROMPT_DELIVERY_PAYLOAD_CONFLICT') throw new Error(i18n.t('agents:company.replyConflict'));
    throw new Error(i18n.t('agents:company.replyUnconfirmed'));
  }
}
