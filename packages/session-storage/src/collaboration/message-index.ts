import type { ChatMessage } from './types.js';
import { keyOf, type CollaborationFiles } from './files.js';

/** Derived recipient/correlation indexes. Publish references before the message:
 * a crash may leave a harmless dangling reference, never an acknowledged message
 * absent from its recipient index. Legacy data is indexed lazily once. */
export class CollaborationMessageIndex {
  constructor(readonly files: CollaborationFiles) {}
  private namespace(kind: 'participant' | 'response', key: string): string { return `message-index/${kind}-${keyOf(key)}`; }
  async prepare(message: Pick<ChatMessage, 'id' | 'from' | 'to' | 'replyTo'>): Promise<void> {
    const targets = [this.namespace('participant', message.from), this.namespace('participant', message.to),
      ...(message.replyTo ? [this.namespace('response', message.replyTo)] : [])];
    for (const kind of targets) {
      await this.files.ensure(kind);
      await this.files.insert(kind, message.id, { id: message.id });
    }
  }
  async read(kind: 'participant' | 'response', key: string): Promise<ChatMessage[]> {
    const namespace = this.namespace(kind, key);
    await this.files.ensure(namespace);
    if (!await this.files.get('checkpoints', `message-index:${namespace}`)) {
      for (const message of await this.files.list<ChatMessage>('messages')) {
        if (kind === 'participant' ? message.from === key || message.to === key : message.replyTo === key) {
          await this.files.insert(namespace, message.id, { id: message.id });
        }
      }
      await this.files.insert('checkpoints', `message-index:${namespace}`, { schemaVersion: 1, ready: true });
    }
    const rows: ChatMessage[] = [];
    for (const ref of await this.files.list<{ id: string }>(namespace)) {
      const message = await this.files.get<ChatMessage>('messages', ref.id);
      if (message && (kind === 'participant' ? message.from === key || message.to === key : message.replyTo === key)) rows.push(message);
    }
    return rows;
  }
}
