use std::error::Error;
use std::fmt::{self, Display, Formatter};

use agent_protocol::frame::AsyncBootstrapChannelError;
use agent_protocol::framing::FramingError;
use agent_protocol::runner_bootstrap::RunnerBootstrapError as LaunchBootstrapError;

use crate::control::ControlError;

#[derive(Debug)]
pub enum AsyncRunnerBootstrapError {
    Closed,
    UnexpectedHello,
    InvalidControlCap(usize),
    Framing(FramingError),
    Channel(AsyncBootstrapChannelError),
    LaunchBootstrap(LaunchBootstrapError),
    Control(ControlError),
}

impl Display for AsyncRunnerBootstrapError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Closed => formatter.write_str("async runner bootstrap driver is closed"),
            Self::UnexpectedHello => formatter.write_str("runner received AgentHello from host"),
            Self::InvalidControlCap(value) => {
                write!(formatter, "control frame cap {value} exceeds uint32")
            }
            Self::Framing(error) => Display::fmt(error, formatter),
            Self::Channel(error) => Display::fmt(error, formatter),
            Self::LaunchBootstrap(error) => Display::fmt(error, formatter),
            Self::Control(error) => Display::fmt(error, formatter),
        }
    }
}

impl Error for AsyncRunnerBootstrapError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Framing(error) => Some(error),
            Self::Channel(error) => Some(error),
            Self::LaunchBootstrap(error) => Some(error),
            Self::Control(error) => Some(error),
            Self::Closed | Self::UnexpectedHello | Self::InvalidControlCap(_) => None,
        }
    }
}

impl From<AsyncBootstrapChannelError> for AsyncRunnerBootstrapError {
    fn from(value: AsyncBootstrapChannelError) -> Self {
        Self::Channel(value)
    }
}

impl From<LaunchBootstrapError> for AsyncRunnerBootstrapError {
    fn from(value: LaunchBootstrapError) -> Self {
        Self::LaunchBootstrap(value)
    }
}

impl From<FramingError> for AsyncRunnerBootstrapError {
    fn from(value: FramingError) -> Self {
        Self::Framing(value)
    }
}

impl From<ControlError> for AsyncRunnerBootstrapError {
    fn from(value: ControlError) -> Self {
        Self::Control(value)
    }
}
