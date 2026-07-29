/**
 * Windows collector: one resident `powershell.exe` streaming census frames.
 *
 * Measured behaviour of the real thing (Windows 11 build 26200, ~420 procs):
 * first frame lands ~1s after spawn with 271 command lines resolved, each
 * later frame carries only the 2-4 that appeared since. The main-thread cost
 * on this side is splitting ~19KB of text per frame — the ~300ms enumeration
 * is the child's CPU, not ours.
 *
 * Note the requested interval is the child's *sleep* between queries, so the
 * effective period is interval + query time (~1.3s for a 1s interval). That is
 * the right trade: a fixed period would have the child spinning on a slow box.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { trackProcessTree } from '@mcp/shared/utils/process-tree.js';
import {
  createWindowsFrameAssembler,
  type WindowsFrameAssembler,
} from '@mcp/shared/utils/process-census/parse-windows.js';
import { BaseCensusSource } from './census-source.js';
import { buildWindowsCensusCommand } from './windows-script.js';

/** A frame is ~19KB; anything past this means the stream lost its newlines. */
const MAX_BUFFER_BYTES = 2 * 1024 * 1024;
const RESTART_BACKOFF_MS = [1_000, 4_000, 15_000];

export class WindowsCensusSource extends BaseCensusSource {
  private child: ChildProcess | null = null;
  private assembler: WindowsFrameAssembler = createWindowsFrameAssembler();
  private buffer = '';
  private failures = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private untrack: (() => void) | null = null;
  private stopped = true;
  private intervalMs = 2_000;

  start(intervalMs: number): void {
    this.intervalMs = intervalMs;
    if (this.child) return;
    this.stopped = false;
    this.setStatus('warming');
    this.launch();
  }

  stop(): void {
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.teardownChild();
    this.clearFrames();
    this.setStatus('stopped');
  }

  private teardownChild(): void {
    const child = this.child;
    this.child = null;
    this.buffer = '';
    this.assembler.reset();
    this.untrack?.();
    this.untrack = null;
    if (!child) return;
    child.stdout?.removeAllListeners();
    child.stderr?.removeAllListeners();
    child.removeAllListeners();
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }

  private launch(): void {
    let child: ChildProcess;
    try {
      child = spawn(
        'powershell.exe',
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
          '-EncodedCommand', buildWindowsCensusCommand(this.intervalMs)],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch {
      this.scheduleRestart();
      return;
    }

    this.child = child;
    // Registers the pid with the shared tracker, which `runtime-shutdown`
    // already drains on both the graceful and the crash path — that is what
    // guarantees no orphaned powershell.exe survives the app.
    this.untrack = trackProcessTree(child.pid);
    child.unref();

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => this.consume(chunk));
    // stderr is drained but ignored: PowerShell writes non-fatal warnings there
    // and an unread pipe would eventually block the child.
    child.stderr?.resume();
    child.once('error', () => this.scheduleRestart());
    child.once('exit', () => this.scheduleRestart());
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > MAX_BUFFER_BYTES) {
      // Falling behind is recoverable; a runaway buffer is not.
      this.buffer = '';
      this.assembler.reset();
      return;
    }
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      const frame = this.assembler.push(line);
      if (frame) {
        this.failures = 0;
        this.acceptFrame(frame);
      }
      index = this.buffer.indexOf('\n');
    }
  }

  private scheduleRestart(): void {
    if (this.stopped || this.restartTimer) return;
    this.teardownChild();
    this.clearFrames();

    const delay = RESTART_BACKOFF_MS[Math.min(this.failures, RESTART_BACKOFF_MS.length - 1)];
    this.failures += 1;
    if (this.failures > RESTART_BACKOFF_MS.length) {
      // Group policy can block -EncodedCommand outright. Give up loudly in the
      // payload rather than respawning forever; the panel falls back to the
      // Electron-only process rows.
      this.setStatus('failed');
      return;
    }

    this.setStatus('warming');
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopped) this.launch();
    }, delay);
    this.restartTimer.unref?.();
  }
}
