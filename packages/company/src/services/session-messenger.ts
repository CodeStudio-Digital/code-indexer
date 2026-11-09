import { createHash, randomUUID } from 'node:crypto';
import { watch } from 'node:fs';
import { join } from 'node:path';
import { CollaborationFiles } from '@mcp/session-storage/collaboration/files.js';
import { CompanySessionFiles } from './CompanySessionFiles.js';
import type { AgentInboxMessage, InboxKind } from '@mcp/company/types.js';

export interface CompanyMessageInput {
  targetSessionId: string;
  targetAgentRunId?: string;
  targetRole?: string;
  fromAgentRunId?: string;
  body: string;
  kind?: InboxKind;
  idempotencyKey: string;
}
/** Reuses each session's durable inbox. Only addressing/admission is company-wide;
 * responses and delivery continue using the existing inbox implementation. */
export class CompanySessionMessenger {
  constructor(private readonly source: CompanySessionFiles) {}
  private async target(id: string): Promise<CompanySessionFiles> {
    const store = this.source.sessionStore;
    if (!store.catalog.get(id)) await store.refresh();
    const target = new CompanySessionFiles({ companySessionId: id, sessionStore: store });
    const from = this.source.getSession(); const to = target.getSession();
    if ((from.parent_session_id ?? from.id) !== (to.parent_session_id ?? to.id)) throw new Error('Messages cannot cross company boundaries');
    if (to.archived_at) throw new Error('Target session is archived');
    return target;
  }
  async send(input: CompanyMessageInput, origin: 'agent' | 'operator' = 'agent'): Promise<AgentInboxMessage> {
    const target = await this.target(input.targetSessionId);
    if (!input.body.trim() || input.body.length > 32_000 || !input.idempotencyKey?.trim()) throw new Error('A message needs an idempotency key and 1–32000 characters');
    const sender = input.fromAgentRunId ? this.source.getAgentRunSync(input.fromAgentRunId) : null;
    if (origin === 'agent' && !sender) throw new Error('Unknown source agent in this session');
    let targetRole = input.targetRole;
    if (targetRole === 'master') targetRole = '__master__';
    if (!targetRole && !input.targetAgentRunId) throw new Error('Provide targetRole or targetAgentRunId');
    if (input.targetAgentRunId) {
      const run = target.getAgentRunSync(input.targetAgentRunId);
      if (!run || (targetRole && targetRole !== run.role)) throw new Error('Target agent does not belong to the selected session/role');
      targetRole = run.role === 'master' ? '__master__' : run.role;
    } else if (targetRole !== '__master__' && !target.listAgentRunsSync().some(run => run.role === targetRole && !run.archive_id)) {
      throw new Error('Target role has no registered agent in this session');
    }
    const sourceSession = this.source.getSession();
    const rootId = sourceSession.parent_session_id ?? sourceSession.id;
    const root = rootId === sourceSession.id ? this.source : await this.target(rootId);
    const journal = new CollaborationFiles(join(root.location.bundle_path, 'company', 'message-routing'));
    await journal.ensure('requests');
    const actor = origin === 'operator' ? this.source.companySessionId : sender!.id;
    const body = input.body.trim(); const kind = input.kind ?? 'notify';
    const hash = createHash('sha256').update(JSON.stringify({ target: target.companySessionId, role: targetRole, agent: input.targetAgentRunId, body, kind })).digest('hex');
    const key = `${this.source.companySessionId}:${actor}:${input.idempotencyKey}`;
    const request = await journal.insert('requests', key, { id: randomUUID(), hash });
    if (request.hash !== hash) throw new Error('Message idempotency key belongs to another payload');
    const existing = target.getInboxMessageSync(request.id);
    if (existing) return existing;
    try {
      return target.createInboxMessageSync({
        id: request.id, fromSessionId: this.source.companySessionId, origin,
        fromAgentRunId: actor, fromRole: origin === 'operator' ? 'human' : sender!.role,
        toAgentRunId: targetRole === '__master__' ? null : input.targetAgentRunId, toRole: targetRole,
        body, kind,
      });
    } catch (error) {
      // A concurrent identical request may have committed the same durable row.
      const committed = target.getInboxMessageSync(request.id);
      if (committed) return committed;
      throw error;
    }
  }
  async wait(targetSessionId: string, messageId: string, signal?: AbortSignal, timeoutMs = 20 * 60_000): Promise<string> {
    const target = await this.target(targetSessionId);
    const directory = target.ensureCompanyEntityDirectorySync('inbox-messages');
    return new Promise<string>((resolve, reject) => {
      const finish = (error?: unknown, answer?: string) => {
        watcher.close(); clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(answer ?? '');
      };
      const check = () => {
        try {
          const message = target.getInboxMessageSync(messageId);
          if (!message || message.from_session_id !== this.source.companySessionId) return finish(new Error('Message does not belong to this source session'));
          if (['answered', 'cancelled', 'expired'].includes(message.status)) finish(undefined, message.answer ?? '(no answer)');
        } catch (error) { finish(error); }
      };
      const abort = () => finish(signal?.reason ?? new Error('Message wait cancelled'));
      const watcher = watch(directory, { persistent: false }, check);
      watcher.on('error', error => finish(error));
      const timer = setTimeout(() => finish(new Error('Message remains pending; wait deadline reached')), timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort(); else check();
    });
  }
}
