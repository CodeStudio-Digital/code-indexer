import { asCompanySessionId, asSessionId, isUuid } from '@mcp/session-storage';
import type { FsSessionStore } from '@mcp/session-storage/fs-store/fs-session-store.js';
import type { FsCoderSession } from '@mcp/session-storage/fs-store/types.js';
import { companyChatParents } from '@mcp/agent-runtime-contracts/company-chat-lineage.js';
import type { ChatNetworkSnapshot } from '@mcp/agent-runtime-contracts/chat-network.js';
import { CompanySessionFiles } from '@mcp/company/services/CompanySessionFiles.js';

/** Read-only relationship. Opening the graph must never start or grant messaging access to a Company agent. */
export async function companyTeamForChat(store: FsSessionStore, chat: FsCoderSession): Promise<ChatNetworkSnapshot['companyTeam']> {
  const id = chat.metadata?.company_session_id ?? chat.metadata?.companySessionId;
  if (typeof id !== 'string' || !isUuid(id) || !chat.metadata.company_role) return;
  await store.ensureCatalog();
  const entry = store.catalog.get(asSessionId(id));
  if (!entry || (entry.session.kind !== 'company' && entry.session.kind !== 'app_studio')) return;
  const files = new CompanySessionFiles({ sessionStore: store, companySessionId: asCompanySessionId(id) });
  const runs = files.listAgentRunsSync().filter(run => !run.archive_id);
  if (!runs.some(run => run.coder_session_id === chat.id)) return;
  const chats = [];
  const members = new Map<string, NonNullable<ChatNetworkSnapshot['companyTeam']>['members'][number]>();
  for (const run of runs) {
    const participant = store.catalog.get(asSessionId(run.coder_session_id))?.session;
    if (participant?.kind !== 'coder' || participant.archived_at || (participant.metadata.company_session_id ?? participant.metadata.companySessionId) !== id) continue;
    chats.push(participant);
    members.set(participant.id, {
      id: participant.id, role: run.role, state: run.status, title: participant.title ?? run.role,
      projectId: participant.storage_scope.kind === 'project' ? participant.storage_scope.project_id : null,
      provider: run.provider, model: run.model,
    });
  }
  const parents = companyChatParents(chats);
  const masterId = chat.metadata.company_role === 'master' ? chat.id : parents.get(chat.id);
  if (!masterId || !members.has(masterId) || !members.has(chat.id)) return;
  return { masterId, members: [...members.values()].filter(member => member.id === masterId || parents.get(member.id) === masterId) };
}
