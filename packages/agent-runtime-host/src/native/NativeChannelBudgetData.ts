import type { NativeRustHostAttemptRuntimeOptions } from './NativeRustHostAttemptRuntimeTypes.js';

export function withChannelBudget(data: NativeRustHostAttemptRuntimeOptions['data'], signal: AbortSignal) {
  data.providerGateway?.drainWhen(signal);
  const factory = data.providerGatewayFactory;
  return { ...data, ...(factory ? { providerGatewayFactory: (...args: Parameters<typeof factory>) => {
    const gateway = factory(...args);
    gateway.drainWhen(signal);
    return gateway;
  } } : {}) };
}
