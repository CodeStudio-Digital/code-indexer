//! One-shot Windows Named Pipe endpoints.
//!
//! The public facade is safe and owns exactly one server instance. Raw ACL and
//! peer-process calls are isolated in a small FFI module.

mod address;
mod cleanup;
mod stream;
#[allow(unsafe_code)]
mod sys;

use std::fmt::{self, Debug, Formatter};

use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeServer};
use tokio::time::{Instant, sleep_until};

use crate::ipc::{
    EndpointBufferCapacity, EndpointCancellation, EndpointName, ExpectedLocalPeer,
    ProtectedEndpointAddress, ProtectedEndpointError, ProtectedEndpointFailure, VerifiedLocalPeer,
};

use cleanup::CleanupState;
pub use cleanup::WindowsEndpointCleanup;
pub use stream::{VerifiedWindowsEndpointStream, WindowsEndpointClient};
pub(in crate::windows) use sys::PipeSecurity;

const MAX_PIPE_NAME_UTF16_UNITS: usize = 256;
const CONNECT_REAP_GRACE: std::time::Duration = std::time::Duration::from_secs(1);

/// Unique owner of one local, single-instance Named Pipe listener.
pub struct WindowsProtectedEndpoint {
    server: NamedPipeServer,
    address: ProtectedEndpointAddress,
    capacity: EndpointBufferCapacity,
}

impl Debug for WindowsProtectedEndpoint {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("WindowsProtectedEndpoint")
            .field("address", &self.address)
            .finish_non_exhaustive()
    }
}

impl WindowsProtectedEndpoint {
    /// Creates the first and only local instance with a protected logon-SID
    /// DACL. The handle is non-inheritable until a later explicit handoff.
    ///
    /// # Errors
    ///
    /// Fails closed on invalid names, ACL construction or any collision.
    pub fn bind(
        name: &EndpointName,
        capacity: EndpointBufferCapacity,
    ) -> Result<Self, ProtectedEndpointError> {
        let address = address::canonical(name);
        let units = address.encode_utf16().count() + 1;
        if units > MAX_PIPE_NAME_UTF16_UNITS {
            return Err(ProtectedEndpointError::AddressTooLong {
                units,
                maximum: MAX_PIPE_NAME_UTF16_UNITS,
            });
        }
        let server = sys::create_pipe(&address, capacity)?;
        Ok(Self {
            server,
            address: ProtectedEndpointAddress::from_bound(address),
            capacity,
        })
    }

    #[must_use]
    pub const fn address(&self) -> &ProtectedEndpointAddress {
        &self.address
    }

    /// Consumes the only listener and returns a stream only after exact PID
    /// verification. First-peer mismatch, cancellation and timeout revoke it.
    ///
    /// # Errors
    ///
    /// Any accept, deadline, cancellation or peer verification failure closes
    /// the pipe instance and makes this address unusable by this attempt.
    pub async fn accept(
        self,
        expected: ExpectedLocalPeer,
        deadline: Instant,
        cancellation: &mut EndpointCancellation,
    ) -> Result<VerifiedWindowsEndpointStream, ProtectedEndpointFailure<WindowsEndpointCleanup>>
    {
        if cancellation.is_cancelled() {
            return Err(ProtectedEndpointFailure::Clean(
                ProtectedEndpointError::Cancelled,
            ));
        }
        let Self {
            server,
            address,
            capacity,
        } = self;
        let connect_outcome = {
            let connect = server.connect();
            tokio::pin!(connect);
            tokio::select! {
                biased;
                () = sleep_until(deadline) => {
                    Err(ProtectedEndpointError::DeadlineElapsed)
                }
                () = cancellation.cancelled() => {
                    Err(ProtectedEndpointError::Cancelled)
                }
                connected = &mut connect => {
                    connected.map_err(|source| {
                        ProtectedEndpointError::io("ConnectNamedPipe", source)
                    })
                }
            }
        };
        if let Err(error) = connect_outcome {
            return fail_after_cleanup(
                WindowsEndpointCleanup::new(
                    server,
                    address,
                    capacity,
                    CleanupState::PendingConnect,
                ),
                error,
            )
            .await;
        }
        let actual = match sys::client_process_id(&server) {
            Ok(actual) => actual,
            Err(error) => {
                return fail_after_cleanup(
                    WindowsEndpointCleanup::new(server, address, capacity, CleanupState::Connected),
                    error,
                )
                .await;
            }
        };
        if actual != expected.process_id() {
            let error = ProtectedEndpointError::PeerMismatch {
                expected_process_id: expected.process_id(),
                actual_process_id: Some(actual),
            };
            return fail_after_cleanup(
                WindowsEndpointCleanup::new(server, address, capacity, CleanupState::Connected),
                error,
            )
            .await;
        }
        Ok(VerifiedWindowsEndpointStream::new(
            server,
            address,
            VerifiedLocalPeer::new(actual),
        ))
    }

    /// Explicit pre-transfer revocation with bounded name-release proof.
    ///
    /// # Errors
    ///
    /// Returns cleanup ownership when the operating system cannot prove that
    /// the canonical pipe name is available before the deadline.
    pub async fn revoke(
        self,
        deadline: Instant,
    ) -> Result<(), ProtectedEndpointFailure<WindowsEndpointCleanup>> {
        let Self {
            server,
            address,
            capacity,
        } = self;
        WindowsEndpointCleanup::new(server, address, capacity, CleanupState::PendingConnect)
            .reap(deadline)
            .await
    }

    /// Opens the already-provisioned local server as a one-shot client.
    ///
    /// # Errors
    ///
    /// Fails without retry; reconnect requires a new endpoint and connection ID.
    pub fn connect(
        address: &ProtectedEndpointAddress,
        expected: ExpectedLocalPeer,
    ) -> Result<WindowsEndpointClient, ProtectedEndpointError> {
        let client = ClientOptions::new()
            .open(address.as_str())
            .map_err(|source| ProtectedEndpointError::io("CreateFileW(named pipe)", source))?;
        let actual = sys::server_process_id(&client)?;
        if actual != expected.process_id() {
            return Err(ProtectedEndpointError::PeerMismatch {
                expected_process_id: expected.process_id(),
                actual_process_id: Some(actual),
            });
        }
        Ok(WindowsEndpointClient::new(
            client,
            address.clone(),
            VerifiedLocalPeer::new(actual),
        ))
    }
}

async fn fail_after_cleanup<T>(
    cleanup: WindowsEndpointCleanup,
    error: ProtectedEndpointError,
) -> Result<T, ProtectedEndpointFailure<WindowsEndpointCleanup>> {
    match cleanup.reap(Instant::now() + CONNECT_REAP_GRACE).await {
        Ok(()) => Err(ProtectedEndpointFailure::Clean(error)),
        Err(ProtectedEndpointFailure::Owned { owner, .. }) => {
            Err(ProtectedEndpointFailure::Owned { owner, error })
        }
        Err(ProtectedEndpointFailure::Clean(_)) => unreachable!("reap preserves ownership"),
    }
}

#[cfg(test)]
pub(super) fn current_logon_acl_sddl() -> Result<String, ProtectedEndpointError> {
    sys::current_logon_acl_sddl()
}
