/**
 * MasterInboxRouter — fila de mensagens dirigidas ao master da sessão.
 *
 * Diferente do {@link InboxQueue} (subordinado ↔ subordinado), o master
 * não é um `company_agent_run` consumindo mensagens por idle-drain. Ele
 * é o agente "vivo" da sessão, que pode estar entre turnos. Quando um
 * subordinado precisa avisar o master:
 *
 *   - Se o master está rodando → empurramos a mensagem no buffer dele.
 *   - Se o master terminou seu turno → resurrect com a mensagem.
 *   - Se 3-4 subordinados disparam ao mesmo tempo enquanto o master
 *     está morto → o mutex coalesce as mensagens em UMA revive, com
 *     atribuição por origem ("[de @backend, run=42]: ...").
 *
 * O storage reusa `agent_inbox` com o sentinel `to_role = '__master__'`
 * (migration 094 documenta). Persistência cobre o caso "Node caiu com
 * mensagens pendentes" — quando o orchestrator volta a vida (via init
 * ou registry), `reviveIfPending()` reclama tudo de uma vez.
 *
 * O método-chave é {@link MasterLifecycle.notify} — ele já implementa
 * alive/dead/resuming corretamente. O router só é responsável por:
 *   1. persistir,
 *   2. coalescer mensagens pendentes,
 *   3. publicar eventos no MetaBus para SSE/transcript,
 *   4. invocar `master.notify(combined)`.
 */

import type { SessionContext } from '@mcp/company/services/SessionContext.js';
import type { MasterLifecycle } from '@mcp/company/services/MasterLifecycle.js';
import type { IMetaBusPublisher } from '@mcp/company/services/ports.js';
import type { CompanyEventBus } from '@mcp/company/services/CompanyEventBus.js';
import type { AgentInboxMessage, InboxKind } from '@mcp/company/types.js';
import { raceWithTimeout, isMutexTimeout } from '@mcp/company/services/utils/promiseMutex.js';

/**
 * Hard ceiling on how long `tryDeliverNow` will wait for the previous
 * delivery in the mutex chain to finish. 30s is generous for a healthy
 * delivery (claim + master.notify usually completes in <1s); if we
 * cross it, something is wedged and we'd rather drop the chain than
 * silently block every future master notification.
 */
const ROUTE_MUTEX_TIMEOUT_MS = 30_000;

export interface MasterInboxRouterDeps {
  ctx: SessionContext;
  master: MasterLifecycle;
  publisher: IMetaBusPublisher;
  /** Opcional — emite `master.inbox_received` para listeners (transcript SSE). */
  eventBus?: CompanyEventBus;
}

export interface MasterEnqueueArgs {
  fromAgentRunId: number;
  fromRole: string;
  kind: InboxKind;
  body: string;
  /** Token usado pelo sender em `waitForAnswer` quando `wait=true`. */
  waitToken?: string | null;
}

export interface MasterEnqueueResult {
  message: AgentInboxMessage;
  /** Heurística: true quando o master estava vivo no momento do enqueue. */
  deliveredImmediately: boolean;
}

/** Sentinel value used in `agent_inbox.to_role` to route to the master. */
export const MASTER_INBOX_SENTINEL = '__master__';

export class MasterInboxRouter {
  /**
   * Chain de promises que serializa drains concorrentes na mesma sessão.
   * Espelha {@link InboxQueue.drainMutexes} (por-`agentRunId`); aqui o
   * escopo é a sessão inteira porque só existe um master por sessão.
   */
  private routeMutex: Promise<void> = Promise.resolve();

  constructor(private readonly deps: MasterInboxRouterDeps) {}

  /**
   * Persiste a mensagem, publica `inbox_message_sent` e dispara um
   * drain assíncrono (fire-and-forget). O caller usa o `wait_token`
   * retornado em {@link InboxQueue.waitForAnswer} se quiser bloquear.
   */
  enqueueForMaster(args: MasterEnqueueArgs): MasterEnqueueResult {
    const alive = this.deps.master.isAlive;
    const message = this.deps.ctx.companyStore.createInboxMessage({
      companySessionId: this.deps.ctx.companySessionId,
      fromAgentRunId: args.fromAgentRunId,
      fromRole: args.fromRole,
      toRole: MASTER_INBOX_SENTINEL,
      toAgentRunId: null,
      kind: args.kind,
      body: args.body,
      waitToken: args.waitToken ?? null,
    });

    this.deps.publisher.publish('inbox_message_sent', {
      messageId: message.id,
      from: { agentRunId: args.fromAgentRunId, role: args.fromRole },
      to: { agentRunId: null, role: MASTER_INBOX_SENTINEL },
      kind: args.kind,
    });

    void this.tryDeliverNow();
    return { message, deliveredImmediately: alive };
  }

