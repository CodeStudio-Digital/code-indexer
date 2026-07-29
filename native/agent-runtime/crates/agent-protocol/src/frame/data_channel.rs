//! Authenticated runner-side ownership for the independently provisioned data
//! endpoint.
//!
//! The generic established channel remains private behind two typestates:
//! callers cannot receive hydration payloads until the Host proves possession
//! of the endpoint token and binds the exact attempt/runtime identity.

mod bound;
mod error;
mod limits;
mod pending;

pub use bound::AsyncBoundDataAttemptChannel;
pub use error::DataChannelError;
pub use limits::DataChannelLimits;
pub use pending::{AsyncPendingDataAttemptChannel, DataBindDeadlines, RunnerDataBindAuthority};

#[cfg(test)]
mod tests;
