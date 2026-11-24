interface CompanyChat {
  id: string;
  parent_session_id?: string | null;
  created_at?: string;
  metadata?: Readonly<Record<string, unknown>>;
}

function companyId(chat: CompanyChat): string | undefined {
  const id = chat.metadata?.company_session_id ?? chat.metadata?.companySessionId;
  return typeof id === 'string' ? id : undefined;
}

/** The durable parent is the Company container. Resolve the visible Master chat separately. */
export function companyChatParents(chats: readonly CompanyChat[]): Map<string, string> {
  const masters = new Map<string, CompanyChat[]>();
  for (const chat of chats) {
    const company = companyId(chat);
    if (!company || chat.metadata?.company_role !== 'master') continue;
    const group = masters.get(company);
    if (group) group.push(chat);
    else masters.set(company, [chat]);
  }
  const parents = new Map<string, string>();
  for (const chat of chats) {
    const company = companyId(chat);
    if (!company || chat.metadata?.company_role === 'master' || !chat.metadata?.company_role) continue;
    const group = masters.get(company);
    if (!group) continue;
    const explicit = chat.metadata.company_master_chat_id ?? (chat.parent_session_id === company ? undefined : chat.parent_session_id);
    let master: CompanyChat | undefined;
    if (explicit != null) master = group.find(candidate => candidate.id === explicit);
    else if (group.length === 1) master = group[0];
    else {
      // Before parent IDs were recorded, a replacement Master started a new generation.
      const time = Date.parse(chat.created_at ?? '');
      let latest = -Infinity;
      for (const candidate of group) {
        const start = Date.parse(candidate.created_at ?? '');
        if (!(start <= time) || start < latest) continue;
        master = start === latest ? undefined : candidate;
        latest = start;
      }
    }
    if (master) parents.set(chat.id, master.id);
  }
  return parents;
}