  /**
   * Drena todas as mensagens `pending` endereçadas ao master e entrega
   * em UMA chamada `master.notify`. Idempotente: chamar com fila vazia
   * é no-op. Serialização cross-process é garantida pelo `UPDATE ... WHERE
   * status='pending'` atômico no DAO; serialização in-process é o mutex.
   */
  async tryDeliverNow(): Promise<void> {
    const previous = this.routeMutex;
    let release!: () => void;
    const next = new Promise<void>((res) => {
      release = res;
    });
    const chained = previous.then(() => next);
    this.routeMutex = chained;
    try {
      // Wait for previous deliveries to settle — but only up to 30s.
      // If the chain wedges (e.g., master.notify never resolves because
      // resurrect is stuck), we reset the mutex below and proceed with
      // a fresh claim so the next subordinate doesn't sit forever.
      try {
        await raceWithTimeout(previous, ROUTE_MUTEX_TIMEOUT_MS, 'master_inbox_route');
      } catch (e) {
        if (isMutexTimeout(e)) {
          console.warn(
            `[company s=${this.deps.ctx.companySessionId}] master inbox routeMutex timed out — resetting chain and retrying`,
          );
          // Reset chain so future calls don't await the stuck `previous`.
          // The stuck promise keeps running in the background; we accept
          // the dangling work to keep the session functional. Publish
          // for visibility — admin / dashboard can surface the recovery.
          this.routeMutex = next;
          if (this.deps.eventBus) {
            this.deps.eventBus.emit({
              type: 'master.inbox_router_recovered',
              reason: 'mutex_timeout',
            });
          }
          // Fall through to claim — we still want to deliver.
        } else {
          throw e;
        }
      }
      const claimed = this.deps.ctx.companyStore.claimAllPendingMasterMessages(
        this.deps.ctx.companySessionId,
      );
      if (claimed.length === 0) return;

      for (const msg of claimed) {
        this.deps.publisher.publish('inbox_message_delivered', {
          messageId: msg.id,
          deliveredTo: { agentRunId: null, role: MASTER_INBOX_SENTINEL },
          success: true,
        });
      }

      if (this.deps.eventBus) {
        this.deps.eventBus.emit({
          type: 'master.inbox_received',
          messageIds: claimed.map((m) => m.id),
          fromRoles: Array.from(new Set(claimed.map((m) => m.from_role))),
        });
      }

      const combinedPrompt = formatMasterInboxPrompt(claimed);
      this.deps.master.notify(combinedPrompt);
    } finally {
      release();
      if (this.routeMutex === chained) {
        this.routeMutex = Promise.resolve();
      }
    }
  }

  /**
   * Boot-time / post-rehydration scan: chame ao construir um orchestrator
   * para a sessão. Se houver mensagens pendentes para master, dispara um
   * drain. Resolve o caso "Node restart com fila não consumida".
   */
  reviveIfPending(): void {
    const pending = this.deps.ctx.companyStore.listInboxMessages({
      companySessionId: this.deps.ctx.companySessionId,
      toRole: MASTER_INBOX_SENTINEL,
      status: 'pending',
      limit: 1,
    });
    if (pending.length === 0) return;
    void this.tryDeliverNow();
  }
}

/**
 * Format the combined prompt the master sees when one or more queued
 * messages are drained. Exported for tests.
 *
 * Format example (3 messages):
 *
 *   [INBOX — 3 message(s) from subordinates]
 *
 *   [from @backend, run=42, message_id=101, kind=question]
 *   How do you want me to handle auth headers?
 *
 *   [from @frontend, run=43, message_id=102, kind=question]
 *   Should the login button trigger an OAuth flow?
 *
 *   [from @qa, run=44, message_id=103, kind=notify]
 *   Smoke tests passing on the staging container.
 *
 *   Respond to question(s) via respond_to_inbox(message_id, answer).
 *   Notify(s) are FYI — no answer required.
 */
export function formatMasterInboxPrompt(messages: readonly AgentInboxMessage[]): string {
  if (messages.length === 0) return '';
  const lines: string[] = [];
  lines.push(`[INBOX — ${messages.length} message(s) from subordinates]`);
  for (const m of messages) {
    lines.push('');
    lines.push(
      `[from @${m.from_role}, run=${m.from_agent_run_id}, message_id=${m.id}, kind=${m.kind}]`,
    );
    lines.push(m.body);
  }
  const hasQuestion = messages.some((m) => m.kind === 'question');
  const hasNotify = messages.some((m) => m.kind === 'notify');
  lines.push('');
  if (hasQuestion && hasNotify) {
    lines.push(
      'Respond to question(s) via respond_to_inbox(message_id, answer). Notify(s) are FYI — no answer required.',
    );
  } else if (hasQuestion) {
    lines.push('Respond via respond_to_inbox(message_id, answer) for each question above.');
  } else {
    lines.push('FYI notification(s) from your team — no answer required.');
  }
  return lines.join('\n');
}
