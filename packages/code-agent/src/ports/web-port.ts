import type { PublicWebRequest, PublicWebResponse } from '@mcp/shared/utils/public-web-request.js';

/** Public GET transport, owned and drained by the current attempt. */
export interface WebPort {
  read(input: PublicWebRequest): Promise<PublicWebResponse>;
  assertCurrent(): void;
}
