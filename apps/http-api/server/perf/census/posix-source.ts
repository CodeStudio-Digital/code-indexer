/**
 * POSIX collector: one `ps` per tick.
 *
 * No resident process here — `ps` runs in 10-20ms and hands back the full
 * command line for free, so the Windows trade (pay a 1.5s boot once, keep a
 * child alive, cache command lines per pid) buys nothing.
 *
 * `time`/`etime` rather than the procps-only `cputime`/`etimes` keeps the same
 * invocation working on macOS's BSD `ps`.
 */
import { execFile } from 'node:child_process';
import { parsePosixFrame } from '@mcp/shared/utils/process-census/parse-posix.js';
import { BaseCensusSource } from './census-source.js';

const PS_ARGS = ['-eo', 'pid=,ppid=,rss=,time=,etime=,comm=,args='];
/** A machine with thousands of processes still fits well inside this. */
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_CONSECUTIVE_FAILURES = 3;

export class PosixCensusSource extends BaseCensusSource {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private failures = 0;

  start(intervalMs: number): void {
    if (this.timer) return;
    this.failures = 0;
    this.setStatus('warming');
    this.collect();
    this.timer = setInterval(() => this.collect(), Math.max(500, intervalMs));
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.clearFrames();
    this.setStatus('stopped');
  }

  private collect(): void {
    // A `ps` that has not returned yet means the box is loaded; queueing more
    // of them would make it worse.
    if (this.inFlight) return;
    this.inFlight = true;
    const at = Date.now();
    execFile('ps', PS_ARGS, { maxBuffer: MAX_STDOUT_BYTES }, (error, stdout) => {
      this.inFlight = false;
      if (error || !stdout) {
        this.failures += 1;
        if (this.failures >= MAX_CONSECUTIVE_FAILURES) this.setStatus('failed');
        return;
      }
      const frame = parsePosixFrame(stdout, at);
      if (frame.rows.length === 0) return;
      this.failures = 0;
      this.acceptFrame(frame);
    });
  }
}
