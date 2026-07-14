export interface LatestRequest {
  clientRequestId: string;
  documentVersion: number;
  prefix: string;
  suffix: string;
  routeRevision?: string;
}

interface Flight<T> {
  controller: AbortController;
  request: LatestRequest;
  latest: LatestRequest;
  promise: Promise<T>;
}

export interface LatestResult<T> {
  value?: T;
  superseded: boolean;
  typedThrough: string;
  coalesced: boolean;
}

/**
 * Per-file latest-wins coordinator. Compatible prefix advances share one
 * provider call; incompatible edits abort it. Every waiter checks the latest
 * client id before it may publish a result.
 */
export class LatestWinsCoordinator<T> {
  private flights = new Map<string, Flight<T>>();
  private byClientId = new Map<string, Flight<T>>();

  async run(
    key: string,
    request: LatestRequest,
    execute: (signal: AbortSignal) => Promise<T>,
  ): Promise<LatestResult<T>> {
    const existing = this.flights.get(key);
    let flight: Flight<T>;
    let coalesced = false;
    if (existing && this.compatible(existing.request, request)) {
      flight = existing;
      flight.latest = request;
      // The newest id owns cancellation. A delayed Monaco cancel for an older
      // compatible waiter must not kill the shared provider stream.
      for (const [id, value] of this.byClientId) if (value === flight) this.byClientId.delete(id);
      this.byClientId.set(request.clientRequestId, flight);
      coalesced = true;
    } else {
      if (existing) this.abortFlight(existing, 'superseded');
      const controller = new AbortController();
      flight = { controller, request, latest: request, promise: Promise.resolve(undefined as T) };
      flight.promise = execute(controller.signal);
      this.flights.set(key, flight);
      this.byClientId.set(request.clientRequestId, flight);
    }
    try {
      const value = await flight.promise;
      const superseded = flight.latest.clientRequestId !== request.clientRequestId;
      const typedThrough = coalesced && request.prefix.startsWith(flight.request.prefix)
        ? request.prefix.slice(flight.request.prefix.length)
        : '';
      return { value, superseded, typedThrough, coalesced };
    } finally {
      this.byClientId.delete(request.clientRequestId);
      if (this.flights.get(key) === flight && flight.latest.clientRequestId === request.clientRequestId) {
        this.flights.delete(key);
      }
    }
  }

  cancel(clientRequestId: string): boolean {
    const flight = this.byClientId.get(clientRequestId);
    if (!flight) return false;
    this.abortFlight(flight, 'client_cancel');
    return true;
  }

  private compatible(a: LatestRequest, b: LatestRequest): boolean {
    return b.documentVersion >= a.documentVersion
      && b.routeRevision === a.routeRevision
      && b.prefix.startsWith(a.prefix)
      && b.suffix === a.suffix;
  }

  private abortFlight(flight: Flight<T>, reason: string): void {
    flight.controller.abort(reason);
    for (const [id, value] of this.byClientId) if (value === flight) this.byClientId.delete(id);
    for (const [key, value] of this.flights) if (value === flight) this.flights.delete(key);
  }
}
