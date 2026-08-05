import { ProviderGatewayError } from './ProviderGatewayError.js';

export function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 64) throw invalid('provider tool arguments exceed nesting ceiling');
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item, depth + 1)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(record[key], depth + 1)}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function stringifyInput(input: Record<string, unknown>): string {
  try {
    const encoded = JSON.stringify(input);
    if (encoded === undefined) throw new TypeError('not JSON serializable');
    return encoded;
  } catch (cause) {
    throw invalid('provider terminal tool input is not JSON serializable', cause);
  }
}

function invalid(message: string, cause?: unknown): ProviderGatewayError {
  return new ProviderGatewayError('provider_tool_stream_invalid', message, { cause });
}
