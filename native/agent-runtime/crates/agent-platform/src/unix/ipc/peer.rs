use tokio::net::UnixStream;

use crate::ipc::ProtectedEndpointError;

/// Exact Unix process and user identity expected on the other socket end.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExpectedUnixPeer {
    process_id: u32,
    user_id: u32,
}

impl ExpectedUnixPeer {
    /// # Errors
    ///
    /// A zero process identifier can never authorize a peer.
    pub const fn new(process_id: u32, user_id: u32) -> Result<Self, ProtectedEndpointError> {
        if process_id == 0 {
            return Err(ProtectedEndpointError::InvalidPeer);
        }
        Ok(Self {
            process_id,
            user_id,
        })
    }

    #[must_use]
    pub const fn process_id(self) -> u32 {
        self.process_id
    }

    #[must_use]
    pub const fn user_id(self) -> u32 {
        self.user_id
    }
}

/// Immutable PID/UID evidence attached to a verified Unix stream.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VerifiedUnixPeer {
    process_id: u32,
    user_id: u32,
}

impl VerifiedUnixPeer {
    #[must_use]
    pub const fn process_id(self) -> u32 {
        self.process_id
    }

    #[must_use]
    pub const fn user_id(self) -> u32 {
        self.user_id
    }
}

pub(super) fn verify_peer(
    stream: &UnixStream,
    expected: ExpectedUnixPeer,
) -> Result<VerifiedUnixPeer, ProtectedEndpointError> {
    let credentials = stream
        .peer_cred()
        .map_err(|source| ProtectedEndpointError::io("Unix peer credentials", source))?;
    if credentials.uid() != expected.user_id() {
        return Err(ProtectedEndpointError::PeerUserMismatch {
            expected_user_id: expected.user_id(),
            actual_user_id: credentials.uid(),
        });
    }
    let process_id = credentials
        .pid()
        .and_then(|value| u32::try_from(value).ok());
    if process_id != Some(expected.process_id()) {
        return Err(ProtectedEndpointError::PeerMismatch {
            expected_process_id: expected.process_id(),
            actual_process_id: process_id,
        });
    }
    Ok(VerifiedUnixPeer {
        process_id: expected.process_id(),
        user_id: expected.user_id(),
    })
}
