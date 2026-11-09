import { describe, expect, it } from 'vitest';
import { MarkdownWorkerQueue, type MarkdownWorkerPort } from '../markdown-worker-client.js';

function fixture() {
  const ports: Array<MarkdownWorkerPort & { sent: Array<{ id: number; text: string }>; terminated: number }> = [];
  const queue = new MarkdownWorkerQueue(() => {
    const port = { sent: [] as Array<{ id: number; text: string }>, terminated: 0,
      onmessage: null, onerror: null, postMessage(value: { id: number; text: string }) { this.sent.push(value); },
      terminate() { this.terminated++; } };
    ports.push(port); return port;
  });
  const complete = () => {
    const port = ports.at(-1)!;
    port.onmessage?.({ data: { id: port.sent.at(-1)!.id, document: { rows: [], anchors: {} } } } as MessageEvent);
  };
  return { queue, ports, complete };
}

describe('shared Markdown parser lifecycle', () => {
  it('coalesces streaming bursts to the latest text while one parse is active', () => {
    const { queue, ports, complete } = fixture();
    let received = 0;
    const owner = queue.acquire(() => received++);
    owner.update('first');
    for (let index = 0; index < 1000; index++) owner.update(`first-last-${index}`);
    expect(ports[0].sent).toHaveLength(1);
    complete();
    expect(ports[0].sent.map(value => value.text)).toEqual(['first', 'first-last-999']);
    complete();
    expect(received).toBe(2);
    owner.dispose();
    expect(ports[0].terminated).toBe(1);
  });

  it('never publishes an obsolete answer after a non-prefix replacement', () => {
    const { queue, ports, complete } = fixture();
    const sources: Array<string | undefined> = [];
    const owner = queue.acquire(result => sources.push(result.source));
    owner.update('old response'); owner.update('edited response');
    complete(); expect(sources).toEqual([]);
    expect(ports[0].sent.at(-1)?.text).toBe('edited response');
    complete(); expect(sources).toEqual(['edited response']);
    owner.dispose();
  });

  it('disposing one consumer drops late results without terminating another consumer', () => {
    const { queue, ports, complete } = fixture();
    let firstResults = 0; let secondResults = 0;
    const first = queue.acquire(() => firstResults++);
    const second = queue.acquire(() => secondResults++);
    first.update('first'); second.update('second');
    first.dispose(); first.dispose(); first.update('must-not-revive');
    expect(ports[0].terminated).toBe(0);
    complete(); complete();
    expect(firstResults).toBe(0); expect(secondResults).toBe(1);
    expect(ports[0].sent.map(value => value.text)).toEqual(['first', 'second']);
    second.dispose();
    expect(ports[0].terminated).toBe(1);
  });

  it('cleanup/remount creates a new worker and does not retain the old callback', () => {
    const { queue, ports, complete } = fixture();
    let stale = 0; let fresh = 0;
    const first = queue.acquire(() => stale++); first.update('old'); first.dispose();
    expect(ports[0].onmessage).toBeNull();
    const second = queue.acquire(() => fresh++); second.update('new'); complete(); second.dispose();
    expect(stale).toBe(0); expect(fresh).toBe(1);
    expect(ports).toHaveLength(2);
    expect(ports.every(port => port.terminated === 1)).toBe(true);
  });
});
