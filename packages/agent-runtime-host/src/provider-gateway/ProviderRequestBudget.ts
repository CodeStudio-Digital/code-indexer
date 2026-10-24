import { ProviderGatewayError } from './ProviderGatewayError.js';

export class RequestByteBudget {
  #used = 0;
  constructor(readonly maximum: number) {}
  add(bytes: number): void {
    this.#used += bytes;
    if (!Number.isSafeInteger(this.#used) || this.#used > this.maximum) {
      throw new ProviderGatewayError('provider_request_too_large', 'provider request exceeds byte budget');
    }
  }
}
