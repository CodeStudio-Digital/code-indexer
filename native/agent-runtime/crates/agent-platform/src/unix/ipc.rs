//! One-shot pathname Unix-domain socket endpoints.

mod path;
mod peer;
mod stream;

use std::fmt::{self, Debug, Formatter};
use std::path::Path;

use tokio::net::{UnixListener, UnixStream};
use tokio::time::{Instant, sleep_until};

use crate::ipc::{
    EndpointCancellation, EndpointName, ProtectedEndpointAddress, ProtectedEndpointError,
    ProtectedEndpointFailure,
};

use path::EndpointPathOwner;
pub use path::UnixEndpointCleanup;
use peer::verify_peer;
pub use peer::{ExpectedUnixPeer, VerifiedUnixPeer};
pub use stream::{UnixEndpointClient, VerifiedUnixEndpointStream};

/// Unique owner of one filesystem-bound UDS listener and its cleanup identity.
pub struct UnixProtectedEndpoint {
    listener: UnixListener,
    address: ProtectedEndpointAddress,
    path_owner: EndpointPathOwner,
    owner_user_id: u32,
}

impl Debug for UnixProtectedEndpoint {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("UnixProtectedEndpoint")
            .field("address", &self.address)
            .field("owner_user_id", &self.owner_user_id)
            .finish_non_exhaustive()
    }
}

impl UnixProtectedEndpoint {
    /// Binds below an existing app-private root. A fresh `0700` leaf and a
    /// `0600` pathname socket are created exclusively.
    ///
    /// # Errors
    ///
    /// Rejects insecure roots, aliases, collisions, overlong paths and any
    /// permission or file-identity state that cannot be proven. If a failure
    /// happens after the private leaf exists, cleanup ownership is preserved.
    pub fn bind(
        root: &Path,
        name: &EndpointName,
    ) -> Result<Self, ProtectedEndpointFailure<UnixEndpointCleanup>> {
        let mut path_owner =
            EndpointPathOwner::create(root, name).map_err(ProtectedEndpointFailure::Clean)?;
        let listener = match UnixListener::bind(path_owner.socket_path()) {
            Ok(listener) => listener,
            Err(source) => {
                return fail_after_revoke(
                    path_owner,
                    ProtectedEndpointError::io("bind Unix socket", source),
                );
            }
        };
        if let Err(error) = path_owner.prove_bound_socket() {
            drop(listener);
            return fail_after_revoke(path_owner, error);
        }
        let Some(address) = path_owner.socket_path().to_str().map(ToOwned::to_owned) else {
            drop(listener);
            return fail_after_revoke(
                path_owner,
                ProtectedEndpointError::InvalidAddress("non-UTF-8 Unix path"),
            );
        };
        let owner_user_id = path_owner.owner_user_id();
        Ok(Self {
            listener,
            address: ProtectedEndpointAddress::from_bound(address),
            path_owner,
            owner_user_id,
        })
    }

    #[must_use]
    pub const fn address(&self) -> &ProtectedEndpointAddress {
        &self.address
    }

    /// Accepts exactly one peer and unlinks the pathname before exposing I/O.
    ///
    /// # Errors
    ///
    /// PID/UID mismatch, cancellation, deadline and I/O failures poison the
    /// endpoint. Cleanup ownership is returned if safe unlink cannot be proven.
    pub async fn accept(
        self,
        expected: ExpectedUnixPeer,
        deadline: Instant,
        cancellation: &mut EndpointCancellation,
    ) -> Result<VerifiedUnixEndpointStream, ProtectedEndpointFailure<UnixEndpointCleanup>> {
        let Self {
            listener,
            address,
            path_owner,
            owner_user_id,
        } = self;
        if expected.user_id() != owner_user_id {
            drop(listener);
            return fail_after_revoke(
                path_owner,
                ProtectedEndpointError::PeerUserMismatch {
                    expected_user_id: owner_user_id,
                    actual_user_id: expected.user_id(),
                },
            );
        }
        if cancellation.is_cancelled() {
            drop(listener);
            return fail_after_revoke(path_owner, ProtectedEndpointError::Cancelled);
        }
        let accepted = tokio::select! {
            biased;
            () = sleep_until(deadline) => {
                Err(ProtectedEndpointError::DeadlineElapsed)
            }
            () = cancellation.cancelled() => {
                Err(ProtectedEndpointError::Cancelled)
            }
            accepted = listener.accept() => {
                accepted
                    .map(|(stream, _address)| stream)
                    .map_err(|source| ProtectedEndpointError::io("accept Unix socket", source))
            }
        };
        let stream = match accepted {
            Ok(stream) => stream,
            Err(error) => {
                drop(listener);
                return fail_after_revoke(path_owner, error);
            }
        };
        let peer = match verify_peer(&stream, expected) {
            Ok(peer) => peer,
            Err(error) => {
                drop(stream);
                drop(listener);
                return fail_after_revoke(path_owner, error);
            }
        };
        drop(listener);
        match UnixEndpointCleanup::new(path_owner).revoke() {
            Ok(()) => Ok(VerifiedUnixEndpointStream::new(stream, address, peer)),
            Err(failure) => {
                drop(stream);
                Err(failure)
            }
        }
    }

    /// Explicitly revokes a listener before ownership transfer.
    ///
    /// # Errors
    ///
    /// Returns cleanup ownership when safe pathname removal cannot be proven.
    pub fn revoke(self) -> Result<(), ProtectedEndpointFailure<UnixEndpointCleanup>> {
        drop(self.listener);
        UnixEndpointCleanup::new(self.path_owner).revoke()
    }

    /// Connects once to a previously bound address.
    ///
    /// # Errors
    ///
    /// Rejects deadline, cancellation, I/O and exact PID/UID mismatches before
    /// returning a stream capable of protocol I/O.
    pub async fn connect(
        address: &ProtectedEndpointAddress,
        expected: ExpectedUnixPeer,
        deadline: Instant,
        cancellation: &mut EndpointCancellation,
    ) -> Result<UnixEndpointClient, ProtectedEndpointError> {
        if cancellation.is_cancelled() {
            return Err(ProtectedEndpointError::Cancelled);
        }
        let result = tokio::select! {
            biased;
            () = sleep_until(deadline) => Err(ProtectedEndpointError::DeadlineElapsed),
            () = cancellation.cancelled() => Err(ProtectedEndpointError::Cancelled),
            connected = UnixStream::connect(address.as_str()) => {
                connected.map_err(|source| {
                    ProtectedEndpointError::io("connect Unix socket", source)
                })
            }
        }?;
        let peer = verify_peer(&result, expected)?;
        Ok(UnixEndpointClient::new(result, address.clone(), peer))
    }
}

fn fail_after_revoke<T>(
    owner: EndpointPathOwner,
    error: ProtectedEndpointError,
) -> Result<T, ProtectedEndpointFailure<UnixEndpointCleanup>> {
    match UnixEndpointCleanup::new(owner).revoke() {
        Ok(()) => Err(ProtectedEndpointFailure::Clean(error)),
        Err(ProtectedEndpointFailure::Owned { owner, .. }) => {
            Err(ProtectedEndpointFailure::Owned { owner, error })
        }
        Err(ProtectedEndpointFailure::Clean(_)) => unreachable!("cleanup returns owned on failure"),
    }
}
