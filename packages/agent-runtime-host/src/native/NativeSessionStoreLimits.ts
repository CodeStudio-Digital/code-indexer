/** Writer and recovery reader must admit the same bounded checkpoint payload.
 * The native bridge also needs space for the authenticated request/receipt. */
export const NATIVE_SESSION_PAYLOAD_BYTES = 16 * 1024 * 1024;
export const NATIVE_SESSION_FRAME_BYTES = NATIVE_SESSION_PAYLOAD_BYTES + 1024 * 1024;
// The product writer already admits this many durable records. Reader/replay
// bounds must match it: a tool turn creates several records, not one message.
export const NATIVE_SESSION_MAX_RECORDS = 1_000_000;
