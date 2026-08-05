export class ShadowAttemptAbortLink {
  #controller?: AbortController;
  #unlink?: () => void;

  start(
    external: AbortSignal,
    onAbort: (cause: unknown) => void,
  ): AbortSignal {
    const controller = new AbortController();
    this.#controller = controller;
    const abort = () => onAbort(external.reason);
    if (external.aborted) {
      abort();
      return controller.signal;
    }
    external.addEventListener('abort', abort, { once: true });
    this.#unlink = () => { external.removeEventListener('abort', abort); };
    return controller.signal;
  }

  complete(): void {
    this.#controller = undefined;
    this.#unlink?.();
    this.#unlink = undefined;
  }

  abort(cause: unknown): void {
    this.#controller?.abort(cause);
    this.complete();
  }
}
