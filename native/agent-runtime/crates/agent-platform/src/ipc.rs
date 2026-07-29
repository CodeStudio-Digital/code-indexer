//! Platform-neutral contracts for one-shot local IPC endpoints.
//!
//! Operating-system listeners remain in [`crate::windows`] and [`crate::unix`].
//! This module owns only bounded identifiers, cancellation and fail-closed
//! errors so `agent-platform` stays independent from the wire protocol.

mod cancel;
mod error;
mod model;

pub use cancel::{EndpointCancellation, EndpointCancellationHandle, endpoint_cancellation};
pub use error::ProtectedEndpointError;
pub use error::ProtectedEndpointFailure;
pub use model::{
    EndpointBufferCapacity, EndpointName, ExpectedLocalPeer, ProtectedEndpointAddress,
    VerifiedLocalPeer,
};
