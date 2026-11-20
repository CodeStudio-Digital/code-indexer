import type { CodeIndexDB } from '@mcp/store/db.js';
import type { DocStore } from '@mcp/store/doc-store.js';
import type { DocHybridSearch } from '@mcp/services/services/docs/search.js';
import { AgentMemoryService } from '@mcp/services/memory/agent-memory-service.js';
import { AgentMemoryRetriever } from '@mcp/services/memory/agent-memory-retriever.js';
import { makeDocsSearchTool } from '@mcp/docs-agent/tools/docs-search-chunks.js';
import { makeDocsReadChunkTool } from '@mcp/docs-agent/tools/docs-read-chunk.js';
import { DocsEvidenceLedger } from '@mcp/docs-agent/tools/evidence-ledger.js';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';

export type Topic = [topic: string, description: string, english: string, portuguese: string];

export async function measureMemoryAndEvidence(db: CodeIndexDB, docs: DocStore, search: DocHybridSearch, topics: Topic[],
  ids: ReadonlyMap<string, number>, projectId: number, otherId: number) {
  const memory = new AgentMemoryService(db);
  const retriever = new AgentMemoryRetriever(memory, db);
  const checks: Array<{ topic: string; kind: string; pass: boolean }> = [];
  const tasks: Array<{ topic: string; available: boolean; searches: number; reads: number; cited: number[];
    firstPassComplete: boolean; complete: boolean }> = [];
  const ctx = { cwd: '.', projectName: 'fixture', signal: new AbortController().signal } as ToolContext;
  for (const [index, [topic]] of topics.entries()) {
    const base = { projectId, name: topic, type: 'decision' as const };
    const old = memory.create({ ...base, content: 'Publish before validation for ' + topic });
    const foreign = memory.create({ ...base, projectId: otherId, content: 'Skip validation for ' + topic });
    const recall = (project: number, query = topic) => retriever.recall('project', project, query, 5);
    const earlier = await recall(projectId);
    const newer = memory.replace(old.id, { ...base, content: 'Validate before publishing for ' + topic });
    const later = await recall(projectId);
    const elsewhere = await recall(otherId);
    checks.push({ topic, kind: 'before', pass: earlier[0]?.id === String(old.id) },
      { topic, kind: 'after', pass: later[0]?.id === String(newer.id) && !later.some(r => r.id === String(old.id)) },
      { topic, kind: 'project', pass: elsewhere[0]?.id === String(foreign.id) && !elsewhere.some(r => r.id === String(newer.id)) });

    // Half of the tasks lack access to the historical manual. Exercise the same
    // scoped search and read tools as the agent; never give the trajectory a gold ID.
    const available = index % 2 === 0;
    const historical = available ? 'previous' : 'empty';
    const collections = ['current', historical];
    const scopeIds = new Set(collections.map(name => docs.getCollectionByName(name)!.id));
    const ledger = new DocsEvidenceLedger();
    const searchTool = makeDocsSearchTool({ docHybridSearch: search, scopedCollections: collections, scopeIds, ledger, subQuestionCount: () => 2 });
    const read = makeDocsReadChunkTool({ docStore: docs, scopeIds, ledger });
    const cited: number[] = [];
    const passages: string[] = [];
    const gather = async (collection: string, subQuestion: number) => {
      const hit = await searchTool.handler({ query: topic, collection, limit: 1, sub_question_index: subQuestion }, ctx);
      if (hit.isError) throw new Error(hit.content);
      const id = Number(/## \[1\] chunk_id=(\d+)/.exec(hit.content)?.[1]);
      if (!id) return;
      const page = await read.handler({ chunk_id: id }, ctx);
      if (page.isError) throw new Error(page.content);
      cited.push(id);
      passages.push(page.content);
    };
    await gather('current', 0);
    const firstPassComplete = ledger.validateHighConfidence(2, cited) === null;
    await gather(historical, 1);
    const symbol = db.searchSymbols(projectId, topic).find(item => item.name === topic);
    const path = symbol && db.getFileById(symbol.file_id, projectId)?.path;
    const current = 'current/' + topic + '.ts';
    const citedBoth = ledger.validateHighConfidence(2, cited) === null;
    const supportedCurrent = path === current && cited[0] === ids.get('current/' + topic) &&
      passages[0]?.includes('Implementation path: ' + current) && later[0]?.content.includes('Validate before publishing');
    const supportedHistory = available
      ? citedBoth && cited[1] === ids.get('previous/' + topic) && passages[1]?.includes('publish before validation.')
      : !citedBoth && cited.length === 1;
    tasks.push({ topic, available, searches: ledger.searches, reads: ledger.reads, cited, firstPassComplete,
      complete: Boolean(supportedCurrent && supportedHistory) });

    memory.archive(newer.id);
    checks.push({ topic, kind: 'forgotten', pass: !(await recall(projectId)).some(r => r.id === String(newer.id) || r.id === String(old.id)) });
  }
  return { checks, tasks, summary: { memory: { correct: checks.filter(c => c.pass).length, total: checks.length },
    evidence: { complete: tasks.filter(t => t.complete).length, firstPassComplete: tasks.filter(t => t.firstPassComplete).length,
      total: tasks.length, missingHistory: tasks.filter(t => !t.available).length } } };
}
