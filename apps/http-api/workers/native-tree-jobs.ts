import { createHash } from 'node:crypto';
import { ok, type ToolResult } from '@mcp/code-agent/core/tool.js';
import { isUncertainToolOutcomeError, uncertainToolOutcomeError } from '@mcp/code-agent/core/uncertain-tool-outcome.js';
import type { NativeTreePersist } from './native-tree-mailbox.js';

interface Job { id: string; done: Promise<void>; result?: ToolResult; error?: unknown; uncertain?: boolean; collected: boolean }
/** Background lifetime belongs to the admitted attempt, never a detached
 * legacy manager. Both admission and terminal payload are durable receipts. */
export class NativeTreeJobs {
  private readonly jobs = new Map<string, Job>();
  private readonly changed = new Set<() => void>();
  private closed = false;
  constructor(private readonly persist: NativeTreePersist, private readonly signal: AbortSignal) {}
  async start(input: { invocationId: string; task: unknown; signal?: AbortSignal }, run: (signal: AbortSignal) => Promise<ToolResult>): Promise<ToolResult> {
    this.assertOpen(); input.signal?.throwIfAborted();
    if (!input.invocationId || input.invocationId.length > 512 || this.jobs.size >= 64) throw new Error('Invalid or excessive native background admission');
    const id = `native-job-${createHash('sha256').update(input.invocationId).digest('hex')}`;
    if (this.jobs.has(id)) throw uncertainToolOutcomeError(id);
    try {
      if (!await this.persist(`native-tree:job:${id}`, { schema: 1, type: 'job', jobId: id, task: input.task })) throw uncertainToolOutcomeError(id);
    } catch (cause) { throw Object.assign(uncertainToolOutcomeError(id), { cause }); }
    this.assertOpen();
    const job: Job = { id, done: Promise.resolve(), collected: false };
    this.jobs.set(id, job);
    job.done = Promise.resolve().then(() => run(this.signal)).then(async result => {
      // Cancellation may reject the durable result write. It cannot erase
      // an uncertainty already reported by the owned child executor.
      job.uncertain = result.effectOutcome === 'unknown';
      const durable = boundedResult(result);
      if (!await this.persist(`native-tree:result:${id}`, { schema: 1, type: 'result', jobId: id, result: durable })) throw uncertainToolOutcomeError(id);
      job.result = durable;
    }).catch(cause => { job.error = cause; }).finally(() => { for (const changed of [...this.changed]) changed(); });
    return { ...ok(`Native background job ${id} admitted. Use collect_agents({job_id:"${id}"}) for the result. The job remains owned by this execution tree.`),
      structuredData: { kind: 'spawn_agent_background_result', status: 'running', jobId: id } };
  }
  async collect(options: { jobId?: string; timeoutMs: number; signal?: AbortSignal }): Promise<ToolResult> {
    this.assertOpen(); options.signal?.throwIfAborted();
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0 || options.timeoutMs > 1_800_000) throw new Error('Invalid native collection timeout');
    if (options.jobId && !this.jobs.has(options.jobId)) throw new Error('Native background job is not owned by this attempt; reconcile durable history instead of re-spawning');
    const selected = () => [...this.jobs.values()].filter(job => options.jobId ? job.id === options.jobId : !job.collected);
    if (!selected().length) return ok('collect_agents: no outstanding native background jobs.');
    const terminal = () => selected().find(job => job.result || job.error !== undefined);
    if (!terminal() && options.timeoutMs) await new Promise<void>((resolve, reject) => {
      const signals = AbortSignal.any([this.signal, options.signal].filter((s): s is AbortSignal => !!s));
      const cleanup = () => { clearTimeout(timer); this.changed.delete(check); signals.removeEventListener('abort', abort); };
      const check = () => { if (terminal()) { cleanup(); resolve(); } };
      const abort = () => { cleanup(); reject(signals.reason); };
      const timer = setTimeout(() => { cleanup(); resolve(); }, options.timeoutMs);
      this.changed.add(check); signals.addEventListener('abort', abort, { once: true });
      if (signals.aborted) abort(); else check();
    });
    this.assertOpen(); options.signal?.throwIfAborted();
    const job = terminal();
    if (!job) return { ...ok('Native jobs remain running. Continue useful work; do not re-spawn them.'),
      structuredData: { kind: 'collect_agents_pending', jobs: selected().map(job => job.id) } };
    if (job.error !== undefined) throw Object.assign(uncertainToolOutcomeError(job.id), { cause: job.error });
    job.collected = true;
    return { ...job.result!, structuredData: { kind: 'collect_agents_result', jobId: job.id,
      status: job.result!.isError ? 'failed' : 'completed', result: job.result!.structuredData } };
  }
  async drain() {
    await Promise.all([...this.jobs.values()].map(job => job.done));
    const uncertain = [...this.jobs.values()].find(job => job.uncertain || job.result?.effectOutcome === 'unknown'
      || job.error !== undefined && (!this.signal.aborted || isUncertainToolOutcomeError(job.error)));
    if (uncertain) throw Object.assign(uncertainToolOutcomeError(uncertain.id), { cause: uncertain.error });
  }
  close() { this.closed = true; }
  private assertOpen() { this.signal.throwIfAborted(); if (this.closed) throw new Error('Native background owner is closed'); }
}
function boundedResult(result: ToolResult): ToolResult {
  const content = typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
  const bytes = Buffer.from(content);
  const structured = result.structuredData;
  const structuredBytes = structured === undefined ? 0 : Buffer.byteLength(JSON.stringify(structured));
  const structuredData = structuredBytes <= 64 * 1024 ? structured : {
    truncated: true, originalSize: structuredBytes,
    ...Object.fromEntries(['nativeTranscriptRef', 'spawnId', 'reason'].flatMap(key => {
      const value = structured && typeof structured === 'object' ? (structured as Record<string, unknown>)[key] : undefined;
      return typeof value === 'string' && value.length <= 1024 ? [[key, value]] : [];
    })),
  };
  return { content: bytes.subarray(0, 64 * 1024).toString('utf8').replace(/\uFFFD$/, ''),
    isError: result.isError, error: result.error, effectOutcome: result.effectOutcome, subUsage: result.subUsage,
    ...(bytes.length > 64 * 1024 ? { truncated: true, originalSize: bytes.length } : {}),
    structuredData };
}
