import {
  type BoundedJsonRpcPeerOptions,
  type EngineJsonRpcPeerPort,
  type EngineJsonRpcTransport,
  JsonRpcApplicationError,
  type JsonRpcId,
  type JsonRpcPeerHandlers,
  JsonRpcProtocolError,
} from './JsonRpcTypes.js';

export * from './JsonRpcTypes.js';

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  detachAbort(): void;
}

const DEFAULT_OPTIONS: Required<BoundedJsonRpcPeerOptions> = {
  maxInboundBytes: 1024 * 1024,
  maxPendingRequests: 64,
  maxConcurrentServerRequests: 8,
};

export class BoundedJsonRpcPeer implements EngineJsonRpcPeerPort {
  readonly #options: Required<BoundedJsonRpcPeerOptions>;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #serverRequests = new Set<Promise<void>>();
  readonly #closeController = new AbortController();
  #handlers?: JsonRpcPeerHandlers;
  #pump?: Promise<void>;
  #nextId = 1;
  #closed = false;
  #terminalError?: Error;

  constructor(
    private readonly transport: EngineJsonRpcTransport,
    options: BoundedJsonRpcPeerOptions = {},
  ) {
    this.#options = { ...DEFAULT_OPTIONS, ...options };
  }

  start(handlers: JsonRpcPeerHandlers, signal: AbortSignal): void {
    if (this.#handlers) {
      throw new JsonRpcProtocolError('peer_already_started', 'JSON-RPC peer was already started');
    }
    signal.throwIfAborted();
    this.#handlers = handlers;
    const lifetime = AbortSignal.any([signal, this.#closeController.signal]);
    this.#pump = this.#run(lifetime).catch((error: unknown) => {
      this.#fail(toError(error));
    });
  }

  async request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    this.#assertUsable();
    signal?.throwIfAborted();
    if (this.#pending.size >= this.#options.maxPendingRequests) {
      throw new JsonRpcProtocolError('pending_request_limit', 'JSON-RPC pending request limit reached');
    }
    const id = this.#nextId++;
    const key = responseKey(id);
    let pending!: PendingRequest;
    const response = new Promise<unknown>((resolve, reject) => {
      const onAbort = () => {
        this.#pending.delete(key);
        reject(abortError(signal));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      pending = {
        resolve,
        reject,
        detachAbort: () => signal?.removeEventListener('abort', onAbort),
      };
      this.#pending.set(key, pending);
    });
    try {
      await this.transport.send({ method, id, params });
    } catch (error) {
      this.#pending.delete(key);
      pending.detachAbort();
      pending.reject(toError(error));
    }
    return response;
  }

  async notify(method: string, params: unknown): Promise<void> {
    this.#assertUsable();
    await this.transport.send({ method, params });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#closeController.abort();
    await this.transport.close();
    await this.#pump;
    await Promise.allSettled(this.#serverRequests);
    this.#rejectPending(new JsonRpcProtocolError('peer_closed', 'JSON-RPC peer closed'));
  }

  async #run(signal: AbortSignal): Promise<void> {
    try {
      for await (const message of this.transport.messages()) {
        signal.throwIfAborted();
        this.#validateInboundBudget(message);
        await this.#handleMessage(message, signal);
      }
      if (!signal.aborted) {
        throw new JsonRpcProtocolError('transport_ended', 'JSON-RPC transport ended unexpectedly');
      }
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }

  async #handleMessage(message: unknown, signal: AbortSignal): Promise<void> {
    if (!isRecord(message)) {
      throw new JsonRpcProtocolError('invalid_message', 'JSON-RPC message must be an object');
    }
    const method = typeof message.method === 'string' ? message.method : undefined;
    const hasId = typeof message.id === 'string' || typeof message.id === 'number';
    if (method && hasId) {
      this.#dispatchServerRequest(message.id as JsonRpcId, method, message.params, signal);
      return;
    }
    if (method) {
      await this.#handlers!.onNotification(method, message.params);
      return;
    }
    if (hasId) {
      this.#settleResponse(message.id as JsonRpcId, message);
      return;
    }
    throw new JsonRpcProtocolError('invalid_message_shape', 'Unrecognized JSON-RPC message shape');
  }

  #dispatchServerRequest(
    id: JsonRpcId,
    method: string,
    params: unknown,
    signal: AbortSignal,
  ): void {
    if (this.#serverRequests.size >= this.#options.maxConcurrentServerRequests) {
      void this.transport.send({
        id,
        error: { code: -32001, message: 'Client overloaded; retry later.' },
      });
      return;
    }
    const task = this.#answerServerRequest(id, method, params, signal);
    this.#serverRequests.add(task);
    void task.then(
      () => this.#serverRequests.delete(task),
      () => this.#serverRequests.delete(task),
    );
  }

  async #answerServerRequest(
    id: JsonRpcId,
    method: string,
    params: unknown,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const result = await this.#handlers!.onRequest(method, params, signal);
      await this.transport.send({ id, result });
    } catch (error) {
      const applicationError = error instanceof JsonRpcApplicationError ? error : undefined;
      await this.transport.send({
        id,
        error: {
          code: applicationError?.rpcCode ?? -32603,
          message: applicationError?.message ?? 'Client request handler failed',
          ...(applicationError?.data === undefined ? {} : { data: applicationError.data }),
        },
      });
    }
  }

  #settleResponse(id: JsonRpcId, response: Readonly<Record<string, unknown>>): void {
    const key = responseKey(id);
    const pending = this.#pending.get(key);
    if (!pending) {
      throw new JsonRpcProtocolError('unknown_response_id', `Unknown JSON-RPC response id ${String(id)}`);
    }
    this.#pending.delete(key);
    pending.detachAbort();
    if (isRecord(response.error)) {
      const code = typeof response.error.code === 'number' ? response.error.code : -32603;
      const message = typeof response.error.message === 'string'
        ? response.error.message
        : 'JSON-RPC request failed';
      pending.reject(new JsonRpcApplicationError(code, message, response.error.data));
      return;
    }
    pending.resolve(response.result);
  }

  #validateInboundBudget(message: unknown): void {
    const bytes = Buffer.byteLength(JSON.stringify(message), 'utf8');
    if (bytes > this.#options.maxInboundBytes) {
      throw new JsonRpcProtocolError(
        'inbound_message_limit',
        `JSON-RPC message uses ${bytes} bytes; limit is ${this.#options.maxInboundBytes}`,
      );
    }
  }

  #fail(error: Error): void {
    this.#terminalError = error;
    this.#rejectPending(error);
    void this.#handlers?.onClosed?.(error);
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      pending.detachAbort();
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #assertUsable(): void {
    if (!this.#handlers) {
      throw new JsonRpcProtocolError('peer_not_started', 'JSON-RPC peer has not started');
    }
    if (this.#terminalError) throw this.#terminalError;
    if (this.#closed) throw new JsonRpcProtocolError('peer_closed', 'JSON-RPC peer is closed');
  }
}

function responseKey(id: JsonRpcId): string {
  return `${typeof id}:${String(id)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function abortError(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error('JSON-RPC request aborted');
}
