use std::error::Error;
use std::fmt::{self, Display, Formatter};

use agent_protocol::frame::EstablishedChannelError;

use crate::control::ControlError;

#[derive(Debug)]
pub enum ControlDriverError {
    Closed,
    PrepareInFlight,
    NoPrepareInFlight,
    PreparedResponseMissing,
    ReceiveTimestampMissing,
    InvalidClockReading(i64),
    ActivationAckClockRegressed {
        write_started_at: i64,
        write_completed_at: i64,
    },
    ActivationAckDeadlineElapsed {
        deadline: i64,
        observed: i64,
    },
    InboundBindingMismatch,
    Control(ControlError),
    Channel(EstablishedChannelError),
}

impl Display for ControlDriverError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Closed => formatter.write_str("runner control driver is closed"),
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
            Self::InvalidClockReading(value) => {
                write!(
                    formatter,
                    "trusted control clock returned invalid value {value}"
                )
            }
            Self::ActivationAckClockRegressed {
                write_started_at,
                write_completed_at,
            } => write!(
                formatter,
                "trusted control clock regressed from {write_started_at} to {write_completed_at} while writing ActivateAck"
            ),
            Self::ActivationAckDeadlineElapsed { deadline, observed } => write!(
                formatter,
                "ActivateAck deadline {deadline} elapsed at {observed}"
            ),
            Self::InboundBindingMismatch => {
                formatter.write_str("commit receipt differs from the staged inbound frame")
            }
            Self::Control(error) => Display::fmt(error, formatter),
            Self::Channel(error) => Display::fmt(error, formatter),
        }
    }
}

impl Error for ControlDriverError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Control(error) => Some(error),
            Self::Channel(error) => Some(error),
            _ => None,
        }
    }
}

impl From<ControlError> for ControlDriverError {
    fn from(value: ControlError) -> Self {
        Self::Control(value)
    }
}

impl From<EstablishedChannelError> for ControlDriverError {
    fn from(value: EstablishedChannelError) -> Self {
        Self::Channel(value)
    }
}
