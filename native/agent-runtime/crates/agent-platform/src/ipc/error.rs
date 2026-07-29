use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::io;

/// Failure with explicit cleanup ownership when revocation cannot be proven.
#[derive(Debug)]
pub enum ProtectedEndpointFailure<O> {
    Clean(ProtectedEndpointError),
    Owned {
        owner: O,
        error: ProtectedEndpointError,
    },
}

impl<O> ProtectedEndpointFailure<O> {
    #[must_use]
    pub const fn error(&self) -> &ProtectedEndpointError {
        match self {
            Self::Clean(error) | Self::Owned { error, .. } => error,
        }
    }
}

#[derive(Debug)]
pub enum ProtectedEndpointError {
    InvalidName,
    InvalidBufferCapacity,
    InvalidAddress(&'static str),
    InvalidRoot(&'static str),
    InvalidPeer,
    AddressTooLong {
        units: usize,
        maximum: usize,
    },
    PermissionNotProven {
        object: &'static str,
        expected: u32,
        actual: u32,
    },
    PeerMismatch {
        expected_process_id: u32,
        actual_process_id: Option<u32>,
    },
    PeerUserMismatch {
        expected_user_id: u32,
        actual_user_id: u32,
    },
    CleanupIdentityMismatch,
    Cancelled,
    DeadlineElapsed,
    Io {
        operation: &'static str,
        source: io::Error,
    },
}

impl ProtectedEndpointError {
    pub(crate) const fn io(operation: &'static str, source: io::Error) -> Self {
        Self::Io { operation, source }
    }

    #[cfg(windows)]
    pub(crate) fn last_os_error(operation: &'static str) -> Self {
        Self::io(operation, io::Error::last_os_error())
    }
}

impl Display for ProtectedEndpointError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidName => formatter.write_str("invalid protected endpoint name"),
            Self::InvalidBufferCapacity => {
                formatter.write_str("invalid protected endpoint buffer capacity")
            }
            Self::InvalidAddress(reason) => write!(formatter, "invalid local endpoint: {reason}"),
            Self::InvalidRoot(reason) => write!(formatter, "invalid local IPC root: {reason}"),
            Self::InvalidPeer => formatter.write_str("invalid expected local peer"),
            Self::AddressTooLong { units, maximum } => {
                write!(
                    formatter,
                    "local endpoint uses {units} units; maximum is {maximum}"
                )
            }
            Self::PermissionNotProven {
                object,
                expected,
                actual,
            } => write!(
                formatter,
                "{object} permissions are {actual:#o}; required {expected:#o}"
            ),
            Self::PeerMismatch {
                expected_process_id,
                actual_process_id,
            } => write!(
                formatter,
                "local peer PID mismatch: expected {expected_process_id}, observed {actual_process_id:?}"
            ),
            Self::PeerUserMismatch {
                expected_user_id,
                actual_user_id,
            } => write!(
                formatter,
                "local peer user mismatch: expected {expected_user_id}, observed {actual_user_id}"
            ),
            Self::CleanupIdentityMismatch => {
                formatter.write_str("refusing to remove a replaced endpoint path")
            }
            Self::Cancelled => formatter.write_str("protected endpoint operation was cancelled"),
            Self::DeadlineElapsed => formatter.write_str("protected endpoint deadline elapsed"),
            Self::Io { operation, source } => write!(formatter, "{operation} failed: {source}"),
        }
    }
}

impl Error for ProtectedEndpointError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io { source, .. } => Some(source),
            _ => None,
        }
    }
}
