/**
 * Clock port — abstracts the passage of time for testability.
 * All use-cases read "now" through this interface instead of `Date.now()`.
 */
export interface Clock {
  now(): number; // unix ms
}
