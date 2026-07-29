use std::error::Error;
use std::fmt::{self, Display, Formatter};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionStoreBridgeError {
    InvalidBridgeInstanceId,
    InvalidRootId,
    InvalidRoot,
    DuplicateRoot,
    InvalidFrameLimit,
    FrameTooLarge,
    Decode,
    MissingHeader,
    InvalidProtocolVersion,
    BridgeInstanceMismatch,
    InvalidRequestId,
    InvalidSequence,
    InvalidDeadline,
    PayloadHashMismatch,
    MissingRequest,
    ProcessIdentityMismatch,
    Poisoned,
    ResponseTooLarge,
}

impl Display for SessionStoreBridgeError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        write!(formatter, "session store bridge error: {self:?}")
    }
}

impl Error for SessionStoreBridgeError {}
