use std::error::Error;
use std::fmt::{self, Display, Formatter};

#[derive(Debug)]
pub enum HostSupervisorBridgeError {
    EmptyRequest,
    RequestTooLarge { length: usize, maximum: usize },
    MalformedRequest(prost::DecodeError),
    InvalidRequest(&'static str),
    Package(&'static str),
    Endpoint(String),
    Bootstrap(String),
    Launch(String),
    Cleanup(String),
    UnsupportedPlatform,
}

impl Display for HostSupervisorBridgeError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyRequest => formatter.write_str("Host supervisor bridge request is empty"),
            Self::RequestTooLarge { length, maximum } => write!(
                formatter,
                "Host supervisor bridge request length {length} exceeds {maximum}"
            ),
            Self::MalformedRequest(_) => {
                formatter.write_str("Host supervisor bridge request is malformed")
            }
            Self::InvalidRequest(field) => {
                write!(
                    formatter,
                    "Host supervisor bridge request has invalid {field}"
                )
            }
            Self::Package(reason) => write!(
                formatter,
                "Host supervisor bridge package verification failed: {reason}"
            ),
            Self::Endpoint(reason) => {
                write!(formatter, "Host supervisor endpoint failed: {reason}")
            }
            Self::Bootstrap(reason) => {
                write!(formatter, "Host supervisor bootstrap failed: {reason}")
            }
            Self::Launch(reason) => {
                write!(formatter, "Host supervisor launch failed: {reason}")
            }
            Self::Cleanup(reason) => {
                write!(formatter, "Host supervisor cleanup failed: {reason}")
            }
            Self::UnsupportedPlatform => {
                formatter.write_str("Host supervisor bridge platform is unavailable")
            }
        }
    }
}

impl Error for HostSupervisorBridgeError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::MalformedRequest(source) => Some(source),
            _ => None,
        }
    }
}
