use std::error::Error;
use std::fmt::{self, Display, Formatter};

use agent_platform::ipc::ProtectedEndpointError;
use agent_protocol::generated::v1 as wire;

#[derive(Debug)]
pub enum RunnerMaterializationError {
    InvalidObservedAt(i64),
    RunnerProcessMismatch {
        expected: u32,
        actual: u32,
    },
    DeadlineExpired {
        deadline_at: i64,
        observed_at: i64,
    },
    WrongProvisioning,
    EndpointMapMismatch,
    EndpointBind {
        kind: wire::AttemptEndpointKind,
        source: ProtectedEndpointError,
    },
    ReadyFrameSize {
        length: usize,
        maximum: usize,
    },
}

impl Display for RunnerMaterializationError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidObservedAt(value) => {
                write!(
                    formatter,
                    "runner bootstrap observation time {value} is invalid"
                )
            }
            Self::RunnerProcessMismatch { expected, actual } => write!(
                formatter,
                "runner bootstrap PID mismatch: expected {expected}, observed {actual}"
            ),
            Self::DeadlineExpired {
                deadline_at,
                observed_at,
            } => write!(
                formatter,
                "runner bootstrap deadline {deadline_at} expired at {observed_at}"
            ),
            Self::WrongProvisioning => {
                formatter.write_str("runner bootstrap does not provision Windows Named Pipes")
            }
            Self::EndpointMapMismatch => {
                formatter.write_str("runner bootstrap endpoint map is not canonical")
            }
            Self::EndpointBind { kind, source } => {
                write!(formatter, "cannot bind {kind:?} runner endpoint: {source}")
            }
            Self::ReadyFrameSize { length, maximum } => write!(
                formatter,
                "RunnerEndpointsReady length {length} is outside the 1..={maximum} byte cap"
            ),
        }
    }
}

impl Error for RunnerMaterializationError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::EndpointBind { source, .. } => Some(source),
            _ => None,
        }
    }
}
