//! Authenticated, bounded runner-to-supervisor liveness channel.
//!
//! Pulse is deliberately independent from domain traffic. It carries only
//! physical identity, lifecycle phase, monotonic counters, and a small resource
//! sample under the immutable attempt deadline.

use std::error::Error;
use std::fmt::{self, Display, Formatter};

use crate::framing::AsyncFramingError;

mod authentication;
mod channel;
mod codec;
mod model;

pub use authentication::RunnerPulseAuthenticationKey;
pub use channel::{RunnerPulseSender, SupervisorPulseReceiver};
pub use model::{RunnerPulseIdentity, ValidatedRunnerPulse};

#[derive(Debug)]
pub enum RunnerPulseError {
    InvalidAuthenticationKey,
    InvalidIdentity,
    InvalidTimeout,
    InvalidPhase,
    InvalidResources,
    CounterExhausted,
    CounterMismatch { expected: u64, actual: u64 },
    ProgressRegressed { previous: u64, actual: u64 },
    AuthenticationFailed,
    NonCanonicalFrame,
    MalformedFrame(prost::DecodeError),
    Framing(AsyncFramingError),
}

impl Display for RunnerPulseError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidAuthenticationKey => {
                formatter.write_str("runner pulse authentication key is invalid")
            }
            Self::InvalidIdentity => formatter.write_str("runner pulse identity is invalid"),
            Self::InvalidTimeout => formatter.write_str("runner pulse timeout is invalid"),
            Self::InvalidPhase => formatter.write_str("runner pulse phase is invalid"),
            Self::InvalidResources => formatter.write_str("runner pulse resources are invalid"),
            Self::CounterExhausted => formatter.write_str("runner pulse counter is exhausted"),
            Self::CounterMismatch { expected, actual } => write!(
                formatter,
                "runner pulse counter mismatch: expected {expected}, received {actual}"
            ),
            Self::ProgressRegressed { previous, actual } => write!(
                formatter,
                "runner pulse progress regressed from {previous} to {actual}"
            ),
            Self::AuthenticationFailed => formatter.write_str("runner pulse authentication failed"),
            Self::NonCanonicalFrame => formatter.write_str("runner pulse frame is not canonical"),
            Self::MalformedFrame(error) => write!(formatter, "malformed runner pulse: {error}"),
            Self::Framing(error) => Display::fmt(error, formatter),
        }
    }
}

impl Error for RunnerPulseError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::MalformedFrame(error) => Some(error),
            Self::Framing(error) => Some(error),
            _ => None,
        }
    }
}

impl From<AsyncFramingError> for RunnerPulseError {
    fn from(value: AsyncFramingError) -> Self {
        Self::Framing(value)
    }
}

#[cfg(test)]
mod tests;
