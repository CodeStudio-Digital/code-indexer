/**
 * Branded id types — a compile-time guard so an `AccountId` can never be passed
 * where a `ShareId` is expected (they are all `string` at runtime, distinct at
 * the type level). Cross-context references use these brands, never raw strings.
 */
export type Brand<T, B extends string> = T & { readonly __brand: B };

export type AccountId = Brand<string, 'AccountId'>;
export type SessionId = Brand<string, 'SessionId'>;
export type RefreshTokenId = Brand<string, 'RefreshTokenId'>;
export type CustomerId = Brand<string, 'CustomerId'>;
export type SubscriptionId = Brand<string, 'SubscriptionId'>;
export type ShareId = Brand<string, 'ShareId'>;
export type FeedbackTicketId = Brand<string, 'FeedbackTicketId'>;

export const asAccountId = (s: string): AccountId => s as AccountId;
export const asSessionId = (s: string): SessionId => s as SessionId;
export const asRefreshTokenId = (s: string): RefreshTokenId => s as RefreshTokenId;
export const asCustomerId = (s: string): CustomerId => s as CustomerId;
export const asSubscriptionId = (s: string): SubscriptionId => s as SubscriptionId;
export const asShareId = (s: string): ShareId => s as ShareId;
export const asFeedbackTicketId = (s: string): FeedbackTicketId => s as FeedbackTicketId;
