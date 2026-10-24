//! Native, in-process Host owner for authenticated attempt endpoints.
//!
//! This crate binds a generated request to durable supervisor facts before it
//! opens any OS endpoint. JavaScript may supply expected facts, but only the OS
//! peer check on the live connection can produce an authenticated owner.

mod binding;
#[cfg(windows)]
pub mod command;
#[cfg(windows)]
pub mod duplex_process;
mod endpoint;
mod error;
mod owner;
mod platform;
mod request;
mod request_validation;
pub mod resource_bounds;
mod supervisor;

#[cfg(windows)]
pub use agent_platform::windows::filesystem_move::rename_path_no_replace;
pub use binding::DurableHostAttemptBinding;
#[cfg(windows)]
pub use endpoint::HostVerifiedStream;
pub use endpoint::{HostControlChannel, HostDataChannel, HostEndpointBinding, HostEndpointKind};
pub use error::HostBridgeError;
pub use owner::AuthenticatedHostAttemptChannels;
pub use request::HOST_BRIDGE_OPEN_MAX_BYTES;
pub use supervisor::{
    AuthenticatedHostSupervisorChannel, HostSupervisorBinding, HostSupervisorBridgeError,
    HostSupervisorVerifiedStream, SupervisorCloseEvidence, SupervisorProcessOwner,
};
