use std::error::Error;
use std::fmt::{self, Display, Formatter};

use agent_protocol::frame::AsyncEstablishedChannelError;

use crate::control::ControlError;

#[derive(Debug)]
pub enum AsyncControlDriverError {
    Closed,
    PrepareInFlight,
    NoPrepareInFlight,
    PreparedResponseMissing,
    ReceiveTimestampMissing,
    InvalidHeartbeatProgress {
        progress: i64,
        alive: i64,
    },
    InvalidHeartbeatSchedule,
    HeartbeatResourceSampleFailed,
    InvalidClockReading(i64),
    ClockRegressed {
        operation: &'static str,
        started_at: i64,
        completed_at: i64,
    },
    DeadlineElapsed {
        operation: &'static str,
        deadline: i64,
        observed: i64,
    },
    InboundBindingMismatch,
    Control(ControlError),
    Channel(AsyncEstablishedChannelError),
}

impl Display for AsyncControlDriverError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Closed => formatter.write_str("async runner control driver is closed"),
            Self::PrepareInFlight => {
                formatter.write_str("runner is still hydrating the pending PrepareAttempt")
            }
            Self::NoPrepareInFlight => formatter.write_str("runner has no pending PrepareAttempt"),
            Self::PreparedResponseMissing => {
                formatter.write_str("prepared response cache is missing")
            }
            Self::ReceiveTimestampMissing => {
                formatter.write_str("inbound frame has no trusted receive timestamp")
            }
            Self::InvalidHeartbeatProgress { progress, alive } => write!(
                formatter,
                "heartbeat progress timestamp {progress} exceeds alive timestamp {alive}",
            ),
            Self::InvalidHeartbeatSchedule => {
                formatter.write_str("heartbeat interval cannot be represented by the owner clock")
            }
            Self::HeartbeatResourceSampleFailed => {
                formatter.write_str("heartbeat resource sample failed")
            }
            Self::InvalidClockReading(value) => {
                write!(
                    formatter,
                    "trusted control clock returned invalid value {value}"
                )
            }
            Self::ClockRegressed {
                operation,
                started_at,
                completed_at,
            } => write!(
                formatter,
                "trusted clock regressed during {operation}: {started_at} to {completed_at}"
            ),
            Self::DeadlineElapsed {
                operation,
                deadline,
                observed,
            } => write!(
                formatter,
                "{operation} deadline {deadline} elapsed at {observed}"
            ),
            Self::InboundBindingMismatch => {
                formatter.write_str("commit receipt differs from the staged inbound frame")
            }
            Self::Control(error) => Display::fmt(error, formatter),
            Self::Channel(error) => Display::fmt(error, formatter),
        }
    }
}

impl Error for AsyncControlDriverError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Control(error) => Some(error),
            Self::Channel(error) => Some(error),
            _ => None,
        }
    }
}

impl From<ControlError> for AsyncControlDriverError {
    fn from(value: ControlError) -> Self {
        Self::Control(value)
    }
}

impl From<AsyncEstablishedChannelError> for AsyncControlDriverError {
    fn from(value: AsyncEstablishedChannelError) -> Self {
        Self::Channel(value)
    }
}
