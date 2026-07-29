//! Authenticated, path-free in-process bridge for the Rust session store.
//!
//! The bridge owns an opaque Rust capability and a bootstrap-only root
//! registry. Cross-language calls use only generated Protobuf messages.

mod bridge;
mod config;
mod convert;
mod error;
mod filesystem_extensions;
mod frame;
mod ports;

pub use bridge::AuthenticatedSessionStoreBridge;
pub use config::{BridgeInstanceId, SessionRootId, SessionStoreBridgeBootstrap};
pub use error::SessionStoreBridgeError;
pub use filesystem_extensions::FilesystemSessionStoreExtensionPort;
pub use ports::{
    RejectingSessionStoreExtensionPort, SessionStoreExtensionError, SessionStoreExtensionPort,
};
