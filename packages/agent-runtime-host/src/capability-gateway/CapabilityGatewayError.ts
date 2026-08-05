export class CapabilityGatewayError extends Error {
  constructor(
    readonly code:
      | 'invalid_prepare'
      | 'registry_full'
      | 'operation_conflict'
      | 'invalid_decision',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'CapabilityGatewayError';
  }
}

