import type {
  DurableSupervisorFactPort,
  SupervisorFactBinding,
  SupervisorLifecycleFact,
} from './HostSupervisorFactTypes.js';
import { HostSupervisorFactError } from './HostSupervisorFactError.js';

const MAX_INT64 = (1n << 63n) - 1n;

export async function commitDurableSupervisorFact(
  port: DurableSupervisorFactPort,
  fact: SupervisorLifecycleFact,
  binding: SupervisorFactBinding,
  timeoutMs: number,
  nowUnixMs: () => bigint,
  callerSignal?: AbortSignal,
): Promise<void> {
  const controller = new AbortController();
  const timeoutFailure = new HostSupervisorFactError(
    'durable_commit_timeout',
    'durable supervisor fact commit exceeded its deadline',
  );
  const forwardAbort = () => {
    if (!controller.signal.aborted) {
      controller.abort(aborted(callerSignal?.reason));
    }
  };
  callerSignal?.addEventListener('abort', forwardAbort, { once: true });
  let timer: NodeJS.Timeout | undefined;
  let rejectOnAbort: (() => void) | undefined;
  try {
    if (callerSignal?.aborted) forwardAbort();
    throwIfAborted(controller.signal);
    const commitStartedAtUnixMs = nowUnixMs();
    if (callerSignal?.aborted) forwardAbort();
    throwIfAborted(controller.signal);
    const deadlineAtUnixMs = commitStartedAtUnixMs + BigInt(timeoutMs);
    if (
      commitStartedAtUnixMs <= 0n
      || commitStartedAtUnixMs > MAX_INT64
      || deadlineAtUnixMs > MAX_INT64
    ) {
      throw new HostSupervisorFactError(
        'invalid_header',
        'durable commit deadline exceeds the owner clock domain',
      );
    }
    timer = setTimeout(
      () => controller.abort(timeoutFailure),
      timeoutMs,
    );
    timer.unref();
    const cancellation = new Promise<never>((_resolve, reject) => {
      if (controller.signal.aborted) {
        reject(controller.signal.reason);
      } else {
        rejectOnAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener(
          'abort',
          rejectOnAbort,
          { once: true },
        );
      }
    });
    const control = Object.freeze({
      signal: controller.signal,
      deadlineAtUnixMs,
      idempotencyKey: idempotencyKey(binding),
    });
    throwIfAborted(controller.signal);
    const operation = Promise.resolve(port.commit(fact, binding, control));
    await Promise.race([operation, cancellation]);
  } finally {
    if (timer) clearTimeout(timer);
    callerSignal?.removeEventListener('abort', forwardAbort);
    if (rejectOnAbort) {
      controller.signal.removeEventListener('abort', rejectOnAbort);
    }
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof HostSupervisorFactError
    ? signal.reason
    : aborted(signal.reason);
}

function idempotencyKey(binding: SupervisorFactBinding): string {
  return `management-supervisor-fact:v1:${
    Buffer.from(binding.envelopeSha256).toString('hex')
  }`;
}

function aborted(cause: unknown): HostSupervisorFactError {
  return new HostSupervisorFactError(
    'aborted',
    'management fact processing was aborted',
    cause === undefined ? undefined : { cause },
  );
}
