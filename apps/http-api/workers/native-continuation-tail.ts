import { create } from '@bufbuild/protobuf';
import { agentV1Runtime as wire, agentV1SessionStore as journal } from '@mcp/agent-runtime-contracts';
import { NativeContentAssembler } from '@mcp/agent-runtime-host';

/** Reconstruct only confirmed text after a provider frontier. Capability
 * boundaries require their own settled checkpoint and cannot use this path. */
export class NativeContinuationTail {
  private content = new NativeContentAssembler();
  private operation?: string;
  private blocks: Array<{ thinking: boolean; chunks: string[] }> = [];
  private bytes = 0;
  private interrupted = false;
  private capabilities = false;
  private usage = false;

  reset(operationId?: string): void {
    this.content.assertComplete();
    this.content = new NativeContentAssembler();
    this.operation = operationId; this.blocks = []; this.bytes = 0;
    this.interrupted = false; this.capabilities = false;
    this.usage = false;
  }

  accept(event: journal.EngineEventRecordV1): void {
    const body = event.body;
    if (body.case === 'providerStarted') {
      // ProviderAccepted and the checkpoint commit may race in the journal;
      // the frontier below must still precede any actual provider content.
      if (this.operation && this.operation !== body.value.operationId) this.capabilities = true;
      this.operation = body.value.operationId;
    } else if (body.case === 'content') {
      const bytes = this.content.append(body.value);
      if (body.value.kind !== journal.EngineContentKindV1.TRANSCRIPT) { this.capabilities = true; return; }
      if (body.value.operationId !== this.operation) throw new Error('Native continuation text belongs to a different operation');
      if (!bytes) return;
      this.bytes += bytes.length;
      if (this.bytes > 8 * 1024 * 1024) throw new Error('Native continuation tail exceeds its bound');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const thinking = body.value.thinking;
      const last = this.blocks.at(-1);
      if (last?.thinking === thinking) last.chunks.push(text);
      else {
        if (this.blocks.length >= 8192) throw new Error('Native continuation tail has too many blocks');
        this.blocks.push({ thinking, chunks: [text] });
      }
    } else if (body.case === 'providerUsage') {
      if (body.value.operationId !== this.operation) throw new Error('Native continuation usage belongs to a different operation');
      this.usage = true;
    } else if (body.case === 'terminal') {
      this.content.assertComplete();
      this.interrupted = body.value.classification === journal.EngineTerminalClassificationV1.INTERRUPTED;
    } else if (body.case?.startsWith('capability') || body.case === 'providerCompleted') {
      this.capabilities = true;
    }
  }

  messages(): wire.ProviderMessage[] {
    this.content.assertComplete();
    if (!this.interrupted || this.capabilities || (!this.blocks.length && !this.usage)) return [];
    return [create(wire.ProviderMessageSchema, {
      role: wire.ProviderMessageRole.ASSISTANT, phase: wire.ProviderMessagePhase.COMMENTARY,
      content: this.blocks.map(block => create(wire.ProviderContentBlockSchema, {
        body: { case: block.thinking ? 'thinking' : 'text', value: create(wire.ProviderTextContentSchema, {
          body: { case: 'inlineUtf8', value: block.chunks.join('') },
        }) },
      })),
    })];
  }
}
