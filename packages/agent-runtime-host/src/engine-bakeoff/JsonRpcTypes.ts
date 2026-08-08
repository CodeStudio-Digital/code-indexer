export type JsonRpcId = string | number;

export interface EngineJsonRpcTransport {
  send(message: Readonly<Record<string, unknown>>): Promise<void>;
  messages(): AsyncIterable<unknown>;
  close(): Promise<void>;
}

export interface JsonRpcPeerHandlers {
  onNotification(method: string, params: unknown): void | Promise<void>;
  onRequest(method: string, params: unknown, signal: AbortSignal): Promise<unknown>;
  onClosed?(error?: Error): void | Promise<void>;
}

export interface EngineJsonRpcPeerPort {
  start(handlers: JsonRpcPeerHandlers, signal: AbortSignal): void;
  request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown>;
  notify(method: string, params: unknown): Promise<void>;
  close(): Promise<void>;
}

export interface BoundedJsonRpcPeerOptions {
  maxInboundBytes?: number;
  maxPendingRequests?: number;
  maxConcurrentServerRequests?: number;
}

export class JsonRpcProtocolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'JsonRpcProtocolError';
  }
}

export class JsonRpcApplicationError extends Error {
  constructor(
    readonly rpcCode: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'JsonRpcApplicationError';
  }
}
