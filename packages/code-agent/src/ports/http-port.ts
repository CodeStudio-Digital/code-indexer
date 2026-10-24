import type { RawResponse, SendOptions } from '@mcp/shared/utils/http-engine.js';

/** Cookie state and physical requests belong to the attempt, never another UI. */
export interface HttpPort {
  send(options: Omit<SendOptions, 'jar'> & { resetCookies?: boolean }): Promise<RawResponse>;
  outcomeUnknown(): void;
}
