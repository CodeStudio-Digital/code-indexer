/** Live command-output block (deploy / build / tail) with autoscroll, over the
 *  host's `mcp.execStream`. */
import { el } from './dom.js';
import { kitLabel } from './labels.js';
import { mcp, type StreamChunk } from './mcp.js';

export interface StreamLog {
  node: HTMLElement;
  append(text: string): void;
  /** Run `cmd args…` streaming into the log; returns when wired (not done). */
  start(cmd: string, args: string[]): void;
  stop(): void;
  running(): boolean;
}

export function streamLog(onStateChange?: () => void): StreamLog {
  const pre = el('pre', 'mcp-log');
  let close: (() => void) | null = null;
  const append = (s: string) => {
    pre.textContent += s;
    pre.scrollTop = pre.scrollHeight;
  };
  const stop = () => {
    if (close) {
      close();
      close = null;
      append(`\n${kitLabel('streamStopped')}\n`);
      onStateChange?.();
    }
  };
  return {
    node: pre,
    append,
    running: () => close !== null,
    stop,
    start(cmd, args) {
      stop();
      append(`$ ${cmd} ${args.join(' ')}\n`);
      close = mcp.execStream(cmd, args, {
        onData: (c: StreamChunk) => {
          if (c && c.type === 'data' && c.data) append(c.data);
        },
        onEnd: () => {
          close = null;
          append(`\n${kitLabel('streamDone')}\n`);
          onStateChange?.();
        },
        onError: (m) => {
          close = null;
          append(`\n[error] ${m}\n`);
          onStateChange?.();
        },
      });
      onStateChange?.();
    },
  };
}
